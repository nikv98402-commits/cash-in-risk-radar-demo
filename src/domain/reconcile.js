import { buildLedger } from "./ledger.js";

function sum(items, selector) {
  return items.reduce((total, item) => total + selector(item), 0);
}

function normalizedReference(payment) {
  return `${payment.bankReference ?? ""} ${payment.purpose ?? ""}`.toLocaleLowerCase("ru-RU");
}

function referenceHasId(reference, rawId) {
  const id = String(rawId).toLocaleLowerCase("ru-RU").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-zа-яё0-9_-])${id}($|[^a-zа-яё0-9_-])`, "iu").test(reference);
}

function paymentRemainder(payment, allocations) {
  return payment.amountMinor - sum(
    allocations.filter((allocation) => allocation.paymentId === payment.paymentId),
    (allocation) => allocation.amountMinor
  );
}

function payerKey(value) {
  return `${value.legalEntityId}|${value.currency}|${value.counterpartyId ?? value.payerId}`;
}

function targetKey(value) {
  return `${value.legalEntityId}|${value.receivableId}|${value.paymentScheduleId}`;
}

function sumBy(items, keyFor) {
  const result = new Map();
  items.forEach((item) => result.set(keyFor(item), (result.get(keyFor(item)) ?? 0) + item.amountMinor));
  return result;
}

function groupBy(items, keyFor) {
  const result = new Map();
  items.forEach((item) => {
    const key = keyFor(item);
    const bucket = result.get(key) ?? [];
    bucket.push(item);
    result.set(key, bucket);
  });
  return result;
}

function exactCandidates(payment, entriesByPayer, remainingByTarget) {
  const reference = normalizedReference(payment);
  return (entriesByPayer.get(payerKey(payment)) ?? []).map((entry) => ({
    ...entry,
    remainingAmountMinor: remainingByTarget.get(targetKey(entry.receivable)) ?? entry.remainingAmountMinor
  })).filter(({ receivable, remainingAmountMinor }) =>
    remainingAmountMinor > 0
    && receivable.status === "open"
    && receivable.legalEntityId === payment.legalEntityId
    && receivable.currency === payment.currency
    && receivable.counterpartyId === payment.payerId
    && referenceHasId(reference, receivable.receivableId)
  );
}

export function reconcileCanonicalData(input) {
  let ledger = buildLedger(input);
  const generatedAllocations = [];
  const proposedAllocations = [];
  const entriesByPayer = groupBy(ledger.entries, (entry) => payerKey(entry.receivable));
  const remainingByTarget = new Map(ledger.entries.map((entry) => [targetKey(entry.receivable), entry.remainingAmountMinor]));
  const allocatedByPayment = sumBy(ledger.allocations, (allocation) => allocation.paymentId);

  ledger.payments.forEach((payment) => {
    if (payment.bookingDate > ledger.asOfDate) return;
    const remainder = payment.amountMinor - (allocatedByPayment.get(payment.paymentId) ?? 0);
    if (remainder <= 0) return;
    const candidates = exactCandidates(payment, entriesByPayer, remainingByTarget);
    if (candidates.length === 1 && remainder <= candidates[0].remainingAmountMinor) {
      const target = candidates[0].receivable;
      generatedAllocations.push({
        allocationId: `AUTO-${payment.paymentId}-${target.receivableId}-${target.paymentScheduleId}`,
        paymentId: payment.paymentId,
        receivableId: target.receivableId,
        paymentScheduleId: target.paymentScheduleId,
        amountMinor: remainder,
        method: "exact",
        confidenceBps: 10_000,
        confirmed: true,
        _generated: true
      });
      allocatedByPayment.set(payment.paymentId, (allocatedByPayment.get(payment.paymentId) ?? 0) + remainder);
      remainingByTarget.set(targetKey(target), candidates[0].remainingAmountMinor - remainder);
      return;
    }
    candidates.forEach(({ receivable, remainingAmountMinor }, index) => {
      proposedAllocations.push({
        allocationId: `PROPOSED-${payment.paymentId}-${index + 1}`,
        paymentId: payment.paymentId,
        receivableId: receivable.receivableId,
        paymentScheduleId: receivable.paymentScheduleId,
        amountMinor: Math.min(remainder, remainingAmountMinor),
        method: "rule",
        confidenceBps: 5_000,
        confirmed: false
      });
    });
  });

  if (generatedAllocations.length) {
    ledger = buildLedger({ ...input, allocations: [...input.allocations, ...generatedAllocations] });
  }

  const finalAllocatedByPayment = sumBy(ledger.allocations, (allocation) => allocation.paymentId);
  const finalEntriesByPayer = groupBy(ledger.entries, (entry) => payerKey(entry.receivable));

  const unmatchedPayments = ledger.payments
    .filter((payment) => payment.bookingDate <= ledger.asOfDate)
    .map((payment) => {
      const unallocatedAmountMinor = payment.amountMinor - (finalAllocatedByPayment.get(payment.paymentId) ?? 0);
      if (unallocatedAmountMinor <= 0) return null;
      const payerEntries = finalEntriesByPayer.get(payerKey(payment)) ?? [];
      return {
        payment,
        unallocatedAmountMinor,
        reason: payerEntries.length && payerEntries.every((entry) => entry.remainingAmountMinor === 0)
          ? "overpayment"
          : "unmatched"
      };
    })
    .filter(Boolean);
  const pendingAllocations = ledger.allocations.filter((allocation) => !allocation.confirmed);

  return {
    ledger,
    generatedAllocations,
    proposedAllocations,
    pendingAllocations,
    unmatchedPayments,
    stats: {
      receivables: ledger.receivables.length,
      payments: ledger.payments.length,
      confirmedAllocations: ledger.allocations.filter((allocation) => allocation.confirmed).length,
      pendingAllocations: pendingAllocations.length + proposedAllocations.length,
      unmatchedPayments: unmatchedPayments.length,
      openAmountMinor: sum(ledger.entries, (entry) => entry.remainingAmountMinor)
    }
  };
}

export function projectLedgerToForecastReceipts(reconciliation) {
  const { ledger } = reconciliation;
  const historyByCounterparty = new Map();
  ledger.entries.forEach((entry) => {
    if (entry.completionDelayDays === null) return;
    const key = entry.receivable.counterpartyId;
    const history = historyByCounterparty.get(key) ?? [];
    history.push(entry.completionDelayDays);
    historyByCounterparty.set(key, history);
  });

  return ledger.entries
    .filter(({ receivable, remainingAmountMinor }) => receivable.status === "open" && remainingAmountMinor > 0)
    .map(({ receivable, remainingAmountMinor }) => {
      const historyDelays = historyByCounterparty.get(receivable.counterpartyId) ?? [];
      const portfolioDelays = [...historyByCounterparty.entries()]
        .filter(([counterpartyId]) => counterpartyId !== receivable.counterpartyId)
        .flatMap(([, delays]) => delays);
      const avgDelay = historyDelays.length ? sum(historyDelays, (delay) => delay) / historyDelays.length : null;
      return {
        id: receivable.receivableId,
        counterpartyId: receivable.counterpartyId,
        counterparty: receivable.counterpartyName,
        remainingAmountMinor,
        amountMinor: remainingAmountMinor,
        amount: remainingAmountMinor / 100,
        plannedDate: receivable.contractualDueDate,
        dueDays: 0,
        avgDelay,
        late5: historyDelays.length ? historyDelays.filter((delay) => delay >= 5).length / historyDelays.length : 0,
        late10: historyDelays.length ? historyDelays.filter((delay) => delay >= 10).length / historyDelays.length : 0,
        late30: historyDelays.length ? historyDelays.filter((delay) => delay >= 30).length / historyDelays.length : 0,
        openAr: remainingAmountMinor / 100,
        documentsOk: true,
        bankMatch: true,
        historyTotal: historyDelays.length,
        historyOnTime: historyDelays.filter((delay) => delay === 0).length,
        historyAvgDelay: avgDelay,
        historyWorstDelay: historyDelays.length ? Math.max(...historyDelays) : null,
        historyDelays,
        portfolioDelays
      };
    });
}

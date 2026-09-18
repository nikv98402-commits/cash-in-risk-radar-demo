import { parseDateOnly, toDateOnly } from "./date.js";
import { projectLedgerToForecastReceipts, reconcileCanonicalData } from "./reconcile.js";

export class DailyLedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = "DailyLedgerError";
  }
}

function dateOnly(value, field) {
  const date = value instanceof Date ? value : parseDateOnly(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new DailyLedgerError(`${field}: нужна ISO-дата.`);
  return toDateOnly(date);
}

function clean(record, dateFields = []) {
  const output = Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith("_")));
  dateFields.forEach((field) => { output[field] = dateOnly(output[field], field); });
  return output;
}

function outflowRecord(outflow, index) {
  const amountMinor = Number.isSafeInteger(outflow.amountMinor) ? outflow.amountMinor : Math.round(outflow.amount * 100);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new DailyLedgerError(`Исходящий платеж ${index + 1}: сумма должна быть в целых копейках.`);
  return {
    outflowId: outflow.outflowId ?? `outflow-${index + 1}`,
    category: outflow.category,
    amountMinor,
    effectiveDate: dateOnly(outflow.effectiveDate ?? outflow.date, "effectiveDate"),
    criticality: outflow.criticality ?? "must-pay"
  };
}

function bridgeBankBalance(bankBalances, outflows, asOfDate, bankClosingBalanceMinor) {
  if (!bankBalances.length) return null;
  const closeDates = [...new Set(bankBalances.map((item) => dateOnly(item.balanceDate, "balanceDate")))];
  if (closeDates.length !== 1) throw new DailyLedgerError("Для утреннего расчета все банковские счета должны иметь одну дату закрытия.");
  const sourceCloseDate = closeDates[0];
  const bridgeOutflows = outflows.filter((item) => item.criticality === "must-pay"
    && item.effectiveDate > sourceCloseDate && item.effectiveDate < asOfDate);
  const mandatoryOutflowsMinor = bridgeOutflows.reduce((sum, item) => sum + item.amountMinor, 0);
  return {
    sourceCloseDate,
    asOfDate,
    bankClosingBalanceMinor,
    mandatoryOutflowsMinor,
    projectedOpeningBalanceMinor: bankClosingBalanceMinor - mandatoryOutflowsMinor,
    outflowIds: bridgeOutflows.map((item) => item.outflowId)
  };
}

export function canonicalLedgerForRun({ reconciliation, outflows, bankBalances, balance, asOfDate }) {
  const ledger = reconciliation.ledger;
  const legalEntityIds = new Set(ledger.receivables.map((item) => item.legalEntityId));
  if (legalEntityIds.size !== 1) throw new DailyLedgerError("Ежедневный расчет требует ДЗ одного юрлица.");
  if (!Array.isArray(bankBalances)) throw new DailyLedgerError("Отсутствует список банковских остатков.");
  const bankClosingBalanceMinor = Math.round(balance.openingBalance * 100);
  if (!Number.isSafeInteger(bankClosingBalanceMinor)) throw new DailyLedgerError("Банковский остаток не помещается в целые копейки.");
  const normalizedAsOfDate = dateOnly(asOfDate, "asOfDate");
  const normalizedOutflows = outflows.map(outflowRecord);
  const bankBalanceBridge = bridgeBankBalance(bankBalances, normalizedOutflows, normalizedAsOfDate, bankClosingBalanceMinor);
  const openingBalanceMinor = bankBalanceBridge?.projectedOpeningBalanceMinor ?? bankClosingBalanceMinor;
  return {
    version: "1.0.0",
    legalEntityId: [...legalEntityIds][0],
    currency: "RUB",
    asOfDate: normalizedAsOfDate,
    openingBalanceMinor,
    receivables: ledger.receivables.map((item) => clean(item, ["contractualDueDate"])),
    payments: ledger.payments.map((item) => clean(item, ["bookingDate"])),
    allocations: ledger.allocations.map((item) => clean(item)),
    outflows: normalizedOutflows,
    bankBalances: bankBalances.map((item) => clean(item, ["balanceDate", "asOfDate"])),
    ...(bankBalanceBridge ? { bankBalanceBridge } : {})
  };
}

function hydrateBase(base) {
  if (!base || base.version !== "1.0.0" || !base.legalEntityId || base.currency !== "RUB"
    || !Array.isArray(base.receivables) || !Array.isArray(base.payments)
    || !Array.isArray(base.allocations) || !Array.isArray(base.outflows)
    || !Array.isArray(base.bankBalances) || !base.bankBalances.length) {
    throw new DailyLedgerError("В прошлом файле нет полного канонического ledger и банковских остатков.");
  }
  return {
    receivables: base.receivables.map((item) => ({ ...item, contractualDueDate: parseDateOnly(item.contractualDueDate) })),
    payments: base.payments.map((item) => ({ ...item, bookingDate: parseDateOnly(item.bookingDate) })),
    allocations: base.allocations.map((item) => ({ ...item })),
    outflows: base.outflows.map((item) => ({ ...item, effectiveDate: parseDateOnly(item.effectiveDate), amount: item.amountMinor / 100 }))
  };
}

function accountKey(item) {
  return JSON.stringify([item.bankId, item.legalEntityId, item.accountId, item.currency]);
}

export function applyBankUpdateToPriorLedger(base, update) {
  const previous = hydrateBase(base);
  if (update.kind !== "bank-update" || !update.bankBalances?.length) throw new DailyLedgerError("Нужна выгрузка Bank + BankBalances.");
  if (dateOnly(update.asOfDate, "asOfDate") <= base.asOfDate) throw new DailyLedgerError("Дата нового банковского расчета должна быть позже предыдущей.");
  const oldAccounts = new Set(base.bankBalances.map(accountKey));
  const newAccounts = new Set(update.bankBalances.map(accountKey));
  if (oldAccounts.size !== newAccounts.size || [...oldAccounts].some((key) => !newAccounts.has(key))) {
    throw new DailyLedgerError("Банковское обновление должно содержать закрытые остатки всех счетов прошлого расчета.");
  }
  if (update.bankBalances.some((item) => item.legalEntityId !== base.legalEntityId || item.currency !== base.currency)) {
    throw new DailyLedgerError("Юрлицо или валюта банковского обновления не совпадают с прошлым расчетом.");
  }
  const reconciled = reconcileCanonicalData({
    receivables: previous.receivables,
    payments: [...previous.payments, ...update.payments],
    allocations: [...previous.allocations, ...update.allocations],
    asOfDate: update.asOfDate
  });
  const receipts = projectLedgerToForecastReceipts(reconciled);
  const warnings = [
    ...update.report.warnings,
    ...reconciled.ledger.report.warnings,
    ...reconciled.unmatchedPayments.map(({ payment }) => `Bank ${payment.operationId ?? payment.paymentId}: поступление без подтвержденной ДЗ.`),
    ...reconciled.proposedAllocations.map((item) => `Bank ${item.paymentId}: распределение требует подтверждения.`)
  ];
  const canonicalLedger = canonicalLedgerForRun({
    reconciliation: reconciled,
    outflows: previous.outflows,
    bankBalances: update.bankBalances,
    balance: update.balance,
    asOfDate: update.asOfDate
  });
  return {
    kind: "canonical-daily",
    asOfDate: update.asOfDate,
    balance: { ...update.balance, openingBalance: canonicalLedger.openingBalanceMinor / 100 },
    bankFreshness: update.bankFreshness,
    receipts,
    outflows: previous.outflows,
    canonicalLedger,
    reconciliation: reconciled,
    report: {
      errors: [], warnings,
      reconciliation: {
        unmatchedPayments: reconciled.stats.unmatchedPayments,
        pendingAllocations: reconciled.stats.pendingAllocations,
        confirmedAllocations: reconciled.stats.confirmedAllocations
      },
      summary: `Ежедневный банк готов: ${reconciled.ledger.payments.length} операций, ${receipts.length} открытых ДЗ.`
    }
  };
}

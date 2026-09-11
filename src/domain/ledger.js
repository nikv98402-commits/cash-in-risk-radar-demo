import { daysBetween, toDateOnly } from "./date.js";

export class LedgerValidationError extends Error {
  constructor(report) {
    super("Канонический ledger не собран: исправьте ошибки сверки.");
    this.name = "LedgerValidationError";
    this.report = report;
  }
}

export function receivableKey(receivable) {
  const parts = [receivable.legalEntityId, receivable.counterpartyId, receivable.receivableId, receivable.paymentScheduleId];
  return parts.every(Boolean) ? parts.join("|") : "";
}

function allocationTargetsReceivable(allocation, receivable) {
  return allocation.receivableId === receivable.receivableId
    && allocation.paymentScheduleId === receivable.paymentScheduleId;
}

function allocationTargetKey(allocation) {
  return `${allocation.receivableId}|${allocation.paymentScheduleId}`;
}

function groupBy(items, keyFor) {
  const grouped = new Map();
  items.forEach((item) => {
    const key = keyFor(item);
    const bucket = grouped.get(key) ?? [];
    bucket.push(item);
    grouped.set(key, bucket);
  });
  return grouped;
}

function comparable(value) {
  if (value instanceof Date) return toDateOnly(value);
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !key.startsWith("_"))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, comparable(item)]));
  }
  return value;
}

function sameRecord(left, right) {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function deduplicate(records, identity, entityName, errors, warnings) {
  const accepted = [];
  const byIdentity = new Map();
  records.forEach((record, index) => {
    const id = identity(record);
    const row = record._sourceRow ? `, строка ${record._sourceRow}` : `, запись ${index + 1}`;
    if (!id) {
      errors.push(`${entityName}${row}: отсутствует идентификатор.`);
      return;
    }
    if (!byIdentity.has(id)) {
      byIdentity.set(id, record);
      accepted.push(record);
      return;
    }
    if (sameRecord(byIdentity.get(id), record)) {
      warnings.push(`${entityName}${row}: точный дубль ${id} помещен в карантин.`);
    } else {
      errors.push(`${entityName}${row}: конфликтующий дубль ${id}.`);
    }
  });
  return accepted;
}

function validMinorAmount(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isKnownDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function effectiveConfirmedAllocations(receivable, allocations, payments = null, asOfDate = null) {
  const paymentsById = payments ? new Map(payments.map((payment) => [payment.paymentId, payment])) : null;
  return allocations.filter((allocation) => {
    if (!allocation.confirmed || !allocationTargetsReceivable(allocation, receivable)) return false;
    if (!paymentsById) return true;
    const payment = paymentsById.get(allocation.paymentId);
    if (!payment || payment.legalEntityId !== receivable.legalEntityId) return false;
    return !asOfDate || payment.bookingDate <= asOfDate;
  });
}

export function confirmedAmountFor(receivable, allocations, options = {}) {
  return effectiveConfirmedAllocations(receivable, allocations, options.payments, options.asOfDate)
    .reduce((sum, item) => sum + item.amountMinor, 0);
}

export function remainingAmountFor(receivable, allocations, options = {}) {
  return receivable.originalAmountMinor - confirmedAmountFor(receivable, allocations, options);
}

export function deriveCompletedDelay(receivable, payments, allocations, asOfDate = null) {
  const paymentsById = new Map(payments.map((payment) => [payment.paymentId, payment]));
  const relevant = allocations
    .filter((item) => item.confirmed && allocationTargetsReceivable(item, receivable))
    .map((allocation) => ({ ...allocation, payment: paymentsById.get(allocation.paymentId) }))
    .filter((item) => item.payment && (!asOfDate || item.payment.bookingDate <= asOfDate))
    .sort((left, right) => left.payment.bookingDate - right.payment.bookingDate);

  let allocated = 0;
  for (const item of relevant) {
    allocated += item.amountMinor;
    if (allocated >= receivable.originalAmountMinor) {
      return Math.max(0, daysBetween(item.payment.bookingDate, receivable.contractualDueDate));
    }
  }
  return null;
}

export function buildLedger({ receivables = [], payments = [], allocations = [], asOfDate }) {
  const errors = [];
  const warnings = [];
  if (!isKnownDate(asOfDate)) errors.push("Ledger: asOfDate отсутствует или некорректна.");

  const acceptedReceivables = deduplicate(receivables, receivableKey, "Receivables", errors, warnings);
  const acceptedPayments = deduplicate(payments, (payment) => payment.paymentId, "Bank", errors, warnings);
  const acceptedAllocations = deduplicate(allocations, (allocation) => allocation.allocationId, "Allocations", errors, warnings);
  const receivablesByTarget = new Map(acceptedReceivables.map((item) => [`${item.legalEntityId}|${item.receivableId}|${item.paymentScheduleId}`, item]));
  const paymentsById = new Map(acceptedPayments.map((item) => [item.paymentId, item]));
  const allocationsByPayment = groupBy(acceptedAllocations, (item) => item.paymentId);
  const allocationsByTarget = groupBy(acceptedAllocations, allocationTargetKey);

  acceptedReceivables.forEach((receivable) => {
    if (!validMinorAmount(receivable.originalAmountMinor)) errors.push(`Receivables ${receivable.receivableId}: originalAmountMinor должен быть положительным целым числом.`);
    if (receivable.currency !== "RUB") errors.push(`Receivables ${receivable.receivableId}: валюта ${receivable.currency} не поддерживается текущим RUB-календарем.`);
    if (!isKnownDate(receivable.contractualDueDate)) errors.push(`Receivables ${receivable.receivableId}: некорректная contractualDueDate.`);
    if (!["open", "paid", "disputed", "defaulted"].includes(receivable.status)) errors.push(`Receivables ${receivable.receivableId}: неизвестный status ${receivable.status}.`);
  });

  acceptedPayments.forEach((payment) => {
    if (!validMinorAmount(payment.amountMinor)) errors.push(`Bank ${payment.paymentId}: amountMinor должен быть положительным целым числом.`);
    if (payment.currency !== "RUB") errors.push(`Bank ${payment.paymentId}: валюта ${payment.currency} не поддерживается текущим RUB-календарем.`);
    if (!isKnownDate(payment.bookingDate)) errors.push(`Bank ${payment.paymentId}: некорректная bookingDate.`);
    if (isKnownDate(asOfDate) && payment.bookingDate > asOfDate) warnings.push(`Bank ${payment.paymentId}: платеж после даты аудита ${toDateOnly(asOfDate)} не уменьшает текущую ДЗ.`);
  });

  acceptedAllocations.forEach((allocation) => {
    const payment = paymentsById.get(allocation.paymentId);
    const receivable = payment
      ? receivablesByTarget.get(`${payment.legalEntityId}|${allocation.receivableId}|${allocation.paymentScheduleId}`)
      : null;
    if (!validMinorAmount(allocation.amountMinor)) errors.push(`Allocations ${allocation.allocationId}: amountMinor должен быть положительным целым числом.`);
    if (!payment) errors.push(`Allocations ${allocation.allocationId}: неизвестный paymentId ${allocation.paymentId}.`);
    if (!receivable) errors.push(`Allocations ${allocation.allocationId}: неизвестная задолженность ${allocation.receivableId}/${allocation.paymentScheduleId}.`);
    if (payment && receivable) {
      if (payment.legalEntityId !== receivable.legalEntityId) errors.push(`Allocations ${allocation.allocationId}: юрлица платежа и ДЗ не совпадают.`);
      if (payment.currency !== receivable.currency) errors.push(`Allocations ${allocation.allocationId}: валюты платежа и ДЗ не совпадают.`);
    }
    if (!["exact", "rule", "manual"].includes(allocation.method)) errors.push(`Allocations ${allocation.allocationId}: неизвестный method ${allocation.method}.`);
    if (!Number.isInteger(allocation.confidenceBps) || allocation.confidenceBps < 0 || allocation.confidenceBps > 10_000) errors.push(`Allocations ${allocation.allocationId}: confidenceBps должен быть от 0 до 10000.`);
  });

  acceptedPayments.forEach((payment) => {
    const allocated = (allocationsByPayment.get(payment.paymentId) ?? []).reduce((sum, allocation) => sum + allocation.amountMinor, 0);
    if (allocated > payment.amountMinor) errors.push(`Bank ${payment.paymentId}: распределено ${allocated}, больше суммы платежа ${payment.amountMinor}.`);
  });
  acceptedReceivables.forEach((receivable) => {
    const confirmed = (allocationsByTarget.get(allocationTargetKey(receivable)) ?? [])
      .filter((allocation) => allocation.confirmed)
      .reduce((sum, allocation) => sum + allocation.amountMinor, 0);
    if (confirmed > receivable.originalAmountMinor) errors.push(`Receivables ${receivable.receivableId}: подтверждено ${confirmed}, больше суммы ДЗ ${receivable.originalAmountMinor}.`);
  });

  const report = { errors, warnings };
  if (errors.length) throw new LedgerValidationError(report);

  const entries = acceptedReceivables.map((receivable) => {
    const targetAllocations = allocationsByTarget.get(allocationTargetKey(receivable)) ?? [];
    const effective = targetAllocations.filter((allocation) => {
      if (!allocation.confirmed) return false;
      const payment = paymentsById.get(allocation.paymentId);
      return payment?.legalEntityId === receivable.legalEntityId && (!asOfDate || payment.bookingDate <= asOfDate);
    });
    const confirmedAmountMinor = effective.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
    const completionAllocations = effective
      .map((allocation) => ({ allocation, payment: paymentsById.get(allocation.paymentId) }))
      .sort((left, right) => left.payment.bookingDate - right.payment.bookingDate);
    let allocatedMinor = 0;
    let completionDelayDays = null;
    for (const { allocation, payment } of completionAllocations) {
      allocatedMinor += allocation.amountMinor;
      if (allocatedMinor >= receivable.originalAmountMinor) {
        completionDelayDays = Math.max(0, daysBetween(payment.bookingDate, receivable.contractualDueDate));
        break;
      }
    }
    return {
      receivable,
      confirmedAmountMinor,
      remainingAmountMinor: receivable.originalAmountMinor - confirmedAmountMinor,
      completionDelayDays
    };
  });
  return { asOfDate, receivables: acceptedReceivables, payments: acceptedPayments, allocations: acceptedAllocations, entries, report };
}

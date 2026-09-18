import { toDateOnly } from "./date.js";

export class BankSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = "BankSourceError";
  }
}

export function scopedBankPaymentId({ bankId, legalEntityId, accountId, operationId }) {
  const parts = [bankId, legalEntityId, accountId, operationId].map((part) => String(part ?? "").trim());
  if (parts.some((part) => !part)) throw new BankSourceError("Для банковской операции нужны банк, юрлицо, счет и ID операции.");
  return `BANK:${JSON.stringify(parts)}`;
}

export function scopeBankPayments(payments, allocations) {
  const byRawId = new Map();
  const scopedPayments = payments.map((payment) => {
    const hasBank = Boolean(payment.bankId || payment.accountId);
    if (hasBank && (!payment.bankId || !payment.accountId)) {
      throw new BankSourceError(`Bank ${payment.paymentId}: банк и счет должны быть указаны вместе.`);
    }
    if (payment.bankStatus && payment.bankStatus !== "booked") {
      throw new BankSourceError(`Bank ${payment.paymentId}: непроведенная операция не может быть банковским фактом.`);
    }
    const rawId = String(payment.paymentId);
    const internalId = hasBank ? scopedBankPaymentId({
      bankId: payment.bankId,
      legalEntityId: payment.legalEntityId,
      accountId: payment.accountId,
      operationId: rawId
    }) : rawId;
    const bucket = byRawId.get(rawId) ?? new Set();
    bucket.add(internalId);
    byRawId.set(rawId, bucket);
    return { ...payment, paymentId: internalId, operationId: rawId };
  });

  const scopedAllocations = allocations.map((allocation) => {
    const rawId = String(allocation.paymentId);
    const candidates = byRawId.get(rawId) ?? new Set();
    if (allocation.bankId || allocation.accountId || allocation.legalEntityId) {
      if (!allocation.bankId || !allocation.accountId || !allocation.legalEntityId) {
        throw new BankSourceError(`Allocations ${allocation.allocationId}: для банковской операции укажите банк, юрлицо и счет.`);
      }
      const paymentId = scopedBankPaymentId({
        bankId: allocation.bankId,
        legalEntityId: allocation.legalEntityId,
        accountId: allocation.accountId,
        operationId: rawId
      });
      if (!candidates.has(paymentId)) throw new BankSourceError(`Allocations ${allocation.allocationId}: операция ${rawId} не найдена на указанном счете.`);
      return { ...allocation, paymentId };
    }
    if (candidates.size > 1) throw new BankSourceError(`Allocations ${allocation.allocationId}: ID операции ${rawId} есть на нескольких счетах; укажите банк, юрлицо и счет.`);
    return { ...allocation, paymentId: candidates.size ? [...candidates][0] : rawId };
  });
  return { payments: scopedPayments, allocations: scopedAllocations };
}

export function bankOpeningFromPriorClose(balances, payments = []) {
  if (!balances.length) throw new BankSourceError("Лист BankBalances не содержит закрытых остатков.");
  const first = balances[0];
  const seen = new Set();
  let openingBalanceMinor = 0;
  balances.forEach((balance) => {
    if (!balance.bankId || !balance.legalEntityId || !balance.accountId
      || !(balance.balanceDate instanceof Date) || Number.isNaN(balance.balanceDate.getTime())
      || !(balance.asOfDate instanceof Date) || Number.isNaN(balance.asOfDate.getTime())
      || Number.isNaN(Date.parse(balance.observedAt))) {
      throw new BankSourceError("BankBalances: отсутствует счет, дата закрытия, дата расчета или корректное время получения.");
    }
    if (balance.legalEntityId !== first.legalEntityId || balance.currency !== "RUB"
      || toDateOnly(balance.balanceDate) !== toDateOnly(first.balanceDate)
      || toDateOnly(balance.asOfDate) !== toDateOnly(first.asOfDate)) {
      throw new BankSourceError("BankBalances: все счета должны принадлежать одному юрлицу, иметь валюту RUB, одну дату закрытия и расчета.");
    }
    if (balance.asOfDate <= balance.balanceDate) throw new BankSourceError("BankBalances: дата утреннего расчета должна быть позже закрытого остатка.");
    const accountKey = JSON.stringify([balance.bankId, balance.legalEntityId, balance.accountId]);
    if (seen.has(accountKey)) throw new BankSourceError(`BankBalances: счет ${balance.accountId} повторяется.`);
    seen.add(accountKey);
    if (!Number.isSafeInteger(balance.closingBalanceMinor)) throw new BankSourceError(`BankBalances: остаток счета ${balance.accountId} должен быть в целых копейках.`);
    openingBalanceMinor += balance.closingBalanceMinor;
    if (!Number.isSafeInteger(openingBalanceMinor)) throw new BankSourceError("BankBalances: суммарный остаток выходит за допустимый диапазон.");
  });
  const closeDate = toDateOnly(first.balanceDate);
  payments.forEach((payment) => {
    const accountKey = JSON.stringify([payment.bankId, payment.legalEntityId, payment.accountId]);
    if (!seen.has(accountKey)) {
      throw new BankSourceError(`Bank ${payment.operationId ?? payment.paymentId}: для счета ${payment.accountId ?? "не указан"} нет закрытого остатка.`);
    }
    if (payment.bookingDate > first.balanceDate) {
      throw new BankSourceError(`Bank ${payment.operationId ?? payment.paymentId}: дата операции позже закрытого остатка ${closeDate}; загрузите остаток за более поздний день.`);
    }
  });
  return {
    asOfDate: first.asOfDate,
    openingBalanceMinor,
    sourceCloseDate: closeDate,
    observedAt: balances.map((balance) => balance.observedAt).sort().at(-1),
    accountCount: balances.length
  };
}

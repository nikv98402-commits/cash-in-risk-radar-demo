import { addDays, daysBetween, toDateOnly } from "./date.js";
import { scenarioCashDate } from "./forecast.js";

const TYPE_ORDER = new Map([
  ["reserve", 1],
  ["payment-move", 2],
  ["factoring", 3],
  ["overdraft", 4],
  ["credit-line", 5]
]);

export class FundingValidationError extends Error {
  constructor(message, code = "INVALID_FUNDING_INPUT") {
    super(message);
    this.name = "FundingValidationError";
    this.code = code;
  }
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function validMinor(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function addAdjustment(adjustments, date, amountMinor) {
  const key = toDateOnly(date);
  adjustments.set(key, (adjustments.get(key) ?? 0) + amountMinor);
}

function maxDate(left, right) {
  return left > right ? left : right;
}

function sourceReadyDate(source, asOfDate) {
  return maxDate(source.availabilityDate, addDays(asOfDate, source.leadTimeDays));
}

function missingFields(source) {
  const common = ["availabilityDate", "leadTimeDays", "priority", "inputSource"];
  const byType = {
    reserve: ["limitMinor", "termDays", "annualRateBps", "minDrawMinor"],
    "payment-move": ["maxMoveDays", "fixedCostMinor"],
    factoring: ["limitMinor", "termDays", "feeBps", "minDrawMinor"],
    overdraft: ["limitMinor", "termDays", "annualRateBps", "minDrawMinor"],
    "credit-line": ["limitMinor", "termDays", "annualRateBps", "minDrawMinor"]
  };
  return [...common, ...(byType[source.type] ?? [])].filter((field) => {
    const value = source[field];
    if (field === "availabilityDate") return !validDate(value);
    if (field === "inputSource") return !String(value ?? "").trim();
    return value === null || value === undefined || value === "" || !Number.isFinite(Number(value));
  });
}

function requireForecast(forecast) {
  if (!Array.isArray(forecast) || !forecast.length) {
    throw new FundingValidationError("forecast должен содержать хотя бы один день.");
  }
  forecast.forEach((day, index) => {
    if (!validDate(day.date) || !Number.isSafeInteger(day.openingBalanceMinor)
      || !validMinor(day.scenarioInflowMinor) || !validMinor(day.outflowMinor)
      || !Number.isSafeInteger(day.closingBalanceMinor)) {
      throw new FundingValidationError(`forecast[${index}] не содержит корректные minor-unit поля.`);
    }
  });
}

function rowsWithAdjustments(forecast, adjustments) {
  let balance = forecast[0].openingBalanceMinor;
  return forecast.map((day) => {
    const adjustmentMinor = adjustments.get(day.dateIso ?? toDateOnly(day.date)) ?? 0;
    const openingBalanceMinor = balance;
    balance = openingBalanceMinor + day.scenarioInflowMinor - day.outflowMinor + adjustmentMinor;
    return {
      ...day,
      openingBalanceMinor,
      adjustmentMinor,
      adjustedClosingBalanceMinor: balance,
      uncoveredNeedMinor: Math.max(0, -balance)
    };
  });
}

function gapSummary(rows) {
  const gapRows = rows.filter((day) => day.adjustedClosingBalanceMinor < 0);
  const minimum = Math.min(...rows.map((day) => day.adjustedClosingBalanceMinor));
  return {
    first: gapRows[0] ?? null,
    maximumNeedMinor: Math.max(0, -minimum),
    affectedDates: gapRows.map((day) => day.dateIso ?? toDateOnly(day.date)),
    forecastEndDate: rows.at(-1).date
  };
}

function clampDraw(needMinor, source) {
  const available = source.limitMinor - (source.usedLimitMinor ?? 0);
  if (available <= 0) return 0;
  const desired = Math.max(needMinor, source.minDrawMinor);
  return Math.min(available, desired);
}

export function annualInterestCost(amountMinor, annualRateBps, usageDays) {
  if (!validMinor(amountMinor) || !Number.isInteger(annualRateBps) || annualRateBps < 0
    || !Number.isInteger(usageDays) || usageDays < 0) {
    throw new FundingValidationError("Некорректные параметры годовой стоимости.");
  }
  return Math.round(amountMinor * annualRateBps / 10_000 * usageDays / 365);
}

export function fixedFeeCost(amountMinor, feeBps) {
  if (!validMinor(amountMinor) || !Number.isInteger(feeBps) || feeBps < 0) {
    throw new FundingValidationError("Некорректные параметры фиксированной комиссии.");
  }
  return Math.round(amountMinor * feeBps / 10_000);
}

function actionTemplate(source, status, reason, gap, extra = {}) {
  const usedLimitMinor = source.usedLimitMinor ?? 0;
  const limitMinor = validMinor(source.limitMinor) ? source.limitMinor : 0;
  return {
    sourceId: source.id,
    type: source.type,
    name: source.name,
    status,
    reason,
    appliedAmountMinor: 0,
    effectiveDate: null,
    effectiveDateIso: null,
    termDays: source.termDays ?? null,
    costMinor: null,
    costFormula: null,
    limitMinor,
    usedLimitMinor,
    remainingLimitMinor: Math.max(0, limitMinor - usedLimitMinor),
    constraints: source.constraints ?? [],
    inputSource: source.inputSource ?? null,
    remainingGapMinor: gap.maximumNeedMinor,
    affectedDates: gap.affectedDates,
    ...extra
  };
}

function applyCashSource(source, gap, asOfDate, adjustments) {
  const readyDate = sourceReadyDate(source, asOfDate);
  if (readyDate > gap.first.date) {
    return actionTemplate(source, "unavailable", "Источник доступен после первой даты разрыва.", gap, {
      effectiveDate: readyDate,
      effectiveDateIso: toDateOnly(readyDate)
    });
  }
  const amountMinor = clampDraw(gap.maximumNeedMinor, source);
  if (amountMinor <= 0) return actionTemplate(source, "unavailable", "Доступный лимит исчерпан.", gap);
  if (amountMinor < source.minDrawMinor) {
    return actionTemplate(source, "unavailable", "Остаток лимита меньше минимальной суммы использования.", gap);
  }
  addAdjustment(adjustments, gap.first.date, amountMinor);
  const repaymentDate = source.type === "overdraft" || source.type === "credit-line"
    ? addDays(gap.first.date, source.termDays)
    : null;
  if (repaymentDate && repaymentDate <= gap.forecastEndDate) {
    addAdjustment(adjustments, repaymentDate, -amountMinor);
  }
  source.usedLimitMinor = (source.usedLimitMinor ?? 0) + amountMinor;
  const costMinor = annualInterestCost(amountMinor, source.annualRateBps, source.termDays);
  return actionTemplate(source, "applied", "Источник применен на первой дате разрыва.", gap, {
    appliedAmountMinor: amountMinor,
    effectiveDate: gap.first.date,
    effectiveDateIso: toDateOnly(gap.first.date),
    repaymentDate,
    repaymentDateIso: repaymentDate ? toDateOnly(repaymentDate) : null,
    costMinor,
    costFormula: `ROUND(${amountMinor} × ${source.annualRateBps} / 10000 × ${source.termDays} / 365)`,
    usedLimitMinor: source.usedLimitMinor,
    remainingLimitMinor: source.limitMinor - source.usedLimitMinor
  });
}

function applyPaymentMove(source, gap, asOfDate, outflows, movedOutflowIds, adjustments, forecast) {
  const readyDate = sourceReadyDate(source, asOfDate);
  const candidate = outflows
    .filter((item) => item.criticality === "moveable" && !movedOutflowIds.has(item.outflowId ?? item.category))
    .map((item) => ({
      ...item,
      sourceDate: item.effectiveDate ?? item.date,
      amountMinor: item.amountMinor ?? Math.round(Number(item.amount) * 100)
    }))
    .filter((item) => validDate(item.sourceDate) && validMinor(item.amountMinor)
      && item.sourceDate <= gap.first.date && readyDate <= item.sourceDate)
    .sort((left, right) => right.amountMinor - left.amountMinor)[0];
  if (!candidate) {
    return actionTemplate(source, "ineligible", "Нет некритичного платежа, который можно перенести до даты разрыва.", gap);
  }
  const targetDate = addDays(candidate.sourceDate, source.maxMoveDays);
  if (targetDate <= candidate.sourceDate) {
    return actionTemplate(source, "ineligible", "Допустимое окно переноса не сдвигает платеж.", gap);
  }
  addAdjustment(adjustments, candidate.sourceDate, candidate.amountMinor);
  if (targetDate <= forecast.at(-1).date) addAdjustment(adjustments, targetDate, -candidate.amountMinor);
  movedOutflowIds.add(candidate.outflowId ?? candidate.category);
  return actionTemplate(source, "applied", "Некритичный платеж перенесен в пределах разрешенного окна.", gap, {
    targetId: candidate.outflowId ?? candidate.category,
    appliedAmountMinor: candidate.amountMinor,
    effectiveDate: candidate.sourceDate,
    effectiveDateIso: toDateOnly(candidate.sourceDate),
    movedToDate: targetDate,
    movedToDateIso: toDateOnly(targetDate),
    termDays: source.maxMoveDays,
    costMinor: source.fixedCostMinor,
    costFormula: `fixedCostMinor = ${source.fixedCostMinor}`
  });
}

function receiptMinor(receipt) {
  if (validMinor(receipt.remainingAmountMinor)) return receipt.remainingAmountMinor;
  if (validMinor(receipt.amountMinor)) return receipt.amountMinor;
  const converted = Math.round(Number(receipt.amount) * 100);
  return validMinor(converted) ? converted : 0;
}

function applyFactoring(source, gap, asOfDate, receipts, factoredIds, adjustments, forecast, scenario) {
  const readyDate = sourceReadyDate(source, asOfDate);
  if (readyDate > gap.first.date) {
    return actionTemplate(source, "unavailable", "Факторинг будет доступен после первой даты разрыва.", gap, {
      effectiveDate: readyDate,
      effectiveDateIso: toDateOnly(readyDate)
    });
  }
  const candidates = receipts
    .filter((item) => item.documentsOk && item.bankMatch && !factoredIds.has(item.id))
    .map((item) => ({ ...item, cashDate: scenarioCashDate(item, scenario), amountMinor: receiptMinor(item) }))
    .filter((item) => item.amountMinor > 0 && item.cashDate > gap.first.date)
    .sort((left, right) => right.amountMinor - left.amountMinor || String(left.id).localeCompare(String(right.id)));
  if (!candidates.length) {
    return actionTemplate(source, "ineligible", "Нет открытой ДЗ с подтвержденными документами и банковским матчингом.", gap);
  }
  const availableReceivablesMinor = candidates.reduce((sum, item) => sum + item.amountMinor, 0);
  const amountMinor = Math.min(clampDraw(gap.maximumNeedMinor, source), availableReceivablesMinor);
  if (amountMinor < source.minDrawMinor || amountMinor <= 0) {
    return actionTemplate(source, "unavailable", "Лимит или доступная ДЗ меньше минимальной суммы факторинга.", gap);
  }
  addAdjustment(adjustments, gap.first.date, amountMinor);
  let remainingMinor = amountMinor;
  const targets = [];
  candidates.forEach((candidate) => {
    if (remainingMinor <= 0) return;
    const appliedMinor = Math.min(remainingMinor, candidate.amountMinor);
    if (candidate.cashDate <= forecast.at(-1).date) addAdjustment(adjustments, candidate.cashDate, -appliedMinor);
    factoredIds.add(candidate.id);
    targets.push({ id: candidate.id, amountMinor: appliedMinor, cashDateIso: toDateOnly(candidate.cashDate) });
    remainingMinor -= appliedMinor;
  });
  source.usedLimitMinor = (source.usedLimitMinor ?? 0) + amountMinor;
  const costMinor = fixedFeeCost(amountMinor, source.feeBps);
  return actionTemplate(source, "applied", "Подходящая ДЗ профинансирована без повторного учета будущего cash-in.", gap, {
    targetId: targets.length === 1 ? targets[0].id : null,
    targetIds: targets.map((item) => item.id),
    targets,
    appliedAmountMinor: amountMinor,
    effectiveDate: gap.first.date,
    effectiveDateIso: toDateOnly(gap.first.date),
    receivableCashDate: targets.length === 1 ? candidates[0].cashDate : null,
    receivableCashDateIso: targets.length === 1 ? targets[0].cashDateIso : null,
    costMinor,
    costFormula: `ROUND(${amountMinor} × ${source.feeBps} / 10000)`,
    usedLimitMinor: source.usedLimitMinor,
    remainingLimitMinor: source.limitMinor - source.usedLimitMinor
  });
}

export function simulateFundingCoverage({
  forecast,
  receipts = [],
  outflows = [],
  sources = [],
  asOfDate,
  scenario = forecast?.report?.scenario ?? "p50"
}) {
  requireForecast(forecast);
  if (!validDate(asOfDate)) throw new FundingValidationError("asOfDate отсутствует или некорректна.");
  const adjustments = new Map();
  const movedOutflowIds = new Set();
  const factoredIds = new Set();
  const normalizedSources = sources.map((source, index) => ({
    ...source,
    id: source.id ?? `${source.type}-${index + 1}`,
    name: source.name ?? source.type,
    usedLimitMinor: 0
  })).sort((left, right) => {
    const typeOrder = (TYPE_ORDER.get(left.type) ?? 99) - (TYPE_ORDER.get(right.type) ?? 99);
    return typeOrder || Number(left.priority ?? 999) - Number(right.priority ?? 999);
  });
  const actions = [];

  normalizedSources.forEach((source) => {
    let rows = rowsWithAdjustments(forecast, adjustments);
    const gap = gapSummary(rows);
    if (!TYPE_ORDER.has(source.type)) {
      throw new FundingValidationError(`Неизвестный тип источника ${source.type}.`, "INVALID_SOURCE_TYPE");
    }
    if (!gap.first) {
      actions.push(actionTemplate(source, "unavailable", "Кассовый разрыв отсутствует.", gap));
      return;
    }
    if (source.type !== "payment-move" && (!validMinor(source.limitMinor) || source.limitMinor === 0)) {
      actions.push(actionTemplate(source, "unavailable", "Нулевой лимит: источник отсутствует.", gap));
      return;
    }
    const missing = missingFields(source);
    if (missing.length) {
      actions.push(actionTemplate(source, "incomplete", `Не заполнены условия: ${missing.join(", ")}.`, gap, {
        missingFields: missing
      }));
      return;
    }
    if (!Number.isInteger(source.leadTimeDays) || source.leadTimeDays < 0
      || !Number.isInteger(source.priority) || source.priority < 1) {
      throw new FundingValidationError(`Источник ${source.id}: leadTimeDays и priority должны быть положительными целыми параметрами.`);
    }

    let action;
    if (source.type === "payment-move") {
      action = applyPaymentMove(source, gap, asOfDate, outflows, movedOutflowIds, adjustments, forecast);
    } else if (source.type === "factoring") {
      action = applyFactoring(source, gap, asOfDate, receipts, factoredIds, adjustments, forecast, scenario);
    } else {
      action = applyCashSource(source, gap, asOfDate, adjustments);
    }
    rows = rowsWithAdjustments(forecast, adjustments);
    const remaining = gapSummary(rows);
    action.remainingGapMinor = remaining.maximumNeedMinor;
    action.affectedDates = remaining.affectedDates;
    actions.push(action);
  });

  const adjustedForecast = rowsWithAdjustments(forecast, adjustments);
  const finalGap = gapSummary(adjustedForecast);
  return {
    actions,
    adjustedForecast,
    totalCostMinor: actions.reduce((sum, action) => sum + (action.costMinor ?? 0), 0),
    uncoveredNeedMinor: finalGap.maximumNeedMinor,
    affectedDates: finalGap.affectedDates,
    fullyCovered: finalGap.maximumNeedMinor === 0,
    movedOutflowIds: [...movedOutflowIds],
    factoredReceivableIds: [...factoredIds]
  };
}

import {
  DEFAULT_MAX_HORIZON_DAYS,
  addDays,
  daysBetween,
  toDateOnly
} from "./date.js";

const DEFAULT_HORIZON_DAYS = 30;
const SCENARIOS = ["p50", "p80", "p90", "stress"];

export class ForecastValidationError extends Error {
  constructor(message, code = "INVALID_FORECAST_INPUT") {
    super(message);
    this.name = "ForecastValidationError";
    this.code = code;
  }
}

function requireDate(value, fieldName) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ForecastValidationError(`${fieldName}: ожидается корректная календарная дата.`);
  }
  return value;
}

function requireMinor(value, fieldName, { allowZero = true } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new ForecastValidationError(`${fieldName}: ожидается ${allowZero ? "неотрицательная" : "положительная"} сумма в целых минимальных денежных единицах.`);
  }
  return value;
}

function majorToMinor(value, fieldName) {
  const numeric = Number(value);
  const scaled = numeric * 100;
  const rounded = Math.round(scaled);
  if (!Number.isFinite(numeric) || numeric < 0 || !Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-6) {
    throw new ForecastValidationError(`${fieldName}: сумма должна содержать не более двух знаков после запятой.`);
  }
  return rounded;
}

function receiptAmountMinor(receipt, index) {
  if (Object.hasOwn(receipt, "remainingAmountMinor")) {
    return requireMinor(receipt.remainingAmountMinor, `receipts[${index}].remainingAmountMinor`);
  }
  if (Object.hasOwn(receipt, "openAmountMinor")) {
    return requireMinor(receipt.openAmountMinor, `receipts[${index}].openAmountMinor`);
  }
  if (Object.hasOwn(receipt, "amountMinor")) {
    return requireMinor(receipt.amountMinor, `receipts[${index}].amountMinor`);
  }
  return majorToMinor(receipt.amount, `receipts[${index}].amount`);
}

function outflowAmountMinor(outflow, index) {
  if (Object.hasOwn(outflow, "amountMinor")) {
    return requireMinor(outflow.amountMinor, `outflows[${index}].amountMinor`, { allowZero: false });
  }
  return majorToMinor(outflow.amount, `outflows[${index}].amount`);
}

function openingAmountMinor(input) {
  if (Object.hasOwn(input, "openingBalanceMinor")) {
    return requireMinor(input.openingBalanceMinor, "openingBalanceMinor");
  }
  return majorToMinor(input.openingBalance, "openingBalance");
}

function addToDateMap(map, date, amountMinor) {
  const key = toDateOnly(date);
  map.set(key, (map.get(key) ?? 0) + amountMinor);
}

function datePosition(date, startDate, horizonDays) {
  const offset = daysBetween(date, startDate);
  if (offset < 0) return "before";
  if (offset > horizonDays) return "after";
  return "inside";
}

function exclusion(type, item, reason, amountMinor, date = null) {
  return {
    type,
    id: item.id ?? item.receivableId ?? item.outflowId ?? item.paymentId ?? null,
    reason,
    amountMinor,
    date,
    dateIso: date ? toDateOnly(date) : null
  };
}

export function scenarioCashDate(receipt, scenario) {
  if (!SCENARIOS.includes(scenario)) {
    throw new ForecastValidationError(`Неизвестный сценарий ${scenario}.`, "INVALID_SCENARIO");
  }
  const explicitDate = receipt[`${scenario}Date`];
  if (explicitDate !== undefined && explicitDate !== null) {
    return requireDate(explicitDate, `${scenario}Date`);
  }
  const delay = receipt.scenarioDelays?.[scenario] ?? receipt.expectedDelay;
  if (delay === null || delay === undefined) return null;
  if (!Number.isInteger(delay) || delay < 0 || delay > DEFAULT_MAX_HORIZON_DAYS) {
    throw new ForecastValidationError(`${scenario}Delay: ожидается целое число от 0 до ${DEFAULT_MAX_HORIZON_DAYS}.`);
  }
  return addDays(requireDate(receipt.plannedDate, "plannedDate"), delay);
}

export function expectedForDay(scored, date, scenario) {
  const target = requireDate(date, "date");
  return scored.reduce((sum, receipt, index) => {
    const cashDate = scenarioCashDate(receipt, scenario);
    if (!cashDate || daysBetween(cashDate, target) !== 0) return sum;
    return sum + (Object.hasOwn(receipt, "remainingAmountMinor")
      ? receiptAmountMinor(receipt, index)
      : Number(receipt.amount ?? 0));
  }, 0);
}

export function buildForecastResult(input) {
  const scored = input.scored ?? [];
  const outflows = input.outflows ?? [];
  const scenario = input.scenario ?? "p50";
  if (!SCENARIOS.includes(scenario)) {
    throw new ForecastValidationError(`Неизвестный сценарий ${scenario}.`, "INVALID_SCENARIO");
  }
  const startDate = requireDate(input.asOfDate ?? input.forecastStartDate, "forecastStartDate");
  const horizonDays = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  if (!Number.isInteger(horizonDays) || horizonDays < 0 || horizonDays > DEFAULT_MAX_HORIZON_DAYS) {
    throw new ForecastValidationError(
      `horizonDays должен быть целым числом от 0 до ${DEFAULT_MAX_HORIZON_DAYS}.`,
      "INVALID_HORIZON"
    );
  }
  const openingBalanceMinor = openingAmountMinor(input);
  const endDate = addDays(startDate, horizonDays);
  const plannedMap = new Map();
  const scenarioMaps = Object.fromEntries(SCENARIOS.map((name) => [name, new Map()]));
  const outflowMap = new Map();
  const excluded = [];

  scored.forEach((receipt, index) => {
    const amountMinor = receiptAmountMinor(receipt, index);
    if (amountMinor === 0) {
      excluded.push(exclusion("receipt", receipt, "settled", 0));
      return;
    }
    if (receipt.eventType === "bank-payment" || receipt.type === "payment" || receipt.isBankFact === true) {
      excluded.push(exclusion("receipt", receipt, "historical-bank-fact", amountMinor, receipt.bookingDate ?? null));
      return;
    }
    const plannedDate = requireDate(receipt.plannedDate, `receipts[${index}].plannedDate`);
    if (datePosition(plannedDate, startDate, horizonDays) === "inside") {
      addToDateMap(plannedMap, plannedDate, amountMinor);
    }
    SCENARIOS.forEach((scenarioName) => {
      const cashDate = scenarioCashDate(receipt, scenarioName);
      if (!cashDate) return;
      if (datePosition(cashDate, startDate, horizonDays) === "inside") {
        addToDateMap(scenarioMaps[scenarioName], cashDate, amountMinor);
      }
      if (scenarioName === scenario && datePosition(cashDate, startDate, horizonDays) !== "inside") {
        excluded.push(exclusion(
          "receipt",
          receipt,
          datePosition(cashDate, startDate, horizonDays) === "before" ? "before-horizon" : "after-horizon",
          amountMinor,
          cashDate
        ));
      }
    });
  });

  outflows.forEach((outflow, index) => {
    const amountMinor = outflowAmountMinor(outflow, index);
    const effectiveDate = requireDate(outflow.effectiveDate ?? outflow.date, `outflows[${index}].effectiveDate`);
    const position = datePosition(effectiveDate, startDate, horizonDays);
    if (position === "inside") {
      addToDateMap(outflowMap, effectiveDate, amountMinor);
    } else {
      excluded.push(exclusion(
        "outflow",
        outflow,
        position === "before" ? "before-horizon" : "after-horizon",
        amountMinor,
        effectiveDate
      ));
    }
  });

  let selectedBalanceMinor = openingBalanceMinor;
  const scenarioBalances = Object.fromEntries(SCENARIOS.map((name) => [name, openingBalanceMinor]));
  const days = Array.from({ length: horizonDays + 1 }, (_, index) => {
    const date = addDays(startDate, index);
    const key = toDateOnly(date);
    const openingMinor = selectedBalanceMinor;
    const plannedInMinor = plannedMap.get(key) ?? 0;
    const scenarioInflowMinor = scenarioMaps[scenario].get(key) ?? 0;
    const outflowMinor = outflowMap.get(key) ?? 0;
    selectedBalanceMinor = openingMinor + scenarioInflowMinor - outflowMinor;
    SCENARIOS.forEach((scenarioName) => {
      scenarioBalances[scenarioName] += (scenarioMaps[scenarioName].get(key) ?? 0) - outflowMinor;
    });
    const financingNeedMinor = Math.max(0, -selectedBalanceMinor);
    return {
      date,
      dateIso: key,
      openingBalanceMinor: openingMinor,
      plannedInMinor,
      scenarioInflowMinor,
      outflowMinor,
      closingBalanceMinor: selectedBalanceMinor,
      financingNeedMinor,
      scenarioBalancesMinor: { ...scenarioBalances },
      openingBalance: openingMinor / 100,
      plannedIn: plannedInMinor / 100,
      expectedIn: scenarioInflowMinor / 100,
      outflow: outflowMinor / 100,
      closingBalance: selectedBalanceMinor / 100,
      financingNeed: financingNeedMinor / 100,
      balance: selectedBalanceMinor / 100,
      p50Balance: scenarioBalances.p50 / 100,
      p80Balance: scenarioBalances.p80 / 100
    };
  });

  const excludedByReason = excluded.reduce((summary, item) => {
    const current = summary[item.reason] ?? { count: 0, amountMinor: 0 };
    current.count += 1;
    current.amountMinor += item.amountMinor;
    summary[item.reason] = current;
    return summary;
  }, {});
  const report = {
    scenario,
    startDate,
    startDateIso: toDateOnly(startDate),
    endDate,
    endDateIso: toDateOnly(endDate),
    horizonDays,
    calendarDayCount: days.length,
    excluded,
    excludedByReason,
    excludedCount: excluded.length,
    excludedAmountMinor: excluded.reduce((sum, item) => sum + item.amountMinor, 0)
  };
  return { days, report };
}

export function buildForecast(input) {
  const result = buildForecastResult(input);
  Object.defineProperties(result.days, {
    report: { value: result.report, enumerable: false },
    result: { value: result, enumerable: false }
  });
  return result.days;
}

import {
  DEFAULT_MAX_HORIZON_DAYS,
  addDays,
  assertDateWithinHorizon,
  daysBetween,
  toDateOnly
} from "./date.js";

const SCENARIOS = [["p50", 0.5], ["p80", 0.8], ["p90", 0.9]];

export class TimingModelError extends Error {
  constructor(message, code = "INVALID_TIMING_INPUT") {
    super(message);
    this.name = "TimingModelError";
    this.code = code;
  }
}

function normalizeDelays(values, label, maxHorizonDays) {
  if (!Array.isArray(values)) return [];
  return values.map((value, index) => {
    const delay = Number(value);
    if (!Number.isInteger(delay) || delay < 0) {
      throw new TimingModelError(`${label}[${index}]: задержка должна быть целым числом не меньше нуля.`);
    }
    if (delay > maxHorizonDays) {
      throw new TimingModelError(
        `${label}[${index}]: задержка ${delay} дней превышает горизонт ${maxHorizonDays} дней.`,
        "TIMING_OUT_OF_HORIZON"
      );
    }
    return delay;
  });
}

export function percentileDelay(delays, percentile) {
  if (!Array.isArray(delays) || !delays.length) return 0;
  if (!(percentile > 0 && percentile <= 1)) {
    throw new TimingModelError("percentile должен быть больше 0 и не больше 1.");
  }
  const sorted = delays.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1)];
}

function weightedObservations(values, totalWeight, population) {
  if (!values.length || totalWeight <= 0) return [];
  const weight = totalWeight / values.length;
  return values.map((delay) => ({ delay, weight, population }));
}

function weightedQuantile(observations, percentile) {
  const sorted = observations.slice().sort((a, b) => a.delay - b.delay);
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight / totalWeight;
    if (cumulative + Number.EPSILON >= percentile) return item.delay;
  }
  return sorted.at(-1)?.delay ?? 0;
}

function conditionOnElapsed(observations, elapsedDays) {
  if (elapsedDays <= 0) return { observations, exhausted: false };
  const tail = observations.filter((item) => item.delay >= elapsedDays);
  return tail.length
    ? { observations: tail, exhausted: false }
    : { observations: [{ delay: elapsedDays, weight: 1, population: "elapsed-floor" }], exhausted: true };
}

function buildDistribution(ownDelays, portfolioDelays) {
  if (ownDelays.length >= 5) {
    return {
      observations: weightedObservations(ownDelays, 1, "counterparty"),
      source: "counterparty",
      fallbackPolicy: "n>=5: empirical counterparty distribution",
      ownWeight: 1,
      portfolioWeight: 0
    };
  }
  if (ownDelays.length > 0 && portfolioDelays.length > 0) {
    const ownWeight = ownDelays.length / 5;
    const portfolioWeight = (5 - ownDelays.length) / 5;
    return {
      observations: [
        ...weightedObservations(ownDelays, ownWeight, "counterparty"),
        ...weightedObservations(portfolioDelays, portfolioWeight, "portfolio")
      ],
      source: "blended",
      fallbackPolicy: `n=1..4: F=${ownWeight.toFixed(2)}*F_counterparty+${portfolioWeight.toFixed(2)}*F_portfolio`,
      ownWeight,
      portfolioWeight
    };
  }
  if (ownDelays.length > 0) {
    return {
      observations: weightedObservations(ownDelays, 1, "counterparty"),
      source: "sparse-counterparty",
      fallbackPolicy: "n=1..4: портфельная история отсутствует; собственная выборка используется с низкой уверенностью",
      ownWeight: 1,
      portfolioWeight: 0
    };
  }
  if (portfolioDelays.length > 0) {
    return {
      observations: weightedObservations(portfolioDelays, 1, "portfolio"),
      source: "portfolio",
      fallbackPolicy: "n=0: portfolio prior; собственной истории нет",
      ownWeight: 0,
      portfolioWeight: 1
    };
  }
  return {
    observations: [{ delay: 0, weight: 1, population: "contractual-date" }],
    source: "contractual-date",
    fallbackPolicy: "n=0: портфельная история отсутствует; базовая дата договорная, надежность неизвестна",
    ownWeight: 0,
    portfolioWeight: 0
  };
}

function normalizeManagerPromise(signal, plannedDate, maxHorizonDays) {
  if (!signal) return null;
  const complete = signal.date instanceof Date
    && !Number.isNaN(signal.date.getTime())
    && String(signal.source ?? "").trim()
    && String(signal.author ?? "").trim()
    && String(signal.observedAt ?? "").trim();
  if (!complete) {
    throw new TimingModelError("Manager promise требует date, source, author и observedAt.", "INVALID_MANAGER_PROMISE");
  }
  assertDateWithinHorizon(signal.date, plannedDate, {
    fieldName: "managerPromise.date",
    maxDays: maxHorizonDays
  });
  return {
    date: signal.date,
    source: String(signal.source),
    author: String(signal.author),
    observedAt: String(signal.observedAt),
    appliedToScenario: false
  };
}

function normalizeManualException(exception) {
  if (!exception) return null;
  const type = String(exception.type ?? "").trim();
  if (!new Set(["bankruptcy", "default", "legal-recovery"]).has(type)) {
    throw new TimingModelError(`Неизвестный тип ручного исключения: ${type}.`, "INVALID_MANUAL_EXCEPTION");
  }
  return { ...exception, type, appliedToAmount: false, requiresManualScenario: true };
}

export function buildTimingModel(receipt, options = {}) {
  const plannedDate = receipt?.plannedDate;
  if (!(plannedDate instanceof Date) || Number.isNaN(plannedDate.getTime())) {
    throw new TimingModelError("plannedDate должен быть корректной календарной датой.");
  }
  const maxHorizonDays = options.maxHorizonDays ?? DEFAULT_MAX_HORIZON_DAYS;
  const ownDelays = normalizeDelays(receipt.historyDelays ?? [], "historyDelays", maxHorizonDays);
  const portfolioDelays = normalizeDelays(
    options.portfolioDelays ?? receipt.portfolioDelays ?? [],
    "portfolioDelays",
    maxHorizonDays
  );
  const asOfDate = options.asOfDate ?? receipt.asOfDate ?? plannedDate;
  if (!(asOfDate instanceof Date) || Number.isNaN(asOfDate.getTime())) {
    throw new TimingModelError("asOfDate должен быть корректной календарной датой.");
  }
  const elapsedOverdueDays = Math.max(0, daysBetween(asOfDate, plannedDate));
  if (elapsedOverdueDays > maxHorizonDays) {
    throw new TimingModelError(
      `Просрочка ${elapsedOverdueDays} дней превышает горизонт ${maxHorizonDays} дней.`,
      "TIMING_OUT_OF_HORIZON"
    );
  }

  const distribution = buildDistribution(ownDelays, portfolioDelays);
  const conditional = conditionOnElapsed(distribution.observations, elapsedOverdueDays);
  const scenarioDelays = Object.fromEntries(SCENARIOS.map(([name, quantile]) => [
    name,
    weightedQuantile(conditional.observations, quantile)
  ]));
  scenarioDelays.stress = Math.max(...conditional.observations.map((item) => item.delay));
  const totalWeight = distribution.observations.reduce((sum, item) => sum + item.weight, 0);
  const onTimeProbability = distribution.source === "contractual-date"
    ? null
    : distribution.observations
      .filter((item) => item.delay === 0)
      .reduce((sum, item) => sum + item.weight, 0) / totalWeight;

  const reason = elapsedOverdueDays > 0
    ? `ДЗ просрочена на ${elapsedOverdueDays} дн.; использовано условное распределение D>=${elapsedOverdueDays}.`
    : distribution.source === "counterparty"
      ? `Использованы ${ownDelays.length} завершенных оплат контрагента.`
      : distribution.source === "blended"
        ? `Смешаны ${ownDelays.length} оплаты контрагента и ${portfolioDelays.length} портфельных наблюдений.`
        : distribution.source === "portfolio"
          ? `Нет собственной истории; использованы ${portfolioDelays.length} портфельных наблюдений.`
          : distribution.fallbackPolicy;
  const usedSampleSize = distribution.source === "counterparty"
    ? ownDelays.length
    : distribution.source === "portfolio"
      ? portfolioDelays.length
      : distribution.source === "contractual-date"
        ? 0
        : ownDelays.length + portfolioDelays.length;

  const scenarioDetails = Object.fromEntries([...SCENARIOS, ["stress", null]].map(([name, quantile]) => {
    const delayDays = scenarioDelays[name];
    const date = addDays(plannedDate, delayDays);
    assertDateWithinHorizon(date, plannedDate, { fieldName: `${name}Date`, maxDays: maxHorizonDays });
    return [name, {
      scenario: name,
      quantile,
      delayDays,
      date,
      dateIso: toDateOnly(date),
      source: distribution.source,
      sampleSize: usedSampleSize,
      ownSampleSize: ownDelays.length,
      portfolioSampleSize: portfolioDelays.length,
      ownDelays: ownDelays.slice(),
      portfolioDelays: portfolioDelays.slice(),
      conditionedDelays: conditional.observations.map((item) => item.delay),
      fallbackPolicy: distribution.fallbackPolicy,
      elapsedOverdueDays,
      conditionalTailExhausted: conditional.exhausted,
      reason
    }];
  }));

  return {
    source: distribution.source,
    ownSampleSize: ownDelays.length,
    portfolioSampleSize: portfolioDelays.length,
    sampleSize: usedSampleSize,
    ownDelays,
    portfolioDelays,
    ownWeight: distribution.ownWeight,
    portfolioWeight: distribution.portfolioWeight,
    fallbackPolicy: distribution.fallbackPolicy,
    elapsedOverdueDays,
    conditionalTailExhausted: conditional.exhausted,
    noOwnHistory: ownDelays.length === 0,
    confidence: ownDelays.length >= 5 ? "own-history" : ownDelays.length ? "blended-or-sparse" : "no-own-history",
    onTimeProbability,
    scenarioDelays,
    scenarioDetails,
    managerPromise: normalizeManagerPromise(receipt.managerPromise, plannedDate, maxHorizonDays),
    manualException: normalizeManualException(receipt.manualException),
    reason
  };
}

export function buildTimingFromFallback(receipt) {
  if (receipt.avgDelay === null || receipt.avgDelay === undefined) {
    return { p50: 0, p80: 0, p90: 0, stress: 0, source: "contractual-date" };
  }
  let p50 = Math.max(0, Math.round(receipt.avgDelay * 0.5));
  let p80 = Math.max(p50, Math.round(receipt.avgDelay));
  let p90 = Math.max(p80, Math.round(receipt.avgDelay * 1.3));
  let stress = Math.max(p90, Math.round(receipt.avgDelay * 1.6));
  if (!receipt.documentsOk) [p50, p80, p90, stress] = [p50 + 4, p80 + 4, p90 + 4, stress + 4];
  if (!receipt.bankMatch) [p50, p80, p90, stress] = [p50 + 2, p80 + 2, p90 + 2, stress + 2];
  if (receipt.late30 >= 0.3) stress = Math.max(stress, 30);
  return { p50, p80, p90, stress, source: "legacy-fallback" };
}

export function scoreReceipt(receipt, options = {}) {
  const formatDate = options.formatDate ?? toDateOnly;
  const model = buildTimingModel(receipt, options);
  const timing = { ...model.scenarioDelays, source: model.source };
  const p50Date = addDays(receipt.plannedDate, timing.p50);
  const p80Date = addDays(receipt.plannedDate, timing.p80);
  const p90Date = addDays(receipt.plannedDate, timing.p90);
  const stressDate = addDays(receipt.plannedDate, timing.stress);
  const onTimeProbability = model.onTimeProbability;
  const reason = model.reason;

  return {
    ...receipt,
    probability: onTimeProbability,
    expectedDelay: timing.p50,
    expectedDate: p50Date,
    p50Delay: timing.p50,
    p80Delay: timing.p80,
    p90Delay: timing.p90,
    stressDelay: timing.stress,
    p50Date,
    p80Date,
    p90Date,
    stressDate,
    scenarioDelays: timing,
    scenarioDetails: model.scenarioDetails,
    timingEvidence: model,
    modelSource: timing.source,
    noOwnHistory: model.noOwnHistory,
    riskAmount: receipt.amount,
    riskWindowStart: receipt.plannedDate,
    riskWindowEnd: p80Date,
    riskWindow: `${formatDate(receipt.plannedDate)} — ${formatDate(p80Date)}`,
    shiftReason: reason,
    onTimeProbability,
    managerPromise: model.managerPromise,
    manualException: model.manualException,
    scoreExplanation: `${reason} Полная открытая сумма переносится на сценарную дату; сумма не умножается на вероятность.`
  };
}

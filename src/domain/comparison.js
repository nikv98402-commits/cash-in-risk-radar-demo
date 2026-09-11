function requireRun(run, label) {
  if (!run || typeof run !== "object" || !String(run.runId ?? "").trim()) {
    throw new TypeError(`${label} должен быть зафиксированным расчетом.`);
  }
  return run;
}

function money(value) {
  return Number.isSafeInteger(value) ? value : 0;
}

function dateDistance(previous, current) {
  if (!previous || !current || previous === current) return previous === current ? 0 : null;
  const left = Date.parse(`${previous}T00:00:00Z`);
  const right = Date.parse(`${current}T00:00:00Z`);
  return Number.isFinite(left) && Number.isFinite(right) ? Math.round((right - left) / 86_400_000) : null;
}

function runMetrics(run) {
  const calendar = run.outputs?.calendar ?? [];
  const closings = calendar.map((day) => money(day.closingBalanceMinor));
  const needs = calendar.map((day) => money(day.financingNeedMinor));
  return {
    openReceivablesMinor: (run.inputs?.receipts ?? []).reduce((sum, item) => sum + money(item.remainingAmountMinor ?? item.amountMinor), 0),
    minimumClosingBalanceMinor: closings.length ? Math.min(...closings) : 0,
    maximumFinancingNeedMinor: needs.length ? Math.max(...needs) : 0,
    coverageCostMinor: money(run.outputs?.funding?.totalCostMinor),
    uncoveredNeedMinor: money(run.outputs?.funding?.uncoveredNeedMinor)
  };
}

function receiptMap(run) {
  const dates = new Map((run.outputs?.scenarioDates ?? []).map((item) => [String(item.id), item]));
  return new Map((run.inputs?.receipts ?? []).map((item) => {
    const id = String(item.id);
    const scenario = dates.get(id) ?? {};
    return [id, {
      id,
      counterparty: String(item.counterparty ?? ""),
      openAmountMinor: money(item.remainingAmountMinor ?? item.amountMinor),
      plannedDate: item.plannedDate ?? null,
      p50Date: scenario.p50Date ?? null,
      p80Date: scenario.p80Date ?? null,
      p90Date: scenario.p90Date ?? null,
      stressDate: scenario.stressDate ?? null
    }];
  }));
}

function sourceMap(run) {
  return new Map((run.sources ?? []).map((source, index) => {
    const key = String(source.name ?? source.type ?? `source-${index + 1}`);
    return [key, String(source.sha256 ?? "нет fingerprint")];
  }));
}

function fundingMap(run) {
  return new Map((run.inputs?.fundingSources ?? []).map((source, index) => {
    const key = String(source.type ?? source.id ?? `funding-${index + 1}`);
    const commercialTerms = Object.fromEntries(Object.entries(source)
      .filter(([field]) => ![
        "id", "type", "name", "priority", "constraints", "inputSource",
        "sourceRunId", "sourceCreatedAt", "sourceAsOfDate"
      ].includes(field))
      .sort(([left], [right]) => left.localeCompare(right)));
    return [key, commercialTerms];
  }));
}

export function compareAuditRuns(currentRun, previousRun) {
  const current = requireRun(currentRun, "Текущий run");
  const previous = requireRun(previousRun, "Предыдущий run");
  const currentMetrics = runMetrics(current);
  const previousMetrics = runMetrics(previous);
  const metricDelta = Object.fromEntries(Object.keys(currentMetrics).map((key) => [key, {
    previousMinor: previousMetrics[key],
    currentMinor: currentMetrics[key],
    deltaMinor: currentMetrics[key] - previousMetrics[key]
  }]));

  const currentReceipts = receiptMap(current);
  const previousReceipts = receiptMap(previous);
  const newReceivables = [...currentReceipts.keys()].filter((id) => !previousReceipts.has(id)).sort();
  const disappearedReceivables = [...previousReceipts.keys()].filter((id) => !currentReceipts.has(id)).sort();
  const comparedReceivables = [...currentReceipts.keys()].filter((id) => previousReceipts.has(id)).sort().map((id) => {
    const before = previousReceipts.get(id);
    const after = currentReceipts.get(id);
    const dateDelta = Object.fromEntries(["p50Date", "p80Date", "p90Date", "stressDate"].map((key) => [key, {
      previousDate: before[key],
      currentDate: after[key],
      deltaDays: dateDistance(before[key], after[key])
    }]));
    return {
      id,
      counterparty: after.counterparty,
      openAmountDeltaMinor: after.openAmountMinor - before.openAmountMinor,
      previous: before,
      current: after,
      dateDelta,
      changed: JSON.stringify(after) !== JSON.stringify(before)
    };
  });
  const changedReceivables = comparedReceivables.filter((item) => item.changed);

  const currentSources = sourceMap(current);
  const previousSources = sourceMap(previous);
  const sourceKeys = [...new Set([...currentSources.keys(), ...previousSources.keys()])].sort();
  const sourceFingerprintChanges = sourceKeys.map((source) => ({
    source,
    previousSha256: previousSources.get(source) ?? null,
    currentSha256: currentSources.get(source) ?? null,
    changed: previousSources.get(source) !== currentSources.get(source)
  })).filter((item) => item.changed);

  const currentFunding = fundingMap(current);
  const previousFunding = fundingMap(previous);
  const fundingKeys = [...new Set([...currentFunding.keys(), ...previousFunding.keys()])].sort();
  const fundingInputChanges = fundingKeys.map((source) => ({
    source,
    previous: previousFunding.get(source) ?? null,
    current: currentFunding.get(source) ?? null,
    changed: JSON.stringify(previousFunding.get(source) ?? null) !== JSON.stringify(currentFunding.get(source) ?? null)
  })).filter((item) => item.changed);

  return {
    current: { runId: current.runId, createdAt: current.createdAt, asOfDate: current.asOfDate },
    previous: { runId: previous.runId, createdAt: previous.createdAt, asOfDate: previous.asOfDate },
    metrics: metricDelta,
    receivables: { new: newReceivables, disappeared: disappearedReceivables, compared: comparedReceivables, changed: changedReceivables },
    sourceFingerprintChanges,
    fundingInputs: { changed: fundingInputChanges, unchangedCount: fundingKeys.length - fundingInputChanges.length }
  };
}

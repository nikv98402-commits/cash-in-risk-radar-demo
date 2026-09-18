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

function runMetrics(run, dates = null) {
  const calendar = (run.outputs?.calendar ?? []).filter((day) => !dates || dates.has(day.date));
  let minimumClosingBalanceMinor = null;
  let maximumFinancingNeedMinor = 0;
  for (const day of calendar) {
    const closing = money(day.closingBalanceMinor);
    minimumClosingBalanceMinor = minimumClosingBalanceMinor === null ? closing : Math.min(minimumClosingBalanceMinor, closing);
    maximumFinancingNeedMinor = Math.max(maximumFinancingNeedMinor, money(day.financingNeedMinor));
  }
  return {
    openingBalanceMinor: money(run.inputs?.openingBalanceMinor),
    openReceivablesMinor: (run.inputs?.receipts ?? []).reduce((sum, item) => sum + money(item.remainingAmountMinor ?? item.amountMinor), 0),
    minimumClosingBalanceMinor: minimumClosingBalanceMinor ?? 0,
    maximumFinancingNeedMinor,
    coverageCostMinor: money(run.outputs?.funding?.totalCostMinor),
    uncoveredNeedMinor: money(run.outputs?.funding?.uncoveredNeedMinor)
  };
}

function accountSet(run) {
  const balances = run.inputs?.canonicalLedger?.bankBalances ?? [];
  return [...new Set(balances.map((item) => JSON.stringify([item.bankId, item.accountId])))].sort();
}

function compatibility(current, previous) {
  const reasons = [];
  if (current.currency !== previous.currency) reasons.push("Разные валюты расчетов.");
  if (current.scenario !== previous.scenario) reasons.push("Разные сценарии расчетов.");
  const currentLedger = current.inputs?.canonicalLedger;
  const previousLedger = previous.inputs?.canonicalLedger;
  if (currentLedger && previousLedger) {
    if (currentLedger.legalEntityId !== previousLedger.legalEntityId) reasons.push("Разные юридические лица.");
    if (JSON.stringify(accountSet(current)) !== JSON.stringify(accountSet(previous))) reasons.push("Разный набор банковских счетов.");
  }
  return {
    comparable: reasons.length === 0,
    reasons,
    identityVerified: Boolean(currentLedger && previousLedger && accountSet(current).length && accountSet(previous).length),
    accounts: { current: accountSet(current), previous: accountSet(previous) },
    legalEntities: { current: currentLedger?.legalEntityId ?? null, previous: previousLedger?.legalEntityId ?? null },
    currency: current.currency,
    scenario: current.scenario,
    freshness: {
      current: (current.sources ?? []).map((item) => ({ closeDate: item.bankBalanceCloseDate ?? null, observedAt: item.observedAt ?? null })),
      previous: (previous.sources ?? []).map((item) => ({ closeDate: item.bankBalanceCloseDate ?? null, observedAt: item.observedAt ?? null }))
    }
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
  const match = compatibility(current, previous);
  if (!match.comparable) return { current: { runId: current.runId }, previous: { runId: previous.runId }, compatibility: match, commonDates: [] };
  const previousDates = new Set((previous.outputs?.calendar ?? []).map((day) => day.date));
  const commonDates = [...new Set((current.outputs?.calendar ?? []).map((day) => day.date).filter((date) => previousDates.has(date)))].sort();
  const dates = new Set(commonDates);
  const currentMetrics = runMetrics(current, dates);
  const previousMetrics = runMetrics(previous, dates);
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
    compatibility: match,
    commonDates,
    dailyBalances: commonDates.map((date) => {
      const after = current.outputs.calendar.find((day) => day.date === date);
      const before = previous.outputs.calendar.find((day) => day.date === date);
      return { date, previousMinor: money(before.closingBalanceMinor), currentMinor: money(after.closingBalanceMinor), deltaMinor: money(after.closingBalanceMinor) - money(before.closingBalanceMinor), previousNeedMinor: money(before.financingNeedMinor), currentNeedMinor: money(after.financingNeedMinor) };
    }),
    metrics: metricDelta,
    receivables: { new: newReceivables, disappeared: disappearedReceivables, compared: comparedReceivables, changed: changedReceivables },
    sourceFingerprintChanges,
    fundingInputs: { changed: fundingInputChanges, unchangedCount: fundingKeys.length - fundingInputChanges.length }
  };
}

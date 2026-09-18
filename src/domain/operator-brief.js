import { compareAuditRuns } from "./comparison.js";
import { assessPlanningFreshness } from "./planning-freshness.js";

function minor(value) {
  return Number.isSafeInteger(value) ? value : 0;
}

function scenarioDate(item, scenario) {
  return item?.[`${scenario}Date`] ?? null;
}

function bankSource(run) {
  return (run.sources ?? []).findLast((source) => source.bankBalanceCloseDate && !source.inheritedFromRunId) ?? null;
}

export function buildOperatorBrief(run, previousRun = null) {
  if (!run?.runId) return null;
  const calendar = run.outputs?.calendar ?? [];
  const firstGapIndex = calendar.findIndex((day) => minor(day.financingNeedMinor) > 0);
  const firstGap = firstGapIndex >= 0 ? calendar[firstGapIndex] : null;
  const recoveryIndex = firstGap ? calendar.findIndex((day, index) => index > firstGapIndex && minor(day.closingBalanceMinor) >= 0) : -1;
  const lastGap = firstGap ? calendar[recoveryIndex > firstGapIndex ? recoveryIndex - 1 : calendar.length - 1] : null;
  const peak = calendar.reduce((best, day) => !best || minor(day.financingNeedMinor) > minor(best.financingNeedMinor) ? day : best, null);
  const dates = new Map((run.outputs?.scenarioDates ?? []).map((item) => [String(item.id), item]));
  const delayed = (run.inputs?.receipts ?? []).map((receipt) => {
    const plannedDate = receipt.plannedDate;
    const cashDate = scenarioDate(dates.get(String(receipt.id)), run.scenario) ?? plannedDate;
    return { id: String(receipt.id), counterparty: String(receipt.counterparty ?? receipt.id), plannedDate, cashDate,
      amountMinor: minor(receipt.remainingAmountMinor ?? receipt.amountMinor) };
  }).filter((item) => item.amountMinor > 0 && item.cashDate > item.plannedDate);
  const causes = firstGap ? delayed.filter((item) => item.plannedDate <= firstGap.date && item.cashDate > firstGap.date)
    .sort((left, right) => right.amountMinor - left.amountMinor).slice(0, 3) : [];
  const gapOutflows = firstGap ? (run.inputs?.outflows ?? []).filter((item) => item.effectiveDate === firstGap.date)
    .map((item) => ({ category: String(item.category ?? "Исходящий платеж"), amountMinor: minor(item.amountMinor) })) : [];
  const actions = (run.outputs?.funding?.actions ?? []).filter((item) => item.status === "applied" && minor(item.appliedAmountMinor) > 0)
    .map((item) => ({ name: String(item.name ?? item.type), amountMinor: minor(item.appliedAmountMinor), effectiveDate: item.effectiveDate ?? null,
      costMinor: minor(item.costMinor) }));
  const report = run.qualityReport ?? {};
  const unmatchedPayments = minor(report.reconciliation?.unmatchedPayments);
  const pendingAllocations = minor(report.reconciliation?.pendingAllocations);
  const errors = Array.isArray(report.errors) ? report.errors.length : 0;
  const bank = bankSource(run);
  const planningSource = (run.sources ?? []).findLast((source) => source.planningAsOfDate) ?? null;
  const planningFreshness = planningSource
    ? assessPlanningFreshness(run.asOfDate, planningSource.planningAsOfDate)
    : null;
  let change = null;
  if (previousRun) {
    const comparison = compareAuditRuns(run, previousRun);
    change = comparison.compatibility.comparable && comparison.commonDates.length
      ? { status: "comparable", previousRunId: previousRun.runId, previousAsOfDate: previousRun.asOfDate,
        commonDates: comparison.commonDates.length,
        openingBalanceDeltaMinor: comparison.metrics.openingBalanceMinor.deltaMinor,
        maxNeedDeltaMinor: comparison.metrics.maximumFinancingNeedMinor.deltaMinor,
        costDeltaMinor: comparison.metrics.coverageCostMinor.deltaMinor,
        uncoveredDeltaMinor: comparison.metrics.uncoveredNeedMinor.deltaMinor,
        identityVerified: comparison.compatibility.identityVerified }
      : { status: "unavailable", previousRunId: previousRun.runId,
        reason: comparison.compatibility.reasons.join(" ") || "Нет общих дат для сравнения." };
  }
  return {
    runId: run.runId, asOfDate: run.asOfDate, scenario: run.scenario, currency: run.currency,
    isDemo: !(run.sources ?? []).length || (run.sources ?? []).some((source) => source.type === "demo"),
    bank: bank ? { closeDate: bank.bankBalanceCloseDate, observedAt: bank.observedAt ?? null, accountCount: bank.bankAccountCount ?? null } : null,
    planning: planningSource ? { asOfDate: planningSource.planningAsOfDate,
      inheritedFromRunId: planningSource.inheritedFromRunId ?? null, ...planningFreshness } : null,
    forecastStatus: planningFreshness?.status === "stale" ? "requires-planning-update" : "current",
    openingBalanceMinor: minor(run.inputs?.openingBalanceMinor),
    openingBalanceIsBankFact: Boolean(bank),
    firstGapDate: firstGap?.date ?? null,
    riskWindowEndDate: lastGap?.date ?? null,
    maximumNeedMinor: minor(peak?.financingNeedMinor), peakDate: peak?.date ?? null,
    causes, gapOutflows,
    actions, coverageCostMinor: minor(run.outputs?.funding?.totalCostMinor),
    uncoveredNeedMinor: minor(run.outputs?.funding?.uncoveredNeedMinor),
    quality: { errors, unmatchedPayments, pendingAllocations, warnings: report.warnings?.length ?? 0,
      needsReview: errors > 0 || unmatchedPayments > 0 || pendingAllocations > 0 },
    change
  };
}

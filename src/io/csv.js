const FORMULA_PREFIX = /^[=+\-@\t\r\n\u0000-\u001f]/;

export class CsvExportError extends Error {
  constructor(message) {
    super(message);
    this.name = "CsvExportError";
  }
}

export function neutralizeSpreadsheetFormula(value) {
  const text = String(value ?? "");
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

export function escapeCsvCell(value) {
  const safe = neutralizeSpreadsheetFormula(value);
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function requireCommittedRun(run) {
  if (!run || typeof run !== "object" || !String(run.runId ?? "").trim()) {
    throw new CsvExportError("CSV доступен только для последнего успешно зафиксированного расчета.");
  }
  if (!run.inputs || !run.outputs || !Array.isArray(run.inputs.receipts)) {
    throw new CsvExportError("Зафиксированный расчет не содержит данных для CSV.");
  }
  return run;
}

export function buildCommittedRunCsv(run) {
  const committed = requireCommittedRun(run);
  const scenarioDates = new Map((committed.outputs.scenarioDates ?? []).map((item) => [item.id, item]));
  const header = [
    "run_id", "as_of_date", "scenario", "currency", "invoice_id", "counterparty",
    "open_amount_minor", "planned_date", "p50_date", "p80_date", "p90_date",
    "stress_date", "p50_shift_days", "p80_shift_days", "reconciliation_status",
    "reconciliation_operator", "reconciliation_confirmed_at", "cfo_report_status",
    "cfo_operator", "cfo_confirmed_at", "unmatched_payments", "pending_allocations",
    "quality_errors", "quality_warnings", "maximum_financing_need_minor",
    "applied_coverage_minor", "coverage_cost_minor", "uncovered_need_minor",
    "incomplete_funding_sources", "unavailable_funding_sources",
    "uncovered_gap_accepted", "funding_input_sources"
  ];
  const reconciliation = committed.signOff?.reconciliation ?? {};
  const cfo = committed.signOff?.cfoReport ?? {};
  const counts = reconciliation.confirmation?.qualityCounts ?? {};
  const fundingActions = committed.outputs.funding?.actions ?? [];
  const maximumFinancingNeedMinor = (committed.outputs.calendar ?? [])
    .reduce((maximum, day) => Math.max(maximum, Number.isSafeInteger(day.financingNeedMinor) ? day.financingNeedMinor : 0), 0);
  const appliedCoverageMinor = fundingActions.reduce((sum, action) => sum
    + (Number.isSafeInteger(action.appliedAmountMinor) ? action.appliedAmountMinor : 0), 0);
  const incompleteSources = fundingActions.filter((action) => action.status === "incomplete").map((action) => action.name ?? action.type).join("; ");
  const unavailableSources = fundingActions.filter((action) => action.status === "unavailable").map((action) => action.name ?? action.type).join("; ");
  const fundingInputSources = [...new Set((committed.inputs.fundingSources ?? []).map((source) => source.inputSource).filter(Boolean))].join("; ");
  const exportReceipts = committed.inputs.receipts.length ? committed.inputs.receipts : [null];
  const rows = exportReceipts.map((receipt) => {
    const dates = receipt ? scenarioDates.get(receipt.id) ?? {} : {};
    return [
      committed.runId,
      committed.asOfDate,
      committed.scenario,
      committed.currency,
      receipt?.id ?? "",
      receipt?.counterparty ?? "",
      receipt ? receipt.remainingAmountMinor ?? receipt.amountMinor ?? receipt.openArMinor : "",
      receipt?.plannedDate ?? "",
      dates.p50Date ?? "",
      dates.p80Date ?? "",
      dates.p90Date ?? "",
      dates.stressDate ?? "",
      dates.p50Delay ?? "",
      dates.p80Delay ?? "",
      reconciliation.status ?? "reconciliation-pending",
      reconciliation.confirmation?.operator ?? "",
      reconciliation.confirmation?.confirmedAt ?? "",
      cfo.status ?? "cfo-pending",
      cfo.confirmation?.operator ?? "",
      cfo.confirmation?.confirmedAt ?? "",
      counts.unmatchedPayments ?? "",
      counts.pendingAllocations ?? "",
      counts.errors ?? "",
      counts.warnings ?? "",
      maximumFinancingNeedMinor,
      appliedCoverageMinor,
      committed.outputs.funding?.totalCostMinor ?? 0,
      committed.outputs.funding?.uncoveredNeedMinor ?? 0,
      incompleteSources,
      unavailableSources,
      cfo.confirmation?.uncoveredGapAccepted === true ? "true" : "false",
      fundingInputSources
    ];
  });
  return `\uFEFF${[header, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\r\n")}`;
}

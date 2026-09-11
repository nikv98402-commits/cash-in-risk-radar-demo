export const RUN_STATUS = Object.freeze({
  UNCOMPUTED: "uncomputed",
  STAGED: "staged",
  RUNNING: "running",
  CURRENT: "current",
  STALE: "stale",
  ERROR: "error"
});

export const MODEL_VERSIONS = Object.freeze({
  schema: "1.0.0",
  timingModel: "1.0.0",
  forecast: "1.0.0",
  funding: "1.0.0"
});

export const SIGN_OFF_STATUS = Object.freeze({
  RECONCILIATION_PENDING: "reconciliation-pending",
  RECONCILIATION_CONFIRMED: "reconciliation-confirmed",
  CFO_PENDING: "cfo-pending",
  CFO_READY: "cfo-ready"
});

export class RunTransactionError extends Error {
  constructor(message, code = "INVALID_RUN_TRANSACTION") {
    super(message);
    this.name = "RunTransactionError";
    this.code = code;
  }
}

let fallbackRunSequence = 0;

function defaultRunIdFactory() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  fallbackRunSequence += 1;
  return `run-${Date.now()}-${fallbackRunSequence}`;
}

function defaultClock() {
  return new Date();
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RunTransactionError(`${field} должен быть объектом.`);
  }
  return value;
}

function requireTimestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RunTransactionError(`${field} содержит некорректное время.`);
  return date.toISOString();
}

function requireDateOnly(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) {
    throw new RunTransactionError(`${field} должен иметь формат YYYY-MM-DD.`);
  }
  return value;
}

function validateRunPayload(payload) {
  requireObject(payload, "payload");
  requireObject(payload.inputs, "payload.inputs");
  requireObject(payload.outputs, "payload.outputs");
  requireObject(payload.versions, "payload.versions");
  requireDateOnly(payload.asOfDate, "payload.asOfDate");
  if (!String(payload.scenario ?? "").trim()) throw new RunTransactionError("payload.scenario обязателен.");
  if (!Number.isInteger(payload.horizonDays) || payload.horizonDays < 0 || payload.horizonDays > 366) {
    throw new RunTransactionError("payload.horizonDays должен быть целым числом от 0 до 366.");
  }
  if (!String(payload.currency ?? "").trim()) throw new RunTransactionError("payload.currency обязателен.");
  if (!Array.isArray(payload.sources)) throw new RunTransactionError("payload.sources должен быть массивом.");
  requireObject(payload.qualityReport, "payload.qualityReport");
  return payload;
}

function qualityCounts(run) {
  const report = run.qualityReport ?? {};
  const reconciliation = report.reconciliation ?? {};
  return {
    unmatchedPayments: Number.isInteger(reconciliation.unmatchedPayments) ? reconciliation.unmatchedPayments : 0,
    pendingAllocations: Number.isInteger(reconciliation.pendingAllocations) ? reconciliation.pendingAllocations : 0,
    errors: Array.isArray(report.errors) ? report.errors.length : 0,
    warnings: Array.isArray(report.warnings) ? report.warnings.length : 0
  };
}

function money(value) {
  return Number.isSafeInteger(value) ? value : 0;
}

export function getCfoReadiness(run, { uncoveredGapAccepted = false } = {}) {
  if (!run || typeof run !== "object") {
    return {
      canConfirm: false,
      blockers: [{ code: "NO_CURRENT_RUN", message: "Нет актуального committed run." }],
      qualityCounts: { unmatchedPayments: 0, pendingAllocations: 0, errors: 0, warnings: 0 },
      maximumFinancingNeedMinor: 0,
      appliedCoverageMinor: 0,
      totalCostMinor: 0,
      uncoveredNeedMinor: 0,
      incompleteSources: [],
      unavailableSources: [],
      requiresUncoveredAcceptance: false
    };
  }
  const counts = qualityCounts(run);
  const actions = Array.isArray(run.outputs?.funding?.actions) ? run.outputs.funding.actions : [];
  const incompleteSources = actions.filter((action) => action.status === "incomplete").map((action) => action.name ?? action.type);
  const unavailableSources = actions.filter((action) => action.status === "unavailable").map((action) => action.name ?? action.type);
  const uncoveredNeedMinor = money(run.outputs?.funding?.uncoveredNeedMinor);
  const blockers = [];
  if (run.signOff?.reconciliation?.status !== SIGN_OFF_STATUS.RECONCILIATION_CONFIRMED) {
    blockers.push({ code: "RECONCILIATION_REQUIRED", message: "Сначала подтвердите сверку." });
  }
  if (counts.errors > 0) {
    blockers.push({ code: "QUALITY_ERRORS", message: `Исправьте ошибки качества данных: ${counts.errors}.` });
  }
  if (incompleteSources.length > 0) {
    blockers.push({ code: "INCOMPLETE_FUNDING", message: `Заполните условия источников: ${incompleteSources.join(", ")}.` });
  }
  if (uncoveredNeedMinor > 0 && !uncoveredGapAccepted) {
    blockers.push({ code: "UNCOVERED_GAP_ACCEPTANCE_REQUIRED", message: "Подтвердите включение непокрытого кассового разрыва в отчет CFO." });
  }
  return {
    canConfirm: blockers.length === 0,
    blockers,
    qualityCounts: counts,
    maximumFinancingNeedMinor: (run.outputs?.calendar ?? []).reduce((maximum, day) => Math.max(maximum, money(day.financingNeedMinor)), 0),
    appliedCoverageMinor: actions.reduce((sum, action) => sum + money(action.appliedAmountMinor), 0),
    totalCostMinor: money(run.outputs?.funding?.totalCostMinor),
    uncoveredNeedMinor,
    incompleteSources,
    unavailableSources,
    requiresUncoveredAcceptance: uncoveredNeedMinor > 0
  };
}

export function emptySignOff() {
  return {
    reconciliation: { status: SIGN_OFF_STATUS.RECONCILIATION_PENDING, confirmation: null },
    cfoReport: { status: SIGN_OFF_STATUS.CFO_PENDING, confirmation: null }
  };
}

function confirmation(run, operator, clock, extra = {}) {
  const identity = String(operator ?? "").trim();
  if (!identity) throw new RunTransactionError("Укажите имя или роль оператора.", "OPERATOR_REQUIRED");
  return {
    operator: identity,
    confirmedAt: requireTimestamp(clock(), "confirmedAt"),
    runId: run.runId,
    qualityCounts: qualityCounts(run),
    ...extra
  };
}

export class AuditRunController {
  constructor({ runIdFactory = defaultRunIdFactory, clock = defaultClock } = {}) {
    this.runIdFactory = runIdFactory;
    this.clock = clock;
    this.reset();
  }

  reset() {
    this.status = RUN_STATUS.UNCOMPUTED;
    this.staged = null;
    this.committed = null;
    this.error = null;
    this.staleReason = null;
    this.visibleRunIsPrevious = false;
  }

  stage(data, metadata = {}) {
    requireObject(data, "staged data");
    if (this.committed) this.committed.signOff = emptySignOff();
    this.staged = {
      data,
      metadata: { ...metadata },
      stagedAt: requireTimestamp(this.clock(), "stagedAt")
    };
    this.status = RUN_STATUS.STAGED;
    this.error = null;
    this.staleReason = null;
    this.visibleRunIsPrevious = Boolean(this.committed);
    return this.staged;
  }

  begin() {
    if (!this.staged) throw new RunTransactionError("Нет подготовленных данных для расчета.", "NO_STAGED_DATA");
    this.status = RUN_STATUS.RUNNING;
    this.error = null;
    this.visibleRunIsPrevious = Boolean(this.committed);
    return this.staged;
  }

  commit(payload) {
    if (this.status !== RUN_STATUS.RUNNING || !this.staged) {
      throw new RunTransactionError("Commit разрешен только для выполняющегося staged-запуска.", "INVALID_COMMIT_STATE");
    }
    const checked = validateRunPayload(payload);
    const runId = String(this.runIdFactory());
    if (!runId) throw new RunTransactionError("runId не может быть пустым.");
    const run = {
      runId,
      createdAt: requireTimestamp(this.clock(), "createdAt"),
      asOfDate: checked.asOfDate,
      scenario: checked.scenario,
      horizonDays: checked.horizonDays,
      currency: checked.currency,
      versions: { ...checked.versions },
      sources: checked.sources,
      qualityReport: checked.qualityReport,
      inputs: checked.inputs,
      outputs: checked.outputs,
      signOff: emptySignOff()
    };
    this.committed = run;
    this.staged = null;
    this.status = RUN_STATUS.CURRENT;
    this.error = null;
    this.staleReason = null;
    this.visibleRunIsPrevious = false;
    return run;
  }

  fail(error, { clearStaged = true } = {}) {
    this.error = error instanceof Error ? error.message : String(error ?? "Неизвестная ошибка расчета.");
    if (clearStaged) this.staged = null;
    this.status = RUN_STATUS.ERROR;
    this.visibleRunIsPrevious = Boolean(this.committed);
    return this.view();
  }

  markStale(reason = "Расчетные входы изменены.") {
    if (!this.committed) return this.view();
    this.committed.signOff = emptySignOff();
    this.status = this.staged ? RUN_STATUS.STAGED : RUN_STATUS.STALE;
    this.staleReason = reason;
    this.visibleRunIsPrevious = true;
    return this.view();
  }

  restore(run) {
    requireObject(run, "run");
    if (!String(run.runId ?? "").trim()) throw new RunTransactionError("Импортируемый run не содержит runId.");
    validateRunPayload(run);
    this.committed = { ...run, signOff: run.signOff ?? emptySignOff() };
    this.staged = null;
    this.status = RUN_STATUS.CURRENT;
    this.error = null;
    this.staleReason = null;
    this.visibleRunIsPrevious = false;
    return this.committed;
  }

  confirmReconciliation(operator) {
    if (!this.committed || this.status !== RUN_STATUS.CURRENT) {
      throw new RunTransactionError("Подтверждение сверки доступно только для актуального committed run.", "NO_CURRENT_RUN");
    }
    this.committed.signOff = {
      reconciliation: {
        status: SIGN_OFF_STATUS.RECONCILIATION_CONFIRMED,
        confirmation: confirmation(this.committed, operator, this.clock)
      },
      cfoReport: { status: SIGN_OFF_STATUS.CFO_PENDING, confirmation: null }
    };
    return this.committed.signOff;
  }

  confirmCfoReport(operator, { uncoveredGapAccepted = false } = {}) {
    if (!this.committed || this.status !== RUN_STATUS.CURRENT) {
      throw new RunTransactionError("Подготовка отчета CFO доступна только для актуального committed run.", "NO_CURRENT_RUN");
    }
    const readiness = getCfoReadiness(this.committed, { uncoveredGapAccepted });
    if (!readiness.canConfirm) {
      const blocker = readiness.blockers[0];
      throw new RunTransactionError(blocker.message, blocker.code);
    }
    this.committed.signOff = {
      ...this.committed.signOff,
      cfoReport: {
        status: SIGN_OFF_STATUS.CFO_READY,
        confirmation: confirmation(this.committed, operator, this.clock, {
          uncoveredGapAccepted: readiness.requiresUncoveredAcceptance ? true : false,
          fundingSummary: {
            maximumFinancingNeedMinor: readiness.maximumFinancingNeedMinor,
            appliedCoverageMinor: readiness.appliedCoverageMinor,
            totalCostMinor: readiness.totalCostMinor,
            uncoveredNeedMinor: readiness.uncoveredNeedMinor,
            incompleteSources: readiness.incompleteSources,
            unavailableSources: readiness.unavailableSources
          }
        })
      }
    };
    return this.committed.signOff;
  }

  view() {
    return {
      status: this.status,
      staged: this.staged,
      committed: this.committed,
      error: this.error,
      staleReason: this.staleReason,
      visibleRunIsPrevious: this.visibleRunIsPrevious
    };
  }
}

import { clamp, daysBetween, formatDateInput } from "./src/domain/date.js";
import { buildForecast as buildForecastDomain } from "./src/domain/forecast.js";
import { simulateFundingCoverage } from "./src/domain/funding.js";
import { compareAuditRuns } from "./src/domain/comparison.js";
import { applyBankUpdateToPriorLedger, canonicalLedgerForRun } from "./src/domain/daily-ledger.js";
import { buildOperatorBrief } from "./src/domain/operator-brief.js";
import { AuditRunController, MODEL_VERSIONS, RUN_STATUS, SIGN_OFF_STATUS, getCfoReadiness } from "./src/domain/run.js";
import { scoreReceipt as scoreReceiptDomain } from "./src/domain/timing-model.js";
import { normalizeDate, parseOutflows, parseReceipts } from "./src/io/schema.js";
import {
  SnapshotValidationError,
  createAuditSnapshot,
  parseAuditSnapshot,
  sha256Hex
} from "./src/io/snapshot.js";
import { ExcelIntakeError, readExcelFile } from "./src/io/xlsx.js";
import { buildCommittedRunCsv } from "./src/io/csv.js";
import {
  createElement,
  createPill,
  createSvgElement,
  createTableCell,
  createTextElement,
  replaceChildren
} from "./src/ui/render.js";

const RUB = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0
});

const DATE = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short" });
const MOSCOW_DATE_TIME = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit"
});

const demoForecastStartDate = new Date("2026-06-30T00:00:00");
let forecastStartDate = new Date(demoForecastStartDate);

function createFundingState() {
  return {
    liquidityReserve: 0,
    reserveAvailableDate: null,
    reserveLeadDays: 0,
    reserveTermDays: null,
    reserveRatePct: null,
    reserveMinDraw: 0,
    paymentMoveDays: null,
    paymentMoveCost: null,
    factoringLimit: 0,
    factoringAvailableDate: null,
    factoringLeadDays: null,
    factoringTermDays: null,
    factoringFeePct: null,
    factoringMinDraw: 0,
    overdraftLimit: 0,
    overdraftAvailableDate: null,
    overdraftLeadDays: null,
    overdraftTermDays: null,
    overdraftRatePct: null,
    overdraftMinDraw: 0,
    creditLineLimit: 0,
    creditLineAvailableDate: null,
    creditLineLeadDays: null,
    creditLineTermDays: null,
    creditLineRatePct: null,
    creditLineMinDraw: 0
  };
}

const state = {
  scenario: "p50",
  stress: false,
  openingBalance: 500_000,
  funding: createFundingState(),
  receipts: [],
  outflows: [],
  canonicalLedger: null,
  dataSources: [{ type: "demo", name: "Модель ООО Ромашка" }],
  importReport: {
    errors: [],
    warnings: [],
    summary: "Используются демо-данные."
  }
};

const runController = new AuditRunController();
let priorSnapshot = null;
let selectedPriorLedger = null;
let fundingProvenance = { inputSource: "Ручной ввод в интерфейсе", sourceRunId: null, sourceCreatedAt: null, sourceAsOfDate: null };

const scenarioLabels = {
  p50: "Базовый P50",
  p80: "С запасом P80",
  p90: "Консервативный P90",
  stress: "Стресс"
};

function scenarioLabel(scenario) {
  return scenarioLabels[scenario] ?? scenario.toUpperCase();
}

const intakeItems = [
  ["1C / ERP: ДЗ по контрагентам", "Остатки, дата возникновения, договорный срок, просрочка, ответственный менеджер."],
  ["1C / ERP: счета, реализации и акты", "Номер, сумма, плановая дата оплаты, договор, контрагент, статус закрывающих документов."],
  ["Договорные условия постоплаты", "Срок отсрочки 15-90 дней, лимиты, штрафы, особые условия по крупным клиентам."],
  ["Банк: поступления за 6-12 месяцев", "Фактическая дата оплаты, назначение, сумма, связка со счетом или актом."],
  ["CRM / продажи: контекст клиента", "Ответственный, стадия коммуникации, обещанная дата оплаты, спорные документы."],
  ["Платежный календарь и лимиты", "Плановые входящие, обязательные исходящие, остаток денег, резерв, овердрафт, факторинг, кредитная линия."]
];

const demoReceipts = [
  ["invoice_id","counterparty","amount","planned_date","due_days","avg_delay","late_5","late_10","late_30","open_ar","documents_ok","bank_match","history_delays"],
  ["ROM-POSTPAY-001","ООО Ромашка",500000,"2026-06-30",30,10,0.8,0.4,0.2,500000,true,true,"0;1;4;14;30"]
];

const demoOutflows = [
  ["date","category","amount","criticality"]
];

function parseCsv(text) {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(",").map((cell) => cell.trim()));
}

function loadDemo() {
  forecastStartDate = new Date(demoForecastStartDate);
  state.scenario = "p50";
  state.stress = false;
  state.openingBalance = 500_000;
  state.funding = createFundingState();
  fundingProvenance = { inputSource: "Ручной ввод в интерфейсе", sourceRunId: null, sourceCreatedAt: null, sourceAsOfDate: null };
  state.receipts = parseReceipts(demoReceipts, forecastStartDate);
  state.outflows = parseOutflows(demoOutflows, forecastStartDate);
  state.canonicalLedger = null;
  state.dataSources = [{ type: "demo", name: "Модель ООО Ромашка" }];
  syncBalanceControls("Модель ООО Ромашка: стартовый остаток 500 000 руб., дата старта 30 июня 2026.");
  syncFundingControls();
  const excelInput = document.querySelector("#excelInput");
  if (excelInput) {
    excelInput.value = "";
  }
  const fileName = document.querySelector("#selectedFileName");
  if (fileName) fileName.textContent = "Добавьте Excel для расчета";
  setUploadStatus("Поступления, обязательные платежи и стартовый остаток.", "neutral");
  resetImportReport("Демо-пример: июнь 2026. Для реального аудита загрузите выгрузку или задайте дату и остаток вручную.");
}

function syncBalanceControls(sourceText) {
  const dateInput = document.querySelector("#startDateInput");
  const balanceInput = document.querySelector("#openingBalanceInput");
  const source = document.querySelector("#openingBalanceSource");
  if (dateInput) dateInput.value = formatDateInput(forecastStartDate);
  if (balanceInput) balanceInput.value = String(Math.round(state.openingBalance));
  if (source) source.textContent = sourceText;
}

function syncFundingControls() {
  const bindings = {
    liquidityReserveInput: state.funding.liquidityReserve,
    reserveAvailableDateInput: state.funding.reserveAvailableDate,
    reserveLeadDaysInput: state.funding.reserveLeadDays,
    reserveTermDaysInput: state.funding.reserveTermDays,
    reserveRatePctInput: state.funding.reserveRatePct,
    reserveMinDrawInput: state.funding.reserveMinDraw,
    paymentMoveDaysInput: state.funding.paymentMoveDays,
    paymentMoveCostInput: state.funding.paymentMoveCost,
    factoringLimitInput: state.funding.factoringLimit,
    factoringAvailableDateInput: state.funding.factoringAvailableDate,
    factoringLeadDaysInput: state.funding.factoringLeadDays,
    factoringTermDaysInput: state.funding.factoringTermDays,
    factoringFeePctInput: state.funding.factoringFeePct,
    factoringMinDrawInput: state.funding.factoringMinDraw,
    overdraftLimitInput: state.funding.overdraftLimit,
    overdraftAvailableDateInput: state.funding.overdraftAvailableDate,
    overdraftLeadDaysInput: state.funding.overdraftLeadDays,
    overdraftTermDaysInput: state.funding.overdraftTermDays,
    overdraftRatePctInput: state.funding.overdraftRatePct,
    overdraftMinDrawInput: state.funding.overdraftMinDraw,
    creditLineLimitInput: state.funding.creditLineLimit,
    creditLineAvailableDateInput: state.funding.creditLineAvailableDate,
    creditLineLeadDaysInput: state.funding.creditLineLeadDays,
    creditLineTermDaysInput: state.funding.creditLineTermDays,
    creditLineRatePctInput: state.funding.creditLineRatePct,
    creditLineMinDrawInput: state.funding.creditLineMinDraw
  };
  Object.entries(bindings).forEach(([id, value]) => {
    const input = document.querySelector(`#${id}`);
    if (!input) return;
    input.value = value instanceof Date ? formatDateInput(value) : value === null ? "" : String(value);
  });
}

function rublesToMinor(value) {
  return Math.round(Math.max(0, Number(value) || 0) * 100);
}

function percentToBps(value) {
  return value === null || value === "" ? null : Math.round(Number(value) * 100);
}

function fundingSources(funding = state.funding, asOfDate = forecastStartDate) {
  const common = { ...fundingProvenance };
  return [
    {
      ...common,
      id: "reserve",
      type: "reserve",
      name: "Резерв ликвидности",
      priority: 1,
      limitMinor: rublesToMinor(funding.liquidityReserve),
      availabilityDate: funding.reserveAvailableDate,
      leadTimeDays: funding.reserveLeadDays,
      termDays: funding.reserveTermDays,
      annualRateBps: percentToBps(funding.reserveRatePct),
      minDrawMinor: rublesToMinor(funding.reserveMinDraw),
      constraints: ["В пределах подтвержденного свободного резерва"]
    },
    {
      ...common,
      id: "payment-move",
      type: "payment-move",
      name: "Перенос некритичных платежей",
      priority: 2,
      availabilityDate: asOfDate,
      leadTimeDays: 0,
      maxMoveDays: funding.paymentMoveDays,
      fixedCostMinor: funding.paymentMoveCost === null ? null : rublesToMinor(funding.paymentMoveCost),
      constraints: ["Только платежи с критичностью moveable"]
    },
    {
      ...common,
      id: "factoring",
      type: "factoring",
      name: "Факторинг",
      priority: 3,
      limitMinor: rublesToMinor(funding.factoringLimit),
      availabilityDate: funding.factoringAvailableDate,
      leadTimeDays: funding.factoringLeadDays,
      termDays: funding.factoringTermDays,
      feeBps: percentToBps(funding.factoringFeePct),
      minDrawMinor: rublesToMinor(funding.factoringMinDraw),
      constraints: ["Документы в порядке", "Банковский матчинг подтвержден"]
    },
    {
      ...common,
      id: "overdraft",
      type: "overdraft",
      name: "Овердрафт",
      priority: 4,
      limitMinor: rublesToMinor(funding.overdraftLimit),
      availabilityDate: funding.overdraftAvailableDate,
      leadTimeDays: funding.overdraftLeadDays,
      termDays: funding.overdraftTermDays,
      annualRateBps: percentToBps(funding.overdraftRatePct),
      minDrawMinor: rublesToMinor(funding.overdraftMinDraw),
      constraints: ["В пределах доступного банковского лимита"]
    },
    {
      ...common,
      id: "credit-line",
      type: "credit-line",
      name: "Кредитная линия",
      priority: 5,
      limitMinor: rublesToMinor(funding.creditLineLimit),
      availabilityDate: funding.creditLineAvailableDate,
      leadTimeDays: funding.creditLineLeadDays,
      termDays: funding.creditLineTermDays,
      annualRateBps: percentToBps(funding.creditLineRatePct),
      minDrawMinor: rublesToMinor(funding.creditLineMinDraw),
      constraints: ["В пределах подтвержденного лимита кредитной линии"]
    }
  ];
}

function dateOnly(value) {
  return value instanceof Date ? formatDateInput(value) : String(value ?? "");
}

function receiptToRunInput(receipt) {
  const amountMinor = Number.isSafeInteger(receipt.remainingAmountMinor)
    ? receipt.remainingAmountMinor
    : Number.isSafeInteger(receipt.amountMinor)
      ? receipt.amountMinor
      : rublesToMinor(receipt.amount);
  return {
    id: receipt.id,
    counterpartyId: receipt.counterpartyId ?? null,
    counterparty: receipt.counterparty,
    amountMinor,
    remainingAmountMinor: amountMinor,
    openArMinor: Number.isSafeInteger(receipt.openArMinor) ? receipt.openArMinor : rublesToMinor(receipt.openAr),
    plannedDate: dateOnly(receipt.plannedDate),
    dueDays: receipt.dueDays ?? 0,
    avgDelay: receipt.avgDelay ?? null,
    late5: receipt.late5 ?? 0,
    late10: receipt.late10 ?? 0,
    late30: receipt.late30 ?? 0,
    documentsOk: receipt.documentsOk !== false,
    bankMatch: receipt.bankMatch !== false,
    historyTotal: receipt.historyTotal ?? null,
    historyOnTime: receipt.historyOnTime ?? null,
    historyAvgDelay: receipt.historyAvgDelay ?? null,
    historyWorstDelay: receipt.historyWorstDelay ?? null,
    historyDelays: [...(receipt.historyDelays ?? [])],
    portfolioDelays: [...(receipt.portfolioDelays ?? [])],
    managerPromise: receipt.managerPromise ?? null,
    manualException: receipt.manualException ?? null
  };
}

function outflowToRunInput(outflow, index) {
  const effectiveDate = outflow.effectiveDate ?? outflow.date;
  return {
    outflowId: outflow.outflowId ?? `outflow-${index + 1}`,
    category: outflow.category,
    amountMinor: Number.isSafeInteger(outflow.amountMinor) ? outflow.amountMinor : rublesToMinor(outflow.amount),
    effectiveDate: dateOnly(effectiveDate),
    criticality: outflow.criticality ?? "must-pay"
  };
}

function fundingSourceToRunInput(source) {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [
    key,
    value instanceof Date ? dateOnly(value) : Array.isArray(value) ? [...value] : value
  ]));
}

function buildRunInputs({ receipts, outflows, asOfDate, openingBalance, funding, scenario, canonicalLedger }) {
  const inputs = {
    asOfDate: dateOnly(asOfDate),
    scenario,
    horizonDays: 30,
    currency: "RUB",
    openingBalanceMinor: canonicalLedger?.openingBalanceMinor ?? rublesToMinor(openingBalance),
    receipts: receipts.map(receiptToRunInput),
    outflows: outflows.map(outflowToRunInput),
    fundingSources: fundingSources(funding, asOfDate).map(fundingSourceToRunInput)
  };
  if (canonicalLedger) inputs.canonicalLedger = canonicalLedger;
  return inputs;
}

function hydrateRunInputs(inputs) {
  const asOfDate = normalizeDate(inputs.asOfDate);
  if (!asOfDate) throw new Error("Файл расчета содержит некорректную дату данных.");
  const receipts = inputs.receipts.map((receipt) => {
    const plannedDate = normalizeDate(receipt.plannedDate);
    if (!plannedDate) throw new Error(`Файл расчета: некорректная дата ДЗ ${receipt.id}.`);
    return {
      ...receipt,
      amount: receipt.amountMinor / 100,
      openAr: receipt.openArMinor / 100,
      plannedDate
    };
  });
  const outflows = inputs.outflows.map((outflow) => {
    const effectiveDate = normalizeDate(outflow.effectiveDate);
    if (!effectiveDate) throw new Error(`Файл расчета: некорректная дата платежа ${outflow.outflowId}.`);
    return { ...outflow, amount: outflow.amountMinor / 100, date: effectiveDate, effectiveDate };
  });
  const sources = inputs.fundingSources.map((source) => ({
    ...source,
    availabilityDate: normalizeDate(source.availabilityDate)
  }));
  return { ...inputs, asOfDate, receipts, outflows, fundingSources: sources };
}

function fundingStateFromSources(sources) {
  const next = createFundingState();
  const byType = Object.fromEntries(sources.map((source) => [source.type, source]));
  const reserve = byType.reserve;
  if (reserve) {
    next.liquidityReserve = reserve.limitMinor / 100;
    next.reserveAvailableDate = reserve.availabilityDate;
    next.reserveLeadDays = reserve.leadTimeDays;
    next.reserveTermDays = reserve.termDays;
    next.reserveRatePct = reserve.annualRateBps === null ? null : reserve.annualRateBps / 100;
    next.reserveMinDraw = reserve.minDrawMinor / 100;
  }
  const move = byType["payment-move"];
  if (move) {
    next.paymentMoveDays = move.maxMoveDays;
    next.paymentMoveCost = move.fixedCostMinor === null ? null : move.fixedCostMinor / 100;
  }
  const factoring = byType.factoring;
  if (factoring) {
    next.factoringLimit = factoring.limitMinor / 100;
    next.factoringAvailableDate = factoring.availabilityDate;
    next.factoringLeadDays = factoring.leadTimeDays;
    next.factoringTermDays = factoring.termDays;
    next.factoringFeePct = factoring.feeBps === null ? null : factoring.feeBps / 100;
    next.factoringMinDraw = factoring.minDrawMinor / 100;
  }
  [["overdraft", "overdraft"], ["credit-line", "creditLine"]].forEach(([type, prefix]) => {
    const source = byType[type];
    if (!source) return;
    next[`${prefix}Limit`] = source.limitMinor / 100;
    next[`${prefix}AvailableDate`] = source.availabilityDate;
    next[`${prefix}LeadDays`] = source.leadTimeDays;
    next[`${prefix}TermDays`] = source.termDays;
    next[`${prefix}RatePct`] = source.annualRateBps === null ? null : source.annualRateBps / 100;
    next[`${prefix}MinDraw`] = source.minDrawMinor / 100;
  });
  return next;
}

function scoreReceiptForRun(receipt, receipts, asOfDate) {
  const portfolioDelays = receipt.portfolioDelays?.length
    ? receipt.portfolioDelays
    : receipts.filter((item) => item.counterparty !== receipt.counterparty).flatMap((item) => item.historyDelays ?? []);
  return scoreReceiptDomain(receipt, { formatDate: dateOnly, asOfDate, portfolioDelays });
}

function fundingActionOutput(action) {
  return {
    sourceId: action.sourceId,
    type: action.type,
    name: action.name,
    status: action.status,
    reason: action.reason,
    targetId: action.targetId ?? null,
    targetIds: action.targetIds ?? [],
    appliedAmountMinor: action.appliedAmountMinor,
    effectiveDate: action.effectiveDateIso,
    movedToDate: action.movedToDateIso ?? null,
    repaymentDate: action.repaymentDateIso ?? null,
    termDays: action.termDays,
    costMinor: action.costMinor,
    costFormula: action.costFormula,
    limitMinor: action.limitMinor,
    usedLimitMinor: action.usedLimitMinor,
    remainingLimitMinor: action.remainingLimitMinor,
    constraints: action.constraints,
    inputSource: action.inputSource,
    remainingGapMinor: action.remainingGapMinor,
    affectedDates: action.affectedDates
  };
}

function calculateRun(inputs) {
  const hydrated = hydrateRunInputs(inputs);
  const scored = hydrated.receipts.map((receipt) => scoreReceiptForRun(receipt, hydrated.receipts, hydrated.asOfDate));
  const forecast = buildForecastDomain({
    scored,
    scenario: hydrated.scenario,
    forecastStartDate: hydrated.asOfDate,
    horizonDays: hydrated.horizonDays,
    outflows: hydrated.outflows,
    openingBalanceMinor: hydrated.openingBalanceMinor
  });
  const funding = simulateFundingCoverage({
    forecast,
    receipts: scored,
    outflows: hydrated.outflows,
    sources: hydrated.fundingSources,
    asOfDate: hydrated.asOfDate,
    scenario: hydrated.scenario
  });
  const outputs = {
    scenarioDates: scored.map((receipt) => ({
      id: receipt.id,
      plannedDate: dateOnly(receipt.plannedDate),
      p50Date: dateOnly(receipt.p50Date),
      p80Date: dateOnly(receipt.p80Date),
      p90Date: dateOnly(receipt.p90Date),
      stressDate: dateOnly(receipt.stressDate),
      p50Delay: receipt.p50Delay,
      p80Delay: receipt.p80Delay,
      p90Delay: receipt.p90Delay,
      stressDelay: receipt.stressDelay,
      modelSource: receipt.modelSource,
      noOwnHistory: receipt.noOwnHistory
    })),
    calendar: forecast.map((day) => ({
      date: day.dateIso,
      openingBalanceMinor: day.openingBalanceMinor,
      plannedInMinor: day.plannedInMinor,
      scenarioInflowMinor: day.scenarioInflowMinor,
      outflowMinor: day.outflowMinor,
      closingBalanceMinor: day.closingBalanceMinor,
      financingNeedMinor: day.financingNeedMinor
    })),
    excludedEvents: forecast.report.excluded.map((item) => ({ ...item, date: item.dateIso })),
    funding: {
      actions: funding.actions.map(fundingActionOutput),
      totalCostMinor: funding.totalCostMinor,
      uncoveredNeedMinor: funding.uncoveredNeedMinor,
      affectedDates: funding.affectedDates,
      fullyCovered: funding.fullyCovered
    }
  };
  return { hydrated, scored, forecast, funding, outputs };
}

function currentCandidate(sourceOverride = null) {
  const staged = sourceOverride ?? runController.view().staged?.data;
  return {
    receipts: staged?.receipts ?? state.receipts,
    outflows: staged?.outflows ?? state.outflows,
    asOfDate: staged?.asOfDate ?? forecastStartDate,
    openingBalance: staged?.openingBalance ?? state.openingBalance,
    funding: state.funding,
    scenario: state.scenario,
    dataSources: staged?.dataSources ?? state.dataSources,
    qualityReport: staged?.qualityReport ?? state.importReport,
    canonicalLedger: staged && Object.hasOwn(staged, "canonicalLedger") ? staged.canonicalLedger : state.canonicalLedger
  };
}

function applyCommittedInputs(inputs, dataSources, qualityReport) {
  const hydrated = hydrateRunInputs(inputs);
  forecastStartDate = hydrated.asOfDate;
  state.scenario = hydrated.scenario;
  state.stress = hydrated.scenario === "stress";
  state.openingBalance = hydrated.openingBalanceMinor / 100;
  state.receipts = hydrated.receipts;
  state.outflows = hydrated.outflows;
  state.canonicalLedger = inputs.canonicalLedger ?? null;
  state.funding = fundingStateFromSources(hydrated.fundingSources);
  const provenanceSource = hydrated.fundingSources.find((source) => source.sourceRunId || source.inputSource);
  fundingProvenance = provenanceSource ? {
    inputSource: provenanceSource.inputSource ?? "Файл расчета",
    sourceRunId: provenanceSource.sourceRunId ?? null,
    sourceCreatedAt: provenanceSource.sourceCreatedAt ?? null,
    sourceAsOfDate: provenanceSource.sourceAsOfDate ?? null
  } : { inputSource: "Ручной ввод в интерфейсе", sourceRunId: null, sourceCreatedAt: null, sourceAsOfDate: null };
  state.dataSources = dataSources;
  state.importReport = qualityReport;
  const bankSource = dataSources.findLast((source) => source.bankBalanceCloseDate && !source.inheritedFromRunId);
  syncBalanceControls(bankSource
    ? `Банк: остаток на конец ${bankSource.bankBalanceCloseDate}; дата расчета ${inputs.asOfDate}. Получено ${bankSource.observedAt}.`
    : "Источник: последний успешно зафиксированный расчет.");
  syncFundingControls();
  setScenario(state.scenario);
}

const runStatusLabels = {
  [RUN_STATUS.UNCOMPUTED]: ["Данные не рассчитаны", "neutral"],
  [RUN_STATUS.STAGED]: ["Данные подготовлены", "prepared"],
  [RUN_STATUS.RUNNING]: ["Расчет выполняется", "running"],
  [RUN_STATUS.CURRENT]: ["Расчет актуален", "current"],
  [RUN_STATUS.STALE]: ["Результат устарел", "stale"],
  [RUN_STATUS.ERROR]: ["Ошибка расчета", "error"]
};

function briefDate(value) {
  const date = normalizeDate(value);
  return date ? DATE.format(date) : value ?? "не указана";
}

function renderOperatorBrief() {
  const container = document.querySelector("#operatorBriefContent");
  const mode = document.querySelector("#briefMode");
  if (!container) return;
  const view = runController.view();
  const brief = buildOperatorBrief(view.committed, priorSnapshot?.run ?? null);
  if (!brief) {
    if (mode) mode.textContent = "Нет расчета";
    replaceChildren(container, [createTextElement(document, "p", "Загрузите данные и выполните расчет.", { className: "empty-state" })]);
    return;
  }
  if (mode) mode.textContent = brief.isDemo ? "Демо" : view.visibleRunIsPrevious ? "Предыдущий расчет" : "Зафиксированный расчет";
  const sourceLine = brief.bank
    ? `Банк: остаток на конец ${briefDate(brief.bank.closeDate)}; получен ${brief.bank.observedAt ? `${MOSCOW_DATE_TIME.format(new Date(brief.bank.observedAt))} МСК` : "без времени получения"}. Не внутридневной остаток.`
    : "Банковский факт не подключен. Остаток взят из демо, Excel или интерфейса.";
  const planningLine = brief.planning
    ? `ДЗ и исходящие: срез ${briefDate(brief.planning.asOfDate)} · ${brief.planning.ageWorkingDays} раб. дн. назад${brief.planning.inheritedFromRunId ? " · перенесен из прошлого расчета" : ""}.`
    : "Дата обновления ДЗ и исходящих не подтверждена.";
  const status = createElement(document, "div", { className: "operator-brief-status" },
    createTextElement(document, "strong", `${briefDate(brief.asOfDate)} · ${scenarioLabel(brief.scenario)}`),
    createTextElement(document, "small", `Run ${brief.runId} · ${brief.currency}`),
    createTextElement(document, "span", sourceLine),
    createTextElement(document, "span", planningLine));
  if (brief.forecastStatus === "requires-planning-update") {
    const blocker = createElement(document, "div", { className: "operator-brief-blocker", role: "alert" },
      createTextElement(document, "strong", "Требует обновления"),
      createTextElement(document, "span", `Плановые ДЗ и исходящие старше ${brief.planning.maxAgeWorkingDays} рабочих дней.`),
      createTextElement(document, "span", "Загрузите свежую полную книгу. Прогноз на устаревших плановых данных не считается актуальным."));
    replaceChildren(container, [status, blocker]);
    return;
  }
  const gapLabel = brief.firstGapDate
    ? `${briefDate(brief.firstGapDate)}${brief.riskWindowEndDate && brief.riskWindowEndDate !== brief.firstGapDate ? ` — ${briefDate(brief.riskWindowEndDate)}` : ""}`
    : "Не обнаружен";
  const metric = (label, value, note) => createElement(document, "div", { className: "operator-brief-metric" },
    createTextElement(document, "span", label), createTextElement(document, "strong", value), createTextElement(document, "small", note));
  const metrics = createElement(document, "div", { className: "operator-brief-metrics" },
    metric(brief.openingBalanceIsBankFact ? "Входящий остаток банка" : "Стартовый остаток", formatMinorMoney(brief.openingBalanceMinor), brief.openingBalanceIsBankFact ? "На конец предыдущего банковского дня" : "Не подтвержден банком"),
    metric("Ближайший разрыв", gapLabel, brief.firstGapDate ? `По ${scenarioLabel(brief.scenario)}; максимум ${formatMinorMoney(brief.maximumNeedMinor)} ${briefDate(brief.peakDate)}` : `По ${scenarioLabel(brief.scenario)} на горизонте расчета`),
    metric("Покрытие и стоимость", `${brief.actions.length} действий · ${formatMinorMoney(brief.coverageCostMinor)}`, brief.actions.length ? "Примененный план" : "Действия не применены"),
    metric("Не покрыто", formatMinorMoney(brief.uncoveredNeedMinor), brief.uncoveredNeedMinor ? "Требует решения CFO" : "По выбранному сценарию"));
  const review = brief.quality.needsReview
    ? createElement(document, "div", { className: "operator-brief-review" },
      createTextElement(document, "strong", "Требует проверки"),
      createTextElement(document, "span", `Ошибки ${brief.quality.errors} · поступления без ДЗ ${brief.quality.unmatchedPayments} · распределения на проверке ${brief.quality.pendingAllocations}`),
      createTextElement(document, "span", "Перед отчетом CFO проверьте сверку и качество данных."))
    : createTextElement(document, "p", "Ошибок и операций для ручной сверки нет.", { className: "operator-brief-clear" });
  const causes = createElement(document, "details", { className: "operator-brief-detail" },
    createTextElement(document, "summary", `Почему возникает разрыв · ${brief.causes.length} задержанных поступлений`),
    brief.causes.length
      ? createElement(document, "ul", {}, ...brief.causes.map((item) => createTextElement(document, "li", `${item.counterparty} · ${formatMinorMoney(item.amountMinor)} · план ${briefDate(item.plannedDate)}, сценарная дата ${briefDate(item.cashDate)}`)))
      : createTextElement(document, "p", brief.firstGapDate ? "На дату разрыва нет задержанных поступлений из текущей ДЗ. Проверьте исходящие платежи и входящий остаток." : "Разрыва по выбранному сценарию нет."),
    brief.gapOutflows.length ? createElement(document, "ul", {}, ...brief.gapOutflows.map((item) => createTextElement(document, "li", `Списание: ${item.category} · ${formatMinorMoney(item.amountMinor)}`))) : null);
  const plan = createElement(document, "details", { className: "operator-brief-detail" },
    createTextElement(document, "summary", "План покрытия"),
    brief.actions.length
      ? createElement(document, "ul", {}, ...brief.actions.map((item) => createTextElement(document, "li", `${item.name}: ${formatMinorMoney(item.amountMinor)}${item.effectiveDate ? ` с ${briefDate(item.effectiveDate)}` : ""}; стоимость ${formatMinorMoney(item.costMinor)}`)))
      : createTextElement(document, "p", brief.maximumNeedMinor ? "Примененного покрытия нет. Проверьте условия источников на шаге 4." : "Покрытие не требуется по выбранному сценарию."));
  const change = brief.change
    ? createElement(document, "details", { className: "operator-brief-detail" },
      createTextElement(document, "summary", "Изменение к прошлому расчету"),
      createTextElement(document, "p", brief.change.status === "comparable"
        ? `Run ${brief.change.previousRunId} · ${briefDate(brief.change.previousAsOfDate)} · общих дат ${brief.change.commonDates}${brief.change.identityVerified ? "" : " · юрлицо/счета прошлого файла не подтверждены"}.`
        : `Сравнение недоступно: ${brief.change.reason}`),
      brief.change.status === "comparable" ? createElement(document, "dl", {},
        createTextElement(document, "dt", "Входящий остаток"), createTextElement(document, "dd", formatMinorMoney(brief.change.openingBalanceDeltaMinor)),
        createTextElement(document, "dt", "Макс. потребность на общих датах"), createTextElement(document, "dd", formatMinorMoney(brief.change.maxNeedDeltaMinor)),
        createTextElement(document, "dt", "Стоимость покрытия (весь горизонт)"), createTextElement(document, "dd", formatMinorMoney(brief.change.costDeltaMinor)),
        createTextElement(document, "dt", "Не покрыто (весь горизонт)"), createTextElement(document, "dd", formatMinorMoney(brief.change.uncoveredDeltaMinor))) : null)
    : createTextElement(document, "p", "Чтобы увидеть изменение, загрузите предыдущий файл расчета на шаге 2.", { className: "operator-brief-clear" });
  replaceChildren(container, [status, metrics, review, createElement(document, "div", { className: "operator-brief-details" }, causes, plan, change)]);
}

function renderRunStatus() {
  const view = runController.view();
  const brief = buildOperatorBrief(view.committed, priorSnapshot?.run ?? null);
  const planningStale = view.status === RUN_STATUS.CURRENT && brief?.forecastStatus === "requires-planning-update";
  const [label, tone] = planningStale ? ["Требует обновления", "stale"] : runStatusLabels[view.status];
  document.body.dataset.planningFreshness = planningStale ? "stale" : "current";
  const badge = document.querySelector("#runStatusBadge");
  const detail = document.querySelector("#runStatusDetail");
  if (badge) {
    badge.textContent = label;
    badge.dataset.tone = tone;
  }
  if (detail) {
    const run = view.committed;
    detail.textContent = view.error
      ? `${view.error}${run ? ` Предыдущий расчет ${run.runId} сохранен.` : ""}`
      : planningStale
        ? `Run ${view.committed.runId}: плановые ДЗ и исходящие старше ${brief.planning.maxAgeWorkingDays} рабочих дней. Загрузите свежую полную книгу.`
      : view.staleReason
        ? `${view.staleReason} Выполните новый расчет.`
        : view.status === RUN_STATUS.STAGED
          ? `${view.visibleRunIsPrevious ? "Предыдущий расчет остается на экране. " : ""}Данные проверены. Нажмите «Рассчитать прогноз».`
          : run
            ? `Run ${run.runId} · ${run.asOfDate} · ${run.scenario.toUpperCase()}`
            : "Подготовьте данные и выполните расчет.";
  }
  const snapshotButton = document.querySelector("#downloadSnapshotButton");
  if (snapshotButton) snapshotButton.disabled = !view.committed;
  const exportButton = document.querySelector("#exportButton");
  if (exportButton) exportButton.disabled = view.status !== RUN_STATUS.CURRENT || view.committed?.signOff?.cfoReport?.status !== SIGN_OFF_STATUS.CFO_READY;
  const calculateButton = document.querySelector("#calculateRunButton");
  if (calculateButton) calculateButton.disabled = view.status === RUN_STATUS.RUNNING;
  renderSignOff();
  renderQualitySummary();
  renderComparison();
  renderOperatorBrief();
  setWorkflowStep(workflowStep);
}

function signedDetail(confirmation) {
  if (!confirmation) return "Подтверждение не зафиксировано.";
  const counts = confirmation.qualityCounts;
  return `${confirmation.operator} · ${MOSCOW_DATE_TIME.format(new Date(confirmation.confirmedAt))} МСК · Run ${confirmation.runId} · несопоставленных платежей ${counts.unmatchedPayments}, ожидающих распределения ${counts.pendingAllocations}, ошибок ${counts.errors}, предупреждений ${counts.warnings}`;
}

function renderSignOff() {
  const view = runController.view();
  const committed = view.committed;
  const signOff = committed?.signOff;
  const reconciliationConfirmed = signOff?.reconciliation?.status === SIGN_OFF_STATUS.RECONCILIATION_CONFIRMED;
  const cfoReady = signOff?.cfoReport?.status === SIGN_OFF_STATUS.CFO_READY;
  const reconciliationBadge = document.querySelector("#reconciliationSignOffBadge");
  const cfoBadge = document.querySelector("#cfoSignOffBadge");
  if (reconciliationBadge) {
    reconciliationBadge.textContent = reconciliationConfirmed ? "Сверка подтверждена" : "Сверка не подтверждена";
    reconciliationBadge.className = `signoff-badge ${reconciliationConfirmed ? "confirmed" : "pending"}`;
  }
  if (cfoBadge) {
    cfoBadge.textContent = cfoReady ? "Отчет CFO подготовлен" : "Отчет CFO не подготовлен";
    cfoBadge.className = `signoff-badge ${cfoReady ? "confirmed" : "pending"}`;
  }
  const reconciliationDetail = document.querySelector("#reconciliationSignOffDetail");
  const cfoDetail = document.querySelector("#cfoSignOffDetail");
  if (reconciliationDetail) reconciliationDetail.textContent = reconciliationConfirmed
    ? signedDetail(signOff.reconciliation.confirmation)
    : committed ? "Проверьте показатели сверки ниже и подтвердите актуальный расчет." : "Доступно после успешного расчета.";
  if (cfoDetail) cfoDetail.textContent = cfoReady
    ? signedDetail(signOff.cfoReport.confirmation)
    : reconciliationConfirmed ? "Проверьте контроль готовности отчета ниже." : "Сначала подтвердите сверку.";
  const currentBrief = buildOperatorBrief(committed);
  const current = view.status === RUN_STATUS.CURRENT && currentBrief?.forecastStatus !== "requires-planning-update";
  const reconciliationButton = document.querySelector("#confirmReconciliationButton");
  const cfoButton = document.querySelector("#confirmCfoButton");
  const acceptance = document.querySelector("#uncoveredGapAcceptanceInput");
  const acceptanceLabel = document.querySelector("#uncoveredGapAcceptanceLabel");
  if (acceptance && acceptance.dataset.runId !== committed?.runId) {
    acceptance.checked = Boolean(signOff?.cfoReport?.confirmation?.uncoveredGapAccepted);
    acceptance.dataset.runId = committed?.runId ?? "";
  }
  const readiness = getCfoReadiness(committed, { uncoveredGapAccepted: Boolean(acceptance?.checked) });
  if (acceptanceLabel) acceptanceLabel.hidden = !readiness.requiresUncoveredAcceptance;
  if (acceptance) acceptance.disabled = !current || !reconciliationConfirmed || cfoReady;

  const counters = document.querySelector("#reconciliationCounters");
  if (counters) replaceChildren(counters, [
    createTextElement(document, "span", `Поступления банка без ДЗ: ${readiness.qualityCounts.unmatchedPayments}`),
    createTextElement(document, "span", `Нужно распределить вручную: ${readiness.qualityCounts.pendingAllocations}`),
    createTextElement(document, "span", `Ошибки в данных: ${readiness.qualityCounts.errors}`),
    createTextElement(document, "span", `Предупреждения: ${readiness.qualityCounts.warnings}`)
  ]);

  const readinessSummary = document.querySelector("#cfoReadinessSummary");
  if (readinessSummary) {
    const metrics = createElement(document, "dl", { className: "readiness-metrics" },
      createTextElement(document, "dt", "Максимальная потребность"), createTextElement(document, "dd", formatMinorMoney(readiness.maximumFinancingNeedMinor)),
      createTextElement(document, "dt", "Примененное покрытие"), createTextElement(document, "dd", formatMinorMoney(readiness.appliedCoverageMinor)),
      createTextElement(document, "dt", "Стоимость покрытия"), createTextElement(document, "dd", formatMinorMoney(readiness.totalCostMinor)),
      createTextElement(document, "dt", "Непокрытый остаток"), createTextElement(document, "dd", formatMinorMoney(readiness.uncoveredNeedMinor))
    );
    const sourceState = createTextElement(document, "p", `Условия не заполнены: ${readiness.incompleteSources.join(", ") || "нет"}. Недоступные источники: ${readiness.unavailableSources.join(", ") || "нет"}.`);
    const blockers = readiness.blockers.length
      ? createElement(document, "ul", { className: "readiness-blockers" }, ...readiness.blockers.map((item) => createTextElement(document, "li", item.message)))
      : createTextElement(document, "p", "Контроль пройден: отчет можно подтвердить.", { className: "readiness-ok" });
    replaceChildren(readinessSummary, [metrics, sourceState, blockers]);
  }
  if (reconciliationButton) reconciliationButton.disabled = !current || reconciliationConfirmed;
  if (cfoButton) cfoButton.disabled = !current || cfoReady || !readiness.canConfirm;
}

function deltaMoney(item) {
  const prefix = item.deltaMinor > 0 ? "+" : "";
  return `${prefix}${formatMinorMoney(item.deltaMinor)} (${formatMinorMoney(item.previousMinor)} → ${formatMinorMoney(item.currentMinor)})`;
}

function renderComparison() {
  const container = document.querySelector("#comparisonContent");
  if (!container) return;
  renderPriorFundingTransfer();
  renderPriorLedgerChoice();
  const current = runController.view().committed;
  if (!priorSnapshot || !current) {
    replaceChildren(container, [createTextElement(document, "p", priorSnapshot
      ? "Сначала выполните актуальный расчет. Файл предыдущего расчета сохранен для сравнения."
      : "Предыдущий расчет не загружен. Здесь появится сравнение с текущим расчетом.", { className: "empty-state" })]);
    return;
  }
  const result = compareAuditRuns(current, priorSnapshot.run);
  if (!result.compatibility.comparable) {
    replaceChildren(container, [createTextElement(document, "p", `Расчеты не сопоставимы: ${result.compatibility.reasons.join(" ")} Текущий run ${current.runId}; предыдущий run ${priorSnapshot.run.runId}.`, { className: "empty-state" })]);
    return;
  }
  const metrics = [
    ["Входящий остаток", result.metrics.openingBalanceMinor],
    ["Открытая ДЗ", result.metrics.openReceivablesMinor],
    ["Минимальный остаток", result.metrics.minimumClosingBalanceMinor],
    ["Макс. потребность", result.metrics.maximumFinancingNeedMinor],
    ["Стоимость покрытия", result.metrics.coverageCostMinor],
    ["Непокрытый остаток", result.metrics.uncoveredNeedMinor]
  ];
  const header = createElement(document, "div", { className: "comparison-runs" },
    createElement(document, "section", { className: "comparison-run-card comparison-run-card-previous" },
      createTextElement(document, "strong", "Предыдущий расчет"),
      createTextElement(document, "span", `Run ${result.previous.runId}`),
      createTextElement(document, "small", `${MOSCOW_DATE_TIME.format(new Date(result.previous.createdAt))} МСК · дата данных ${result.previous.asOfDate}`)
    ),
    createElement(document, "section", { className: "comparison-run-card comparison-run-card-current" },
      createTextElement(document, "strong", "Текущий расчет"),
      createTextElement(document, "span", `Run ${result.current.runId}`),
      createTextElement(document, "small", `${MOSCOW_DATE_TIME.format(new Date(result.current.createdAt))} МСК · дата данных ${result.current.asOfDate}`)
    )
  );
  const metricGrid = createElement(document, "dl", { className: "comparison-metrics" }, ...metrics.flatMap(([label, value]) => [
    createTextElement(document, "dt", label), createTextElement(document, "dd", deltaMoney(value))
  ]));
  const scope = createTextElement(document, "p", `Общих дат: ${result.commonDates.length}${result.commonDates.length ? ` (${result.commonDates[0]} — ${result.commonDates.at(-1)})` : ""}. Юрлицо: ${result.compatibility.legalEntities.current ?? "не указано"}; счета: ${result.compatibility.accounts.current.length || "не указаны"}; валюта ${result.compatibility.currency}; сценарий ${result.compatibility.scenario}. ${result.compatibility.identityVerified ? "Источники сопоставимы." : "В старом файле не подтверждены юрлицо или счета; сравнение ориентировочное."}`, { className: "comparison-summary" });
  const freshness = createTextElement(document, "p", `Свежесть банка: текущий ${result.compatibility.freshness.current.map((item) => item.closeDate ?? "не указана").join(", ") || "не указана"}; предыдущий ${result.compatibility.freshness.previous.map((item) => item.closeDate ?? "не указана").join(", ") || "не указана"}. Стоимость и непокрытый разрыв относятся ко всему горизонту каждого расчета.`, { className: "comparison-summary" });
  const daily = result.dailyBalances.length
    ? createElement(document, "details", {}, createTextElement(document, "summary", "Остаток и потребность по общим датам"),
      createElement(document, "ul", { className: "comparison-list" }, ...result.dailyBalances.map((item) => createTextElement(document, "li", `${item.date}: остаток ${formatMinorMoney(item.previousMinor)} → ${formatMinorMoney(item.currentMinor)}; потребность ${formatMinorMoney(item.previousNeedMinor)} → ${formatMinorMoney(item.currentNeedMinor)}.`))))
    : createTextElement(document, "p", "Общих дат горизонта нет: ежедневный остаток не сравнивается.", { className: "empty-state" });
  const receiptSummary = createTextElement(document, "p",
    `ДЗ: новых ${result.receivables.new.length}, исчезнувших ${result.receivables.disappeared.length}, измененных ${result.receivables.changed.length}. Контрольных сумм источников изменено: ${result.sourceFingerprintChanges.length}.`,
    { className: "comparison-summary" });
  const receiptSets = createElement(document, "div", { className: "comparison-sets" },
    createTextElement(document, "span", `Новые: ${result.receivables.new.join(", ") || "нет"}`),
    createTextElement(document, "span", `Исчезнувшие: ${result.receivables.disappeared.join(", ") || "нет"}`),
    createTextElement(document, "span", `Измененные: ${result.receivables.changed.map((item) => item.id).join(", ") || "нет"}`),
    createTextElement(document, "span", `Контрольные суммы источников: ${result.sourceFingerprintChanges.map((item) => item.source).join(", ") || "без изменений"}`),
    createTextElement(document, "span", `Коммерческие условия финансирования: изменено источников ${result.fundingInputs.changed.length}, без изменений ${result.fundingInputs.unchangedCount}`)
  );
  const compared = result.receivables.compared.length
    ? createElement(document, "ul", { className: "comparison-list" }, ...result.receivables.compared.map((item) => createTextElement(document, "li",
      `${item.id}${item.changed ? " · изменена" : " · без изменений"}: сумма Δ ${formatMinorMoney(item.openAmountDeltaMinor)}; P50 ${item.dateDelta.p50Date.previousDate} → ${item.dateDelta.p50Date.currentDate} (${item.dateDelta.p50Date.deltaDays ?? "—"} дн.); P80 ${item.dateDelta.p80Date.previousDate} → ${item.dateDelta.p80Date.currentDate}; P90 ${item.dateDelta.p90Date.previousDate} → ${item.dateDelta.p90Date.currentDate}; Stress ${item.dateDelta.stressDate.previousDate} → ${item.dateDelta.stressDate.currentDate}.`)))
    : createTextElement(document, "p", "Общих ДЗ для сравнения нет.", { className: "muted" });
  const fingerprints = result.sourceFingerprintChanges.length
    ? createElement(document, "ul", { className: "comparison-list" }, ...result.sourceFingerprintChanges.map((item) => createTextElement(document, "li", `${item.source}: ${item.previousSha256 ?? "нет"} → ${item.currentSha256 ?? "нет"}`)))
    : null;
  replaceChildren(container, [header, scope, freshness, metricGrid, daily, receiptSummary, receiptSets, compared, fingerprints]);
}

function renderPriorFundingTransfer() {
  const panel = document.querySelector("#priorFundingPanel");
  const summary = document.querySelector("#priorFundingSummary");
  const button = document.querySelector("#applyPriorFundingButton");
  const run = priorSnapshot?.run;
  const sources = run?.inputs?.fundingSources ?? [];
  if (!panel) return;
  panel.hidden = !run;
  if (!run) return;
  if (summary) summary.textContent = `Источник: файл предыдущего расчета · Run ${run.runId} · расчет ${MOSCOW_DATE_TIME.format(new Date(run.createdAt))} МСК · дата данных ${run.asOfDate} · источников ${sources.length}.`;
  if (button) button.disabled = sources.length === 0;
}

function renderPriorLedgerChoice() {
  const button = document.querySelector("#applyPriorLedgerButton");
  const status = document.querySelector("#priorLedgerStatus");
  const run = priorSnapshot?.run;
  const ledger = run?.inputs?.canonicalLedger;
  const eligible = Boolean(ledger?.receivables?.length && ledger?.bankBalances?.length
    && Array.isArray(ledger.payments) && Array.isArray(ledger.allocations) && Array.isArray(ledger.outflows));
  if (button) button.disabled = !eligible;
  if (status) status.textContent = selectedPriorLedger
    ? `База выбрана: run ${selectedPriorLedger.run.runId}, дата данных ${selectedPriorLedger.run.asOfDate}. Загрузите новый Bank + BankBalances; текущий расчет не заменен.`
    : eligible ? `Доступна база run ${run.runId}, дата данных ${run.asOfDate}; перенос только после нажатия кнопки.`
      : run ? "В этом файле нет исходных банковских событий и остатков для ежедневного обновления. Сравнение доступно."
        : "Доступно для файла с сохраненными ДЗ, операциями и остатками. Затем загрузите Bank + BankBalances.";
}

function markRunStale(reason) {
  const acceptance = document.querySelector("#uncoveredGapAcceptanceInput");
  if (acceptance) acceptance.checked = false;
  runController.markStale(reason);
  renderRunStatus();
}

async function executeCurrentRun() {
  const candidate = currentCandidate();
  const inputs = buildRunInputs(candidate);
  runController.stage(candidate, { reason: "manual-run" });
  runController.begin();
  renderRunStatus();
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  try {
    const calculation = calculateRun(inputs);
    const run = runController.commit({
      asOfDate: inputs.asOfDate,
      scenario: inputs.scenario,
      horizonDays: inputs.horizonDays,
      currency: inputs.currency,
      versions: MODEL_VERSIONS,
      sources: candidate.dataSources,
      qualityReport: candidate.qualityReport,
      inputs,
      outputs: calculation.outputs
    });
    applyCommittedInputs(inputs, run.sources, run.qualityReport);
    selectedPriorLedger = null;
    render();
    renderImportReport();
    renderRunStatus();
    return run;
  } catch (error) {
    runController.fail(error);
    renderRunStatus();
    throw error;
  }
}

function setScenario(scenario) {
  const nextScenario = scenarioLabels[scenario] ? scenario : "p50";
  state.scenario = nextScenario;
  state.stress = nextScenario === "stress";

  document.querySelectorAll("[data-scenario]").forEach((button) => {
    button.classList.toggle("active", button.dataset.scenario === nextScenario);
    button.setAttribute("aria-pressed", String(button.dataset.scenario === nextScenario));
  });

  const stressButton = document.querySelector("#stressModeButton");
  if (stressButton) {
    stressButton.classList.toggle("active", state.stress);
    stressButton.setAttribute("aria-pressed", String(state.stress));
    stressButton.title = state.stress ? "Включен стресс-сценарий" : "Переключить стресс-сценарий";
  }
}

function inferForecastStartDate(receipts, outflows) {
  const dates = [
    ...receipts.map((item) => item.plannedDate),
    ...outflows.map((item) => item.date)
  ].filter((date) => date instanceof Date && !Number.isNaN(date.getTime()));
  if (!dates.length) return null;
  return dates.reduce((earliest, date) => date < earliest ? date : earliest, dates[0]);
}

function setUploadStatus(message, tone = "neutral") {
  const status = document.querySelector("#uploadStatus");
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
}

function resetImportReport(summary = "Используются демо-данные.") {
  state.importReport = {
    errors: [],
    warnings: [],
    summary
  };
  renderImportReport();
}

function renderImportReport() {
  const container = document.querySelector("#importReport");
  if (!container) return;

  const { errors, warnings, summary } = state.importReport;
  const tone = errors.length ? "error" : warnings.length ? "warning" : "success";
  const items = [...errors.slice(0, 6), ...warnings.slice(0, 6)];
  const more = errors.length + warnings.length - items.length;

  container.className = `import-report visible ${tone}`;
  container.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = summary;
  container.append(heading);
  if (!items.length) {
    const success = document.createElement("span");
    success.textContent = "Ошибок структуры не найдено.";
    container.append(success);
    return;
  }
  const list = document.createElement("ul");
  items.forEach((item) => {
    const row = document.createElement("li");
    row.textContent = item;
    list.append(row);
  });
  if (more > 0) {
    const row = document.createElement("li");
    row.textContent = `Еще ${more} замечаний. Исправьте первые ошибки и повторите загрузку.`;
    list.append(row);
  }
  container.append(list);
}

function scoreReceipt(receipt) {
  const portfolioDelays = state.receipts
    .filter((item) => item.counterparty !== receipt.counterparty)
    .flatMap((item) => item.historyDelays ?? []);
  return scoreReceiptDomain(receipt, {
    formatDate: (date) => DATE.format(date),
    asOfDate: forecastStartDate,
    portfolioDelays: receipt.portfolioDelays?.length ? receipt.portfolioDelays : portfolioDelays
  });
}

function scenarioProbability(probability, scenario) {
  const stressDiscount = state.stress ? 0.08 : 0;
  const map = {
    p50: probability,
    p80: probability * 0.82,
    p90: probability * 0.68,
    stress: probability * 0.5
  };
  return clamp((map[scenario] ?? probability) - stressDiscount, 0.05, 0.98);
}

function buildForecast(scored, scenario) {
  return buildForecastDomain({
    scored,
    scenario,
    forecastStartDate,
    outflows: state.outflows,
    openingBalance: state.openingBalance
  });
}

function formatMoney(value) {
  const sign = value < 0 ? "-" : "";
  return `${sign}${RUB.format(Math.abs(value)).replace("₽", "руб.")}`;
}

function formatMinorMoney(valueMinor) {
  return formatMoney((valueMinor ?? 0) / 100);
}

function formatFundingDate(dateIso) {
  if (!dateIso) return "—";
  const date = normalizeDate(dateIso);
  return date ? DATE.format(date) : dateIso;
}

function formatMoneyCompact(value) {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${sign}${(abs / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн`;
  }
  if (abs >= 1_000) {
    return `${sign}${(abs / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: 0 })} тыс.`;
  }
  return `${sign}${abs.toLocaleString("ru-RU", { maximumFractionDigits: 0 })}`;
}

function formatPct(value) {
  return `${Math.round(value * 100)}%`;
}

function formatPctExact(value) {
  return `${(value * 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%`;
}

function render() {
  const scored = state.receipts.map(scoreReceipt);
  const forecast = buildForecast(scored, state.scenario);
  renderMetrics(scored, forecast);
  renderOpsPreview(scored, forecast);
  renderChart(forecast);
  renderGap(scored, forecast);
  renderCalendar(forecast);
  renderReceipts(scored);
  renderDebtors(scored);
  renderActions(scored, forecast);
  renderIntake();
  renderFactors();
}

function renderOpsPreview(scored, forecast) {
  const minBalance = Math.min(...forecast.map((day) => day.closingBalance));
  const minDay = forecast.find((day) => day.closingBalance === minBalance) ?? forecast[0];
  const fundingNeed = Math.max(0, -minBalance);
  const shifted = scored.filter((item) => item.p50Delay > 0);
  const manualReview = scored.filter((item) => !item.documentsOk || !item.bankMatch || item.scenarioDelays?.source === "new");
  const flowRows = [
    minDay,
    forecast.find((day) => day.expectedIn > 0) ?? forecast[Math.min(4, forecast.length - 1)] ?? minDay,
    forecast.findLast?.((day) => day.expectedIn > 0) ?? forecast[Math.min(14, forecast.length - 1)] ?? minDay
  ].filter(Boolean);
  const uniqueRows = flowRows.filter((row, index, rows) => rows.findIndex((item) => daysBetween(item.date, row.date) === 0) === index).slice(0, 3);
  while (uniqueRows.length < 3 && forecast[uniqueRows.length]) uniqueRows.push(forecast[uniqueRows.length]);
  const maxAbs = Math.max(...forecast.map((day) => Math.abs(day.closingBalance)), 1);

  const setText = (id, text) => {
    const node = document.querySelector(`#${id}`);
    if (node) node.textContent = text;
  };
  setText("opsMinBalance", formatMoney(minBalance));
  setText("opsFundingNeed", formatMoney(fundingNeed));
  setText("opsShiftedCount", String(shifted.length));
  setText("opsReviewCount", String(manualReview.length));

  uniqueRows.forEach((row, index) => {
    const idx = index + 1;
    setText(`opsFlowDate${idx}`, DATE.format(row.date));
    setText(`opsFlowValue${idx}`, formatMoneyCompact(row.closingBalance));
    const bar = document.querySelector(`#opsFlowBar${idx}`);
    if (bar) {
      bar.style.setProperty("--w", `${Math.max(10, Math.min(100, Math.round(Math.abs(row.closingBalance) / maxAbs * 100)))}%`);
      bar.classList.toggle("danger-bar", row.closingBalance < 0);
    }
  });
}

function renderMetrics(scored, forecast) {
  const planned = forecast.reduce((sum, day) => sum + day.plannedIn, 0);
  const scenarioCash = forecast.reduce((sum, day) => sum + day.expectedIn, 0);
  const minBalance = Math.min(...forecast.map((day) => day.closingBalance));
  const fundingNeed = Math.max(0, -minBalance);
  const delayKey = `${state.scenario}Delay`;
  const averageShift = scored.length
    ? Math.round(scored.reduce((sum, item) => sum + (item[delayKey] ?? 0), 0) / scored.length)
    : 0;
  const shiftedAmount = scored.reduce((sum, item) => (item[delayKey] ?? 0) > 0 ? sum + item.amount : sum, 0);

  const metrics = [
    ["Плановые поступления", formatMoney(planned), "полная сумма по договорным датам", "Σ всех плановых входящих платежей в горизонте прогноза.", "Справочная сумма плана: сама по себе не увеличивает остаток денег."],
    [`Сценарный cash-in ${scenarioLabel(state.scenario)}`, formatMoney(scenarioCash), "полная сумма на сценарных датах", "Σ полных сумм платежей, перенесенных на P50/P80/P90/Stress даты.", "Вероятность влияет на дату, а не дробит сумму."],
    ["Максимальный cash gap", formatMoney(fundingNeed), `минимальный исходящий остаток ${formatMoney(minBalance)}`, "MAX(0; -минимальный исходящий остаток по выбранному сценарию).", "Разрыв возникает между договорной датой cash-in и сценарной датой фактической оплаты."],
    [`Средний сдвиг даты · ${scenarioLabel(state.scenario)}`, `${averageShift} дн.`, `${formatMoney(shiftedAmount)} ожидается позже плана`, `Среднее число дней между договорной и ${scenarioLabel(state.scenario)} датой.`, "Показывает, насколько позже плана ожидаются деньги в выбранном сценарии."]
  ];

  const cards = metrics.map(([label, value, note, formula, explanation]) => {
    const heading = createElement(document, "span");
    heading.append(
      document.createTextNode(label),
      createTextElement(document, "i", "i", { className: "info-dot", attributes: { "aria-hidden": "true" } })
    );
    return createElement(document, "article", { className: "metric-card", title: `${formula} ${explanation}` },
      heading,
      createTextElement(document, "strong", value),
      createTextElement(document, "small", note),
      createElement(document, "details", { className: "metric-details" },
        createTextElement(document, "summary", "Как рассчитано"),
        createTextElement(document, "p", formula, { className: "formula-text" }),
        createTextElement(document, "p", explanation, { className: "metric-explain" })
      )
    );
  });
  replaceChildren(document.querySelector("#metricGrid"), cards);
}

function renderChart(forecast) {
  const svg = document.querySelector("#forecastChart");
  const width = 920;
  const height = 320;
  const pad = 38;
  const values = forecast.flatMap((day) => [day.balance, day.p50Balance, day.p80Balance, 0]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const y = (value) => height - pad - ((value - min) / Math.max(max - min, 1)) * (height - pad * 2);
  const x = (idx) => pad + (idx / (forecast.length - 1)) * (width - pad * 2);
  const line = (key) => forecast.map((day, idx) => `${x(idx)},${y(day[key])}`).join(" ");
  const nodes = [
    createSvgElement(document, "rect", { x: 0, y: 0, width, height, fill: "#ffffff" }),
    createSvgElement(document, "line", { x1: pad, y1: y(0), x2: width - pad, y2: y(0), stroke: "#c2413a", "stroke-dasharray": "5 5" })
  ];
  forecast.forEach((day, idx) => {
    const barX = x(idx) - 6;
    const plannedH = Math.max(1, day.plannedIn / Math.max(...forecast.map((d) => d.plannedIn), 1) * 70);
    const outH = Math.max(1, day.outflow / Math.max(...forecast.map((d) => d.outflow), 1) * 70);
    nodes.push(
      createSvgElement(document, "rect", { x: barX, y: height - pad - plannedH, width: 5, height: plannedH, fill: "#2563eb", opacity: 0.45 }),
      createSvgElement(document, "rect", { x: barX + 6, y: height - pad - outH, width: 5, height: outH, fill: "#c2413a", opacity: 0.45 })
    );
  });
  nodes.push(
    createSvgElement(document, "polyline", { fill: "none", stroke: "#0f9f8e", "stroke-width": 4, points: line("balance") }),
    createSvgElement(document, "polyline", { fill: "none", stroke: "#6d5bd0", "stroke-width": 2.5, points: line("p50Balance"), opacity: 0.8 }),
    createSvgElement(document, "polyline", { fill: "none", stroke: "#c47b16", "stroke-width": 2.5, points: line("p80Balance"), opacity: 0.8 })
  );
  forecast.forEach((day, idx) => {
    if (idx % 5 === 0) nodes.push(createSvgElement(document, "text", {
      x: x(idx), y: height - 10, "text-anchor": "middle", "font-size": 12, fill: "#687487"
    }, DATE.format(day.date)));
  });
  nodes.push(createSvgElement(document, "text", { x: pad, y: 22, "font-size": 12, fill: "#687487" }, "Остаток денег по сценарным датам реального cash-in"));
  replaceChildren(svg, nodes);
}

function renderGap(scored, currentForecast) {
  const scenarios = ["p50", "p80", "p90", "stress"].map((scenario) => {
    const forecast = buildForecast(scored, scenario);
    const min = Math.min(...forecast.map((day) => day.closingBalance));
    const day = forecast.find((item) => item.closingBalance === min);
    return { scenario, min, date: day.date, need: Math.max(0, -min) };
  });
  const currentMin = Math.min(...currentForecast.map((day) => day.closingBalance));
  const currentDay = currentForecast.find((item) => item.closingBalance === currentMin) ?? currentForecast[0];
  const reserve = Math.max(0, -currentMin);

  const gapWarning = document.querySelector("#gapWarning");
  gapWarning.className = `gap-warning ${currentMin < 0 ? "danger" : ""}`;
  const delayKey = `${state.scenario}Delay`;
  const delayed = scored.filter((item) => Number(item[delayKey]) > 0);
  const delayedAmount = delayed.reduce((sum, item) => sum + item.amount, 0);
  const delayedText = createElement(document, "p", {}, "Позже договорной даты: ", createTextElement(document, "b", `${delayed.length} платежей на ${formatMoney(delayedAmount)}`));
  const reserveText = createElement(document, "p", {}, "Нужно покрыть: ", createTextElement(document, "b", formatMoney(reserve)));
  replaceChildren(gapWarning, [
    createTextElement(document, "strong", currentMin < 0 ? "Разрыв вероятен" : "Разрыва нет"),
    createTextElement(document, "p", `${scenarioLabel(state.scenario)}: минимум ${formatMoney(currentMin)} · ${DATE.format(currentDay.date)}`),
    delayedText,
    reserveText
  ]);

  replaceChildren(document.querySelector("#scenarioCards"), scenarios.map((item) => {
    const label = createElement(document, "span", {}, scenarioLabel(item.scenario));
    return createElement(document, "button", {
      className: `scenario-card ${item.scenario === state.scenario ? "active" : ""}`,
      attributes: {
        type: "button",
        "data-scenario": item.scenario,
        "aria-pressed": String(item.scenario === state.scenario),
        "aria-label": `Выбрать сценарий ${scenarioLabel(item.scenario)}. Минимальный остаток ${formatMoney(item.min)}`
      }
    }, label, createTextElement(document, "strong", formatMoney(item.min)));
  }));
}

function renderCalendar(forecast) {
  const scope = document.querySelector("#forecastScope");
  if (scope && forecast.report) {
    const excluded = forecast.report.excluded;
    const excludedAmount = excluded.reduce((sum, item) => sum + item.amountMinor, 0) / 100;
    scope.textContent = excluded.length
      ? `Горизонт: ${DATE.format(forecast.report.startDate)} — ${DATE.format(forecast.report.endDate)} За границами или исключено: ${excluded.length} событий на ${formatMoney(excludedAmount)}.`
      : `Горизонт: ${DATE.format(forecast.report.startDate)} — ${DATE.format(forecast.report.endDate)} Все события выбранного сценария входят в расчет.`;
  }
  const rows = forecast.map((day) => {
    const status = day.closingBalance < 0
      ? createPill(document, "разрыв", "bad")
      : day.closingBalance < 5_000_000
        ? createPill(document, "низкий запас", "warn")
        : createPill(document, "ок", "good");
    const gapOrSurplus = day.financingNeed > 0
      ? createPill(document, formatMoney(day.financingNeed), "bad")
      : createPill(document, formatMoney(day.closingBalance), "good");
    return createElement(document, "tr", {},
      createTableCell(document, DATE.format(day.date)),
      createTableCell(document, formatMoney(day.openingBalance), { className: "money", title: "Входящий остаток = исходящий остаток предыдущего дня" }),
      createTableCell(document, formatMoney(day.plannedIn), { className: "money muted-money", title: "Справочно: договорная дата из платежного календаря. В исходящий остаток не прибавляется напрямую." }),
      createTableCell(document, formatMoney(day.expectedIn), { className: "money", title: "Сценарные поступления = полная сумма договора на сценарную дату оплаты" }),
      createTableCell(document, formatMoney(day.outflow), { className: "money", title: "Списания = обязательные исходящие платежи на дату" }),
      createTableCell(document, formatMoney(day.closingBalance), { className: "money", title: "Исходящий остаток = входящий остаток + сценарные поступления - списания" }),
      createTableCell(document, gapOrSurplus, { className: "money" }),
      createTableCell(document, status)
    );
  });
  replaceChildren(document.querySelector("#calendarRows"), rows);
}

function renderReceipts(scored) {
  const rows = scored
    .slice()
    .sort((a, b) => b.p80Delay - a.p80Delay)
    .slice(0, 20);

  const dateKey = `${state.scenario}Date`;
  const delayKey = `${state.scenario}Delay`;
  const heading = document.querySelector("#selectedScenarioDateHeading");
  if (heading) heading.textContent = `Дата: ${scenarioLabel(state.scenario)}`;

  function timingReason(item) {
    const evidence = item.timingEvidence ?? {};
    if (evidence.elapsedOverdueDays > 0) return `Платеж уже просрочен на ${evidence.elapsedOverdueDays} дн.`;
    if (evidence.source === "counterparty") return `По истории ${evidence.ownSampleSize} прошлых оплат контрагента.`;
    if (evidence.source === "blended") return `Мало своей истории: учтены ${evidence.ownSampleSize} оплаты контрагента и общая статистика.`;
    if (evidence.source === "portfolio") return "Новый контрагент: использована общая история платежей компании.";
    if (evidence.source === "sparse-counterparty") return `Есть только ${evidence.ownSampleSize} прошлых оплат; оценка предварительная.`;
    return "Истории оплат нет: пока используется договорная дата.";
  }

  replaceChildren(document.querySelector("#receiptRows"), rows.map((item) => {
    const counterparty = createTableCell(document, [
      createTextElement(document, "strong", item.counterparty),
      document.createElement("br"),
      createTextElement(document, "span", item.id)
    ]);
    const delay = Number(item[delayKey]) || 0;
    return createElement(document, "tr", {},
      counterparty,
      createTableCell(document, formatMoney(item.amount), { className: "money" }),
      createTableCell(document, DATE.format(item.plannedDate)),
      createTableCell(document, DATE.format(item[dateKey])),
      createTableCell(document, delay > 0 ? `${delay} дн. позже` : "В договорную дату"),
      createTableCell(document, timingReason(item))
    );
  }));
}

function renderDebtors(scored) {
  const grouped = new Map();
  scored.forEach((item) => {
    const current = grouped.get(item.counterparty) ?? {
      counterparty: item.counterparty,
      amount: 0,
      shiftedAmount: 0,
      p50Delay: 0,
      p80Delay: 0,
      count: 0,
      late30: item.late30,
      avgDelay: item.avgDelay
    };
    current.amount += item.amount;
    current.shiftedAmount += item.p50Delay > 0 ? item.amount : 0;
    current.p50Delay += item.p50Delay;
    current.p80Delay += item.p80Delay;
    current.count += 1;
    grouped.set(item.counterparty, current);
  });

  const debtors = [...grouped.values()]
    .map((item) => ({ ...item, p50Delay: item.p50Delay / item.count, p80Delay: item.p80Delay / item.count }))
    .sort((a, b) => b.p80Delay - a.p80Delay)
    .slice(0, 8);

  replaceChildren(document.querySelector("#debtorCards"), debtors.map((item) => {
    const average = item.avgDelay === null || item.avgDelay === undefined ? "нет истории" : `${item.avgDelay} дн.`;
    const details = createElement(document, "dl", {},
      createTextElement(document, "dt", "Сдвинутая сумма"), createTextElement(document, "dd", formatMoney(item.shiftedAmount)),
      createTextElement(document, "dt", "P50 сдвиг"), createTextElement(document, "dd", `${Math.round(item.p50Delay)} дн.`),
      createTextElement(document, "dt", "P80 сдвиг"), createTextElement(document, "dd", `${Math.round(item.p80Delay)} дн.`),
      createTextElement(document, "dt", "Средняя задержка"), createTextElement(document, "dd", average)
    );
    return createElement(document, "article", { className: "debtor-card" }, createTextElement(document, "strong", item.counterparty), details);
  }));
}

function renderActions(scored, forecast) {
  const result = simulateFundingCoverage({
    forecast,
    receipts: scored,
    outflows: state.outflows,
    sources: fundingSources(),
    asOfDate: forecastStartDate,
    scenario: state.scenario
  });
  const statusLabels = {
    applied: "Применено",
    unavailable: "Недоступно",
    ineligible: "Не подходит",
    incomplete: "Условия не заполнены"
  };
  const rows = result.actions.map((action) => {
    const factoringTargets = action.targetIds?.length ? action.targetIds.join(", ") : action.targetId;
    const sourceCell = createTableCell(document, [createTextElement(document, "strong", action.name)]);
    if (action.type === "factoring" && factoringTargets) sourceCell.append(createTextElement(document, "small", `ДЗ: ${factoringTargets}`));
    if (action.type === "payment-move" && action.targetId) sourceCell.append(createTextElement(document, "small", `Платеж: ${action.targetId}`));
    sourceCell.append(createTextElement(document, "small", `Источник условий: ${action.inputSource ?? "не указан"}`));

    const termCell = createTableCell(document, action.movedToDateIso
      ? `${formatFundingDate(action.effectiveDateIso)} → ${formatFundingDate(action.movedToDateIso)}`
      : formatFundingDate(action.effectiveDateIso));
    if (!action.movedToDateIso && action.termDays !== null) {
      termCell.append(createTextElement(document, "small", `${action.termDays} дн.${action.repaymentDateIso ? `, погашение ${formatFundingDate(action.repaymentDateIso)}` : ""}`));
    }

    const costCell = createTableCell(document, action.costMinor === null
      ? createTextElement(document, "span", "Не рассчитана", { className: "muted" })
      : [createTextElement(document, "span", formatMinorMoney(action.costMinor)), createTextElement(document, "small", action.costFormula)]);

    const limitCell = createTableCell(document, action.type === "payment-move" ? "не применяется" : [
      createTextElement(document, "span", `${formatMinorMoney(action.usedLimitMinor)} / ${formatMinorMoney(action.limitMinor)}`),
      createTextElement(document, "small", `остаток ${formatMinorMoney(action.remainingLimitMinor)}`)
    ]);
    const statusCell = createTableCell(document, [
      createTextElement(document, "span", statusLabels[action.status], { className: `action-status ${action.status}` }),
      createTextElement(document, "small", action.reason),
      createTextElement(document, "strong", `Остаток: ${formatMinorMoney(action.remainingGapMinor)}`)
    ]);
    return createElement(document, "tr", { dataset: { status: action.status } },
      sourceCell,
      createTableCell(document, formatMinorMoney(action.appliedAmountMinor), { className: "money" }),
      termCell,
      costCell,
      limitCell,
      createTableCell(document, action.constraints.join("; ") || "—"),
      statusCell
    );
  });
  const uncoveredSource = createTableCell(document, [
    createTextElement(document, "strong", "Непокрытый остаток"),
    createTextElement(document, "small", "После применения всех источников по очереди")
  ]);
  const totalCost = createTableCell(document, [
    createTextElement(document, "span", formatMinorMoney(result.totalCostMinor)),
    createTextElement(document, "small", "совокупная рассчитанная стоимость")
  ]);
  rows.push(createElement(document, "tr", { className: "uncovered-row" },
    uncoveredSource,
    createTableCell(document, formatMinorMoney(result.uncoveredNeedMinor), { className: "money" }),
    createTableCell(document, result.affectedDates.length ? `${result.affectedDates.length} дн.` : "—"),
    totalCost,
    createTableCell(document, "—"),
    createTableCell(document, result.affectedDates.length ? `Даты: ${result.affectedDates.map(formatFundingDate).join(", ")}` : "Разрыв закрыт"),
    createTableCell(document, createTextElement(document, "span", result.fullyCovered ? "Покрыт" : "Требуется решение", {
      className: `action-status ${result.fullyCovered ? "applied" : "incomplete"}`
    }))
  ));
  replaceChildren(document.querySelector("#actionRows"), rows);
}

function renderIntake() {
  replaceChildren(document.querySelector("#intakeList"), intakeItems.map(([title, text]) => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    const heading = createElement(document, "strong", {}, checkbox, ` ${title}`);
    return createElement(document, "label", { className: "check-item" }, heading, createTextElement(document, "span", text));
  }));
}

function renderFactors() {
  const items = [
    ["История задержек", "Основной источник P50/P80/P90. В Excel это колонка \"История задержек, дней\": например 0;1;4;14;30."],
    ["Малая выборка", "Для 1-4 оплат собственная история смешивается с портфельной: вес контрагента равен числу его оплат, деленному на 5."],
    ["Новый контрагент", "Договорная дата остается базовой, сценарные даты используют портфельную историю. Строка помечается как \"нет собственной истории\" и не получает надежность 100%."],
    ["Сценарии", "P50/P80/P90/Stress меняют дату полного платежа. Сумма платежа не дробится по вероятности."]
  ];

  replaceChildren(document.querySelector("#riskFactors"), items.map(([title, text]) =>
    createElement(document, "div", { className: "factor-item" },
      createTextElement(document, "strong", title),
      createTextElement(document, "span", text)
    )
  ));
}

function exportReport() {
  const view = runController.view();
  const run = view.committed;
  const csv = buildCommittedRunCsv(run);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `cash-in-risk-audit-${run.runId}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  setUploadStatus(`${view.visibleRunIsPrevious ? "Экспортирован предыдущий " : "Экспортирован "}зафиксированный расчет ${run.runId}.`, "success");
}

const workflowSteps = [
  { title: "Загрузить данные", description: "Добавьте Excel. Затем проверьте дату расчета и остаток денег." },
  { title: "Проверить загрузку", description: "Убедитесь, что Excel прочитан без ошибок, а поступления банка сопоставлены с ДЗ." },
  { title: "Посмотреть прогноз и кассовый разрыв", description: "Сравните сценарные даты, минимальный остаток и потребность в ликвидности." },
  { title: "Выбрать план покрытия", description: "Укажите подтвержденные лимиты и пересчитайте стоимость покрытия." },
  { title: "Подтвердить и скачать отчет CFO", description: "Подтвердите сверку, готовность отчета и скачайте файлы." }
];

let workflowStep = 1;
let pendingWorkflowTarget = null;

function hasCurrentWorkflowRun() {
  return runController.view().status === RUN_STATUS.CURRENT;
}

function setWorkflowStep(nextStep, { scroll = false } = {}) {
  const requestedStep = Math.min(workflowSteps.length, Math.max(1, Number(nextStep) || 1));
  const runStatus = runController.view().status;
  const keepFundingDraft = requestedStep === 4 && workflowStep === 4 && runStatus === RUN_STATUS.STALE;
  workflowStep = requestedStep > 2 && !hasCurrentWorkflowRun() && !keepFundingDraft ? 2 : requestedStep;
  document.body.dataset.workflowStep = String(workflowStep);
  const current = workflowSteps[workflowStep - 1];
  const kicker = document.querySelector("#workflowKicker");
  const title = document.querySelector("#workflowTitle");
  const description = document.querySelector("#workflowDescription");
  if (kicker) kicker.textContent = `Шаг ${workflowStep} из ${workflowSteps.length}`;
  if (title) title.textContent = current.title;
  if (description) description.textContent = current.description;
  document.querySelectorAll("[data-workflow-target]").forEach((button) => {
    const target = Number(button.dataset.workflowTarget);
    if (target === workflowStep) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
    button.dataset.complete = String(target < workflowStep);
    const canCalculatePreparedData = [RUN_STATUS.STAGED, RUN_STATUS.STALE].includes(runStatus);
    button.disabled = target > 2 && !hasCurrentWorkflowRun() && !canCalculatePreparedData && !(target === 4 && keepFundingDraft);
    button.dataset.requiresCalculation = String(target > 2 && !hasCurrentWorkflowRun() && canCalculatePreparedData);
  });
  const previous = document.querySelector("#workflowPrevButton");
  const next = document.querySelector("#workflowNextButton");
  if (previous) previous.disabled = workflowStep === 1;
  if (next) {
    const status = runStatus;
    next.disabled = workflowStep === workflowSteps.length || (workflowStep === 2 && ![RUN_STATUS.CURRENT, RUN_STATUS.STAGED, RUN_STATUS.STALE].includes(status));
    if (workflowStep > 2 && status !== RUN_STATUS.CURRENT) next.disabled = true;
    next.textContent = ["Перейти к проверке", status === RUN_STATUS.CURRENT ? "Показать прогноз" : "Рассчитать и показать прогноз", "Выбрать покрытие", "Подготовить отчет", "Готово"][workflowStep - 1];
  }
  const calculate = document.querySelector("#calculateRunButton");
  if (calculate) calculate.textContent = workflowStep === 4 ? "Пересчитать план покрытия" : "Рассчитать и показать прогноз";
  const feedback = document.querySelector("#calculationFeedback");
  if (feedback && workflowStep !== 4) feedback.hidden = true;
  if (scroll) document.querySelector("#workflow")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderQualitySummary() {
  const target = document.querySelector("#qualitySummary");
  if (!target) return;
  const view = runController.view();
  const report = view.status === RUN_STATUS.ERROR
    ? state.importReport ?? {}
    : view.staged?.data?.qualityReport ?? view.committed?.qualityReport ?? state.importReport ?? {};
  const reconciliation = report.reconciliation ?? {};
  const counts = {
    unmatchedPayments: Number.isInteger(reconciliation.unmatchedPayments) ? reconciliation.unmatchedPayments : 0,
    pendingAllocations: Number.isInteger(reconciliation.pendingAllocations) ? reconciliation.pendingAllocations : 0,
    errors: Array.isArray(report.errors) ? report.errors.length : 0,
    warnings: Array.isArray(report.warnings) ? report.warnings.length : 0
  };
  const ready = counts.errors === 0;
  target.dataset.tone = ready ? "success" : "error";
  replaceChildren(target, [
    createTextElement(document, "strong", ready ? "Данные готовы к расчету" : "Исправьте ошибки перед расчетом"),
    createTextElement(document, "span", `Ошибки в Excel: ${counts.errors}`),
    createTextElement(document, "span", `Поступления банка без найденной ДЗ: ${counts.unmatchedPayments}`),
    createTextElement(document, "span", `Платежи для ручного распределения: ${counts.pendingAllocations}`),
    createTextElement(document, "span", `Предупреждения: ${counts.warnings}`)
  ]);
}

async function downloadAuditSnapshot() {
  const run = runController.view().committed;
  if (!run) throw new Error("Сначала выполните расчет.");
  const snapshot = await createAuditSnapshot(run);
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `cash-in-risk-audit-${run.runId}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function importAuditSnapshot(file) {
  if (!file) throw new SnapshotValidationError("Выберите файл расчета в формате JSON.");
  const snapshot = await parseAuditSnapshot(await file.text());
  const recalculated = calculateRun(snapshot.run.inputs);
  const recalculatedHash = await sha256Hex(recalculated.outputs);
  if (recalculatedHash !== snapshot.integrity.financialResultSha256) {
    throw new SnapshotValidationError("Файл расчета не воспроизводится текущими версиями расчетных моделей.", "REPRODUCTION_MISMATCH");
  }
  runController.restore(snapshot.run);
  applyCommittedInputs(snapshot.run.inputs, snapshot.run.sources, snapshot.run.qualityReport);
  render();
  renderImportReport();
  renderRunStatus();
  setUploadStatus(`Файл расчета ${snapshot.run.runId} проверен, расчет восстановлен.`, "success");
  return snapshot.run;
}

document.querySelector("#startWorkflowButton")?.addEventListener("click", (event) => {
  event.preventDefault();
  document.body.classList.add("workflow-started");
  setWorkflowStep(1, { scroll: true });
  document.querySelector("#excelInput")?.click();
});

document.querySelector('.nav-list a[href="#workflow"]')?.addEventListener("click", (event) => {
  event.preventDefault();
  document.body.classList.add("workflow-started");
  setWorkflowStep(1, { scroll: true });
});

document.querySelectorAll("[data-workflow-target]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = Number(button.dataset.workflowTarget);
    if (target > 2 && !hasCurrentWorkflowRun()) {
      pendingWorkflowTarget = target;
      document.querySelector("#calculateRunButton")?.click();
      return;
    }
    setWorkflowStep(target, { scroll: true });
  });
});

document.querySelector("#workflowPrevButton")?.addEventListener("click", () => {
  setWorkflowStep(workflowStep - 1, { scroll: true });
});

document.querySelector("#workflowNextButton")?.addEventListener("click", () => {
  if (workflowStep === 2 && !hasCurrentWorkflowRun()) {
    document.querySelector("#calculateRunButton")?.click();
    return;
  }
  setWorkflowStep(workflowStep + 1, { scroll: true });
});

document.querySelector("#exportButton").addEventListener("click", () => {
  try {
    exportReport();
  } catch (error) {
    setUploadStatus(error.message, "error");
  }
});

document.querySelector("#loadSampleButton").addEventListener("click", async () => {
  runController.reset();
  priorSnapshot = null;
  selectedPriorLedger = null;
  const operatorInput = document.querySelector("#signOffOperatorInput");
  if (operatorInput) operatorInput.value = "";
  loadDemo();
  render();
  renderRunStatus();
  try {
    await executeCurrentRun();
    setWorkflowStep(1, { scroll: true });
  } catch (error) {
    setUploadStatus(error.message, "error");
  }
});

async function prepareExcelFile(file) {
  if (!file) return;
  const input = document.querySelector("#excelInput");
  const uploadZone = document.querySelector(".upload-zone");
  const fileName = document.querySelector("#selectedFileName");
  try {
    input.disabled = true;
    uploadZone?.setAttribute("aria-busy", "true");
    if (fileName) fileName.textContent = file.name;
    setUploadStatus("Читаю и проверяю Excel-файл...", "neutral");
    const uploaded = await readExcelFile(file, { fallbackDate: forecastStartDate });
    if (uploaded.kind === "bank-update" && !selectedPriorLedger) {
      throw new Error("Для обновления только банка сначала загрузите прошлый файл расчета и явно выберите его как базу.");
    }
    const data = uploaded.kind === "bank-update"
      ? applyBankUpdateToPriorLedger(selectedPriorLedger.run.inputs.canonicalLedger, uploaded)
      : uploaded;
    state.importReport = data.report;
    renderImportReport();
    if (uploaded.kind === "bank-update") {
      setUploadStatus(`Банк проверен на ${data.asOfDate.toLocaleDateString("ru-RU")}; предыдущий расчет остается на экране до нового запуска.`, "success");
    } else if (data.balance) {
      forecastStartDate = data.balance.date;
      state.openingBalance = data.balance.openingBalance;
      syncBalanceControls(data.bankFreshness
        ? `Банк: остаток на конец ${data.bankFreshness.sourceCloseDate}; дата расчета ${data.asOfDate.toLocaleDateString("ru-RU")}. Получено ${data.bankFreshness.observedAt}. До расчета показан предыдущий результат.`
        : "Подготовлено из листа Остатки. До нового расчета на экране остается предыдущий результат.");
    } else {
      const inferredStartDate = inferForecastStartDate(data.receipts, data.outflows);
      if (inferredStartDate) {
        forecastStartDate = inferredStartDate;
        syncBalanceControls("Дата подготовлена из Excel, остаток взят из интерфейса. До расчета показан предыдущий результат.");
      } else {
        syncBalanceControls("Источник: значение из интерфейса. Лист Остатки в Excel не найден.");
      }
    }
    const fileSha256 = await sha256Hex(await file.arrayBuffer());
    const canonicalLedger = data.kind === "canonical"
      ? canonicalLedgerForRun({
        reconciliation: data.reconciliation,
        outflows: data.outflows,
        bankBalances: data.bankBalances ?? [],
        balance: data.balance ?? { openingBalance: state.openingBalance },
        asOfDate: data.asOfDate
      }) : data.canonicalLedger ?? null;
    const staged = {
      receipts: data.receipts,
      outflows: data.outflows,
      asOfDate: data.asOfDate ?? forecastStartDate,
      openingBalance: canonicalLedger ? canonicalLedger.openingBalanceMinor / 100 : data.balance?.openingBalance ?? state.openingBalance,
      canonicalLedger,
      dataSources: [...(uploaded.kind === "bank-update" ? selectedPriorLedger.run.sources.map((source) => ({
        ...source,
        inheritedFromRunId: selectedPriorLedger.run.runId,
        planningAsOfDate: source.planningAsOfDate ?? null
      })) : []), {
        type: "xlsx",
        name: file.name,
        sizeBytes: file.size,
        lastModified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
        sha256: fileSha256,
        bankBalanceCloseDate: data.bankFreshness?.sourceCloseDate ?? null,
        observedAt: data.bankFreshness?.observedAt ?? null,
        bankAccountCount: data.bankFreshness?.accountCount ?? null,
        bankAccounts: data.bankBalances?.map((item) => `${item.bankId}|${item.legalEntityId}|${item.accountId}`) ?? [],
        planningAsOfDate: uploaded.kind === "bank-update" ? null : dateOnly(data.asOfDate ?? forecastStartDate),
        baseRunId: uploaded.kind === "bank-update" ? selectedPriorLedger.run.runId : null
      }],
      qualityReport: data.report
    };
    runController.stage(staged, { fileName: file.name });
    const acceptance = document.querySelector("#uncoveredGapAcceptanceInput");
    if (acceptance) acceptance.checked = false;
    renderRunStatus();
    setUploadStatus(uploaded.kind === "bank-update"
      ? `Данные подготовлены из run ${selectedPriorLedger.run.runId}: банк ${uploaded.payments.length} операций, открытых ДЗ ${data.receipts.length}. Нажмите «Рассчитать прогноз».`
      : `Проверка завершена: поступлений ${data.receipts.length}, исходящих ${data.outflows.length}.`, "success");
    setWorkflowStep(2, { scroll: true });
  } catch (error) {
    if (error instanceof ExcelIntakeError && error.report) {
      state.importReport = error.report;
      renderImportReport();
    }
    runController.fail(error);
    renderRunStatus();
    setUploadStatus(error.message, "error");
    setWorkflowStep(2, { scroll: true });
  } finally {
    input.disabled = false;
    uploadZone?.removeAttribute("aria-busy");
  }
}

document.querySelector("#excelInput")?.addEventListener("change", (event) => {
  prepareExcelFile(event.target.files[0]);
});

document.querySelector("#openingBalanceInput").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  state.openingBalance = Number.isFinite(value) ? Math.max(0, value) : 0;
  const source = document.querySelector("#openingBalanceSource");
  if (source) source.textContent = "Источник: ручной ввод во фронте.";
  markRunStale("Изменен входящий остаток.");
});

const zeroDefaultFundingFields = new Set([
  "liquidityReserve", "reserveLeadDays", "reserveMinDraw", "factoringLimit", "factoringMinDraw",
  "overdraftLimit", "overdraftMinDraw", "creditLineLimit", "creditLineMinDraw"
]);

[
  ["liquidityReserveInput", "liquidityReserve"], ["reserveLeadDaysInput", "reserveLeadDays"],
  ["reserveTermDaysInput", "reserveTermDays"], ["reserveRatePctInput", "reserveRatePct"],
  ["reserveMinDrawInput", "reserveMinDraw"], ["paymentMoveDaysInput", "paymentMoveDays"],
  ["paymentMoveCostInput", "paymentMoveCost"], ["factoringLimitInput", "factoringLimit"],
  ["factoringLeadDaysInput", "factoringLeadDays"], ["factoringTermDaysInput", "factoringTermDays"],
  ["factoringFeePctInput", "factoringFeePct"], ["factoringMinDrawInput", "factoringMinDraw"],
  ["overdraftLimitInput", "overdraftLimit"], ["overdraftLeadDaysInput", "overdraftLeadDays"],
  ["overdraftTermDaysInput", "overdraftTermDays"], ["overdraftRatePctInput", "overdraftRatePct"],
  ["overdraftMinDrawInput", "overdraftMinDraw"], ["creditLineLimitInput", "creditLineLimit"],
  ["creditLineLeadDaysInput", "creditLineLeadDays"], ["creditLineTermDaysInput", "creditLineTermDays"],
  ["creditLineRatePctInput", "creditLineRatePct"], ["creditLineMinDrawInput", "creditLineMinDraw"]
].forEach(([id, key]) => {
  const updateFundingValue = (event) => {
    const raw = event.target.value;
    const value = raw === "" ? null : Number(raw);
    state.funding[key] = Number.isFinite(value) ? Math.max(0, value) : zeroDefaultFundingFields.has(key) ? 0 : null;
    fundingProvenance = { inputSource: "Ручной ввод в интерфейсе", sourceRunId: null, sourceCreatedAt: null, sourceAsOfDate: null };
    markRunStale("Изменены условия финансирования.");
  };
  document.querySelector(`#${id}`)?.addEventListener("input", updateFundingValue);
  document.querySelector(`#${id}`)?.addEventListener("change", updateFundingValue);
});

[
  ["reserveAvailableDateInput", "reserveAvailableDate"],
  ["factoringAvailableDateInput", "factoringAvailableDate"],
  ["overdraftAvailableDateInput", "overdraftAvailableDate"],
  ["creditLineAvailableDateInput", "creditLineAvailableDate"]
].forEach(([id, key]) => {
  document.querySelector(`#${id}`)?.addEventListener("change", (event) => {
    state.funding[key] = event.target.value ? normalizeDate(event.target.value) : null;
    fundingProvenance = { inputSource: "Ручной ввод в интерфейсе", sourceRunId: null, sourceCreatedAt: null, sourceAsOfDate: null };
    markRunStale("Изменены условия финансирования.");
  });
});

document.querySelector("#startDateInput").addEventListener("change", (event) => {
  const date = normalizeDate(event.target.value);
  if (date) {
    forecastStartDate = date;
    const source = document.querySelector("#openingBalanceSource");
    if (source) source.textContent = "Источник: ручной ввод во фронте.";
    markRunStale("Изменена стартовая дата.");
  }
});

let scenarioChangePending = false;

async function selectScenarioAndRecalculate(scenario) {
  if (scenarioChangePending || scenario === state.scenario) return;
  scenarioChangePending = true;
  document.querySelector(".forecast-layout")?.setAttribute("aria-busy", "true");
  try {
    setScenario(scenario);
    markRunStale("Изменен сценарий прогноза.");
    render();
    await executeCurrentRun();
    setUploadStatus(`${scenarioLabel(scenario)} рассчитан.`, "success");
  } catch (error) {
    setUploadStatus(error.message, "error");
  } finally {
    scenarioChangePending = false;
    document.querySelector(".forecast-layout")?.removeAttribute("aria-busy");
  }
}

document.querySelector("#stressModeButton").addEventListener("click", () => {
  selectScenarioAndRecalculate(state.scenario === "stress" ? "p50" : "stress");
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-scenario]");
  if (button) selectScenarioAndRecalculate(button.dataset.scenario);
});

document.querySelector("#calculateRunButton")?.addEventListener("click", async () => {
  const button = document.querySelector("#calculateRunButton");
  const feedback = document.querySelector("#calculationFeedback");
  const originalLabel = button.textContent;
  try {
    const startedFromStep = workflowStep;
    button.textContent = startedFromStep === 4 ? "Пересчитываю покрытие..." : "Считаю прогноз...";
    button.disabled = true;
    if (feedback) feedback.hidden = true;
    await executeCurrentRun();
    const brief = buildOperatorBrief(runController.view().committed);
    setUploadStatus(brief?.forecastStatus === "requires-planning-update"
      ? "Расчет выполнен, но прогноз требует свежей полной выгрузки ДЗ и исходящих."
      : "Расчет успешно зафиксирован. Результат актуален.", brief?.forecastStatus === "requires-planning-update" ? "warning" : "success");
    if (startedFromStep === 2) {
      const targetStep = pendingWorkflowTarget ?? 3;
      pendingWorkflowTarget = null;
      setWorkflowStep(targetStep, { scroll: true });
    } else if (startedFromStep === 4 && feedback) {
      const coveredMinor = Math.max(0, brief.maximumNeedMinor - brief.uncoveredNeedMinor);
      feedback.textContent = `План покрытия обновлен. Потребность: ${formatMinorMoney(brief.maximumNeedMinor)} · Покрыто: ${formatMinorMoney(coveredMinor)} · Стоимость: ${formatMinorMoney(brief.coverageCostMinor)} · Не покрыто: ${formatMinorMoney(brief.uncoveredNeedMinor)}`;
      feedback.dataset.tone = brief.uncoveredNeedMinor > 0 ? "warning" : "success";
      feedback.hidden = false;
      feedback.focus({ preventScroll: true });
      feedback.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  } catch (error) {
    pendingWorkflowTarget = null;
    setUploadStatus(error.message, "error");
    if (feedback) {
      feedback.textContent = `Не удалось обновить план покрытия: ${error.message}`;
      feedback.dataset.tone = "error";
      feedback.hidden = false;
    }
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
});

document.querySelector("#downloadSnapshotButton")?.addEventListener("click", async () => {
  try {
    await downloadAuditSnapshot();
  } catch (error) {
    setUploadStatus(error.message, "error");
  }
});

document.querySelector("#uploadSnapshotButton")?.addEventListener("click", () => {
  document.querySelector("#snapshotInput")?.click();
});

document.querySelector("#uploadPriorSnapshotButton")?.addEventListener("click", () => {
  document.querySelector("#priorSnapshotInput")?.click();
});

document.querySelector("#priorSnapshotInput")?.addEventListener("change", async (event) => {
  try {
    const file = event.target.files[0];
    if (!file) throw new SnapshotValidationError("Выберите файл предыдущего расчета в формате JSON.");
    const currentRunId = runController.view().committed?.runId;
    const parsed = await parseAuditSnapshot(await file.text());
    priorSnapshot = parsed;
    selectedPriorLedger = null;
    renderComparison();
    setUploadStatus(`Предыдущий расчет ${parsed.run.runId} загружен только для сравнения. Текущий run ${currentRunId ?? "не создан"} не заменен.`, "success");
  } catch (error) {
    setUploadStatus(`Файл предыдущего расчета отклонен: ${error.message}`, "error");
  } finally {
    event.target.value = "";
  }
});

document.querySelector("#applyPriorLedgerButton")?.addEventListener("click", () => {
  try {
    const run = priorSnapshot?.run;
    const ledger = run?.inputs?.canonicalLedger;
    if (!ledger?.bankBalances?.length) throw new Error("В прошлом файле нет закрытых банковских остатков для переноса.");
    selectedPriorLedger = { run };
    renderPriorLedgerChoice();
    setUploadStatus(`База run ${run.runId} выбрана явно. Текущий расчет не изменен; загрузите новый Bank + BankBalances.`, "success");
    setWorkflowStep(1, { scroll: true });
  } catch (error) {
    setUploadStatus(error.message, "error");
  }
});

document.querySelector("#applyPriorFundingButton")?.addEventListener("click", () => {
  try {
    const run = priorSnapshot?.run;
    const sources = run?.inputs?.fundingSources;
    if (!run || !Array.isArray(sources) || sources.length === 0) {
      throw new Error("В файле предыдущего расчета нет условий финансирования для переноса.");
    }
    state.funding = fundingStateFromSources(sources);
    fundingProvenance = {
      inputSource: `Файл предыдущего расчета ${run.runId}`,
      sourceRunId: run.runId,
      sourceCreatedAt: run.createdAt,
      sourceAsOfDate: run.asOfDate
    };
    syncFundingControls();
    markRunStale(`Применены коммерческие условия финансирования из предыдущего расчета ${run.runId}.`);
    setUploadStatus(`Перенесены только коммерческие условия из run ${run.runId}. Использованные суммы и funding plan будут рассчитаны заново.`, "success");
  } catch (error) {
    setUploadStatus(error.message, "error");
  }
});

document.querySelector("#confirmReconciliationButton")?.addEventListener("click", () => {
  try {
    runController.confirmReconciliation(document.querySelector("#signOffOperatorInput")?.value);
    renderRunStatus();
    setUploadStatus("Сверка подтверждена для текущего run.", "success");
  } catch (error) {
    setUploadStatus(error.message, "error");
  }
});

document.querySelector("#confirmCfoButton")?.addEventListener("click", () => {
  try {
    runController.confirmCfoReport(document.querySelector("#signOffOperatorInput")?.value, {
      uncoveredGapAccepted: Boolean(document.querySelector("#uncoveredGapAcceptanceInput")?.checked)
    });
    renderRunStatus();
    setUploadStatus("Готовность отчета CFO подтверждена для текущего run.", "success");
  } catch (error) {
    setUploadStatus(error.message, "error");
  }
});

document.querySelector("#uncoveredGapAcceptanceInput")?.addEventListener("change", () => {
  renderSignOff();
});

document.querySelector("#snapshotInput")?.addEventListener("change", async (event) => {
  try {
    await importAuditSnapshot(event.target.files[0]);
  } catch (error) {
    runController.fail(error);
    renderRunStatus();
    setUploadStatus(error.message, "error");
  } finally {
    event.target.value = "";
  }
});

window.addEventListener("beforeunload", (event) => {
  const { status } = runController.view();
  if (![RUN_STATUS.STAGED, RUN_STATUS.STALE, RUN_STATUS.RUNNING].includes(status)) return;
  event.preventDefault();
  event.returnValue = "";
});

setWorkflowStep(1);
loadDemo();
syncFundingControls();
setScenario(state.scenario);
render();
renderRunStatus();
try {
  await executeCurrentRun();
} catch (error) {
  setUploadStatus(error.message, "error");
}

import { MS_PER_DAY, addDays, clamp, daysBetween } from "../domain/date.js";

const REQUIRED_RECEIPT_HEADERS = ["invoice_id", "counterparty", "amount", "planned_date", "due_days"];
const REQUIRED_OUTFLOW_HEADERS = ["date", "category", "amount", "criticality"];
const REQUIRED_BALANCE_HEADERS = ["date", "opening_balance"];
const REQUIRED_CANONICAL_RECEIVABLE_HEADERS = [
  "legal_entity_id", "receivable_id", "payment_schedule_id", "counterparty_id", "counterparty_name",
  "contract_id", "contractual_due_date", "original_amount_minor", "currency", "status"
];
const REQUIRED_PAYMENT_HEADERS = [
  "payment_id", "legal_entity_id", "payer_id", "payer_name", "booking_date", "amount_minor",
  "currency", "bank_reference", "purpose"
];
const REQUIRED_ALLOCATION_HEADERS = [
  "allocation_id", "payment_id", "receivable_id", "payment_schedule_id", "amount_minor",
  "method", "confidence_bps", "confirmed"
];

const headerAliases = {
  invoice_id: ["invoice_id", "номер счета", "номер счёта", "счет", "счёт", "номер документа", "документ", "invoice", "invoice id"],
  counterparty: ["counterparty", "контрагент", "дебитор", "клиент", "покупатель"],
  amount: ["amount", "сумма", "сумма платежа", "сумма поступления", "плановая сумма", "сумма постоплаты"],
  planned_date: ["planned_date", "плановая дата оплаты", "дата оплаты", "плановая дата", "дата поступления", "плановая дата поступления"],
  actual_payment_date: ["actual_payment_date", "фактическая дата оплаты", "факт оплаты", "дата факта", "фактическая дата поступления"],
  due_days: ["due_days", "отсрочка, дней", "отсрочка дней", "отсрочка", "срок отсрочки", "срок постоплаты"],
  avg_delay: ["avg_delay", "средняя задержка, дней", "средняя задержка дней", "средняя задержка", "средняя просрочка"],
  late_5: ["late_5", "просрочка 5+", "просрочка 5+ дней", "5+ дней", "доля просрочки 5+"],
  late_10: ["late_10", "просрочка 10+", "просрочка 10+ дней", "10+ дней", "доля просрочки 10+"],
  late_30: ["late_30", "просрочка 30+", "просрочка 30+ дней", "30+ дней", "доля просрочки 30+"],
  open_ar: ["open_ar", "открытая дз", "дз", "дебиторская задолженность", "остаток дз"],
  documents_ok: ["documents_ok", "документы в порядке", "документы ок", "закрывающие документы", "есть документы"],
  bank_match: ["bank_match", "поступления сматчены с банком", "матчинг банка", "банк сматчен", "сверено с банком"],
  history_total: ["history_total", "количество прошлых договоров", "история всего", "ретроспектива всего"],
  history_on_time: ["history_on_time", "оплат в срок", "история оплат в срок", "ретроспектива в срок"],
  history_avg_delay: ["history_avg_delay", "средняя задержка по истории", "историческая средняя задержка", "средняя задержка истории"],
  history_worst_delay: ["history_worst_delay", "максимальная задержка по истории", "худшая задержка", "историческая максимальная задержка"],
  history_delays: ["history_delays", "история задержек, дней", "история задержек", "исторические задержки", "задержки оплат"],
  date: ["date", "дата платежа", "дата", "плановая дата платежа"],
  category: ["category", "категория платежа", "категория", "назначение", "тип платежа"],
  criticality: ["criticality", "критичность", "важность", "тип критичности"],
  opening_balance: ["opening_balance", "входящий остаток", "входящий остаток денежных средств", "остаток денежных средств", "стартовый остаток", "остаток"],
  legal_entity_id: ["legal_entity_id", "юрлицо id", "id юрлица"],
  receivable_id: ["receivable_id", "дз id", "id задолженности"],
  payment_schedule_id: ["payment_schedule_id", "транш id", "id графика оплаты"],
  counterparty_id: ["counterparty_id", "контрагент id", "id контрагента"],
  counterparty_name: ["counterparty_name", "наименование контрагента"],
  contract_id: ["contract_id", "договор id", "номер договора"],
  contractual_due_date: ["contractual_due_date", "договорная дата оплаты"],
  original_amount_minor: ["original_amount_minor", "сумма дз в копейках"],
  currency: ["currency", "валюта"],
  status: ["status", "статус дз"],
  payment_id: ["payment_id", "банковская операция id"],
  payer_id: ["payer_id", "плательщик id"],
  payer_name: ["payer_name", "наименование плательщика"],
  booking_date: ["booking_date", "дата банковской операции"],
  amount_minor: ["amount_minor", "сумма в копейках"],
  bank_reference: ["bank_reference", "референс банка"],
  purpose: ["purpose", "назначение платежа банка"],
  allocation_id: ["allocation_id", "аллокация id"],
  method: ["method", "метод сопоставления"],
  confidence_bps: ["confidence_bps", "уверенность б.п."],
  confirmed: ["confirmed", "подтверждено"]
};

const knownHeaders = new Set(Object.keys(headerAliases));

export class WorkbookValidationError extends Error {
  constructor(report) {
    super("В Excel-файле есть ошибки. Смотрите отчет качества загрузки ниже.");
    this.name = "WorkbookValidationError";
    this.report = report;
  }
}

function createIssues() {
  return { errors: [], warnings: [] };
}

function nonEmptyRows(rows = []) {
  return rows.slice(1).filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""));
}

function normalizeHeader(value) {
  return String(value ?? "").trim();
}

export function canonicalHeader(value) {
  const raw = normalizeHeader(value);
  const normalized = raw.toLowerCase().replace(/\s+/g, " ");
  const found = Object.entries(headerAliases).find(([, aliases]) => aliases.includes(normalized));
  return found ? found[0] : raw;
}

function validateHeaders(rows, required, sheetName, issues) {
  if (!rows.length || !Array.isArray(rows[0])) {
    issues.errors.push(`Лист ${sheetName}: отсутствует строка заголовков.`);
    return [];
  }

  const headers = rows[0].map(canonicalHeader);
  const nonBlank = headers.filter(Boolean);
  const duplicates = [...new Set(nonBlank.filter((header, index) => nonBlank.indexOf(header) !== index))];
  const missing = required.filter((key) => !nonBlank.includes(key));
  const unknown = nonBlank.filter((header) => !knownHeaders.has(header));

  if (missing.length) {
    issues.errors.push(`Лист ${sheetName}: не хватает обязательных колонок: ${missing.join(", ")}.`);
  }
  if (duplicates.length) {
    issues.errors.push(`Лист ${sheetName}: повторяются колонки: ${duplicates.join(", ")}.`);
  }
  if (unknown.length) {
    issues.warnings.push(`Лист ${sheetName}: дополнительные колонки пропущены: ${[...new Set(unknown)].join(", ")}.`);
  }
  return headers;
}

function dateFromParts(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

export function normalizeDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return dateFromParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const serial = Math.floor(value);
    if (serial < 1 || serial > 2_958_465) return null;
    const utc = new Date(Date.UTC(1899, 11, 30) + serial * MS_PER_DAY);
    return dateFromParts(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
  }

  const text = String(value ?? "").trim();
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (iso) return dateFromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const ru = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (ru) return dateFromParts(Number(ru[3]), Number(ru[2]), Number(ru[1]));
  return null;
}

function normalizeNumber(value, fieldName, rowLabel, issues, options = {}) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (options.positive && value <= 0) issues.errors.push(`${rowLabel}: ${fieldName} должно быть больше нуля.`);
    if (options.nonNegative && value < 0) issues.errors.push(`${rowLabel}: ${fieldName} не может быть отрицательным.`);
    return value;
  }

  const raw = String(value ?? "").trim();
  if (!raw) {
    issues.errors.push(`${rowLabel}: пустое значение ${fieldName}.`);
    return 0;
  }
  const cleaned = raw.replace(/\s/g, "").replace(/руб\.?|₽/gi, "").replace("%", "").replace(",", ".");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    issues.errors.push(`${rowLabel}: не удалось прочитать ${fieldName}="${raw}" как число.`);
    return 0;
  }
  if (options.positive && parsed <= 0) issues.errors.push(`${rowLabel}: ${fieldName} должно быть больше нуля.`);
  if (options.nonNegative && parsed < 0) issues.errors.push(`${rowLabel}: ${fieldName} не может быть отрицательным.`);
  return parsed;
}

function normalizeOptionalNumber(value, fieldName, rowLabel, issues, options = {}) {
  if (String(value ?? "").trim() === "") return null;
  return normalizeNumber(value, fieldName, rowLabel, issues, options);
}

function normalizeRate(value, fieldName, rowLabel, issues) {
  const rawText = String(value ?? "").trim();
  let parsed = normalizeNumber(value, fieldName, rowLabel, issues, { nonNegative: true });
  if (rawText.includes("%") || parsed > 1) {
    if (parsed <= 100) {
      parsed /= 100;
      issues.warnings.push(`${rowLabel}: ${fieldName} прочитан как процент и преобразован в долю.`);
    } else {
      issues.errors.push(`${rowLabel}: ${fieldName} должен быть от 0 до 1 или от 0% до 100%.`);
    }
  }
  if (parsed > 1) issues.errors.push(`${rowLabel}: ${fieldName} должен быть не больше 1.`);
  return clamp(parsed, 0, 1);
}

function normalizeOptionalRate(value, fieldName, rowLabel, issues) {
  if (String(value ?? "").trim() === "") return 0;
  return normalizeRate(value, fieldName, rowLabel, issues);
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "y", "да", "истина"].includes(text)) return true;
  if (["false", "0", "no", "n", "нет", "ложь"].includes(text)) return false;
  return false;
}

function normalizeDelayHistory(value, rowLabel, issues) {
  if (String(value ?? "").trim() === "") return [];
  const parts = String(value).split(/[;,]/).map((part) => part.trim()).filter(Boolean);
  const delays = parts.map((part) => Number(part.replace(",", "."))).filter((item) => Number.isFinite(item) && item >= 0);
  if (delays.length !== parts.length) issues.warnings.push(`${rowLabel}: часть значений в истории задержек не распознана.`);
  return delays;
}

function rowObject(headers, row) {
  return Object.fromEntries(headers.map((key, index) => [key, row[index]]).filter(([key]) => knownHeaders.has(key)));
}

export function parseReceipts(rows, fallbackDate, sheetName = "Поступления") {
  const issues = createIssues();
  const headers = validateHeaders(rows, REQUIRED_RECEIPT_HEADERS, sheetName, issues);
  const receipts = nonEmptyRows(rows).map((row, index) => {
    const item = rowObject(headers, row);
    const rowLabel = `${sheetName}, строка ${index + 2}${item.invoice_id ? ` (${item.invoice_id})` : ""}`;
    const plannedDate = normalizeDate(item.planned_date);
    if (!plannedDate) issues.errors.push(`${rowLabel}: некорректная плановая дата; используйте YYYY-MM-DD или ДД.ММ.ГГГГ.`);
    if (!String(item.invoice_id ?? "").trim()) issues.errors.push(`${rowLabel}: пустой invoice_id.`);
    if (!String(item.counterparty ?? "").trim()) issues.errors.push(`${rowLabel}: пустой counterparty.`);
    return {
      id: String(item.invoice_id ?? "").trim(),
      counterparty: String(item.counterparty ?? "").trim(),
      amount: normalizeNumber(item.amount, "amount", rowLabel, issues, { positive: true }),
      plannedDate: plannedDate ?? fallbackDate,
      dueDays: normalizeNumber(item.due_days, "due_days", rowLabel, issues, { nonNegative: true }),
      avgDelay: normalizeOptionalNumber(item.avg_delay, "avg_delay", rowLabel, issues, { nonNegative: true }),
      late5: normalizeOptionalRate(item.late_5, "late_5", rowLabel, issues),
      late10: normalizeOptionalRate(item.late_10, "late_10", rowLabel, issues),
      late30: normalizeOptionalRate(item.late_30, "late_30", rowLabel, issues),
      openAr: normalizeOptionalNumber(item.open_ar, "open_ar", rowLabel, issues, { nonNegative: true }) ?? 0,
      documentsOk: item.documents_ok === undefined ? true : normalizeBoolean(item.documents_ok),
      bankMatch: item.bank_match === undefined ? true : normalizeBoolean(item.bank_match),
      historyTotal: normalizeOptionalNumber(item.history_total, "history_total", rowLabel, issues, { nonNegative: true }),
      historyOnTime: normalizeOptionalNumber(item.history_on_time, "history_on_time", rowLabel, issues, { nonNegative: true }),
      historyAvgDelay: normalizeOptionalNumber(item.history_avg_delay, "history_avg_delay", rowLabel, issues, { nonNegative: true }),
      historyWorstDelay: normalizeOptionalNumber(item.history_worst_delay, "history_worst_delay", rowLabel, issues, { nonNegative: true }),
      historyDelays: normalizeDelayHistory(item.history_delays, rowLabel, issues),
      _sourceRow: index + 2
    };
  });

  const unique = [];
  const byId = new Map();
  receipts.forEach((receipt) => {
    if (!receipt.id || !byId.has(receipt.id)) {
      if (receipt.id) byId.set(receipt.id, receipt);
      unique.push(receipt);
      return;
    }
    const prior = byId.get(receipt.id);
    const exact = prior.counterparty === receipt.counterparty
      && prior.amount === receipt.amount
      && prior.plannedDate?.getTime() === receipt.plannedDate?.getTime();
    if (exact) {
      issues.warnings.push(`${sheetName}, строка ${receipt._sourceRow}: точный дубль invoice_id ${receipt.id} пропущен.`);
    } else {
      issues.errors.push(`${sheetName}, строка ${receipt._sourceRow}: конфликтующий дубль invoice_id ${receipt.id}.`);
    }
  });
  unique.forEach((receipt) => delete receipt._sourceRow);
  unique.importIssues = issues;
  return unique;
}

export function parseModelContracts(rows, fallbackDate) {
  const issues = createIssues();
  const sheetName = "Лист1";
  const headers = validateHeaders(rows, REQUIRED_RECEIPT_HEADERS, sheetName, issues);
  const contracts = nonEmptyRows(rows).map((row, index) => {
    const item = rowObject(headers, row);
    const rowLabel = `${sheetName}, строка ${index + 2}${item.invoice_id ? ` (${item.invoice_id})` : ""}`;
    const plannedDate = normalizeDate(item.planned_date);
    const actualDate = normalizeDate(item.actual_payment_date);
    if (!plannedDate) issues.errors.push(`${rowLabel}: некорректная плановая дата оплаты.`);
    if (!String(item.counterparty ?? "").trim()) issues.errors.push(`${rowLabel}: пустой контрагент.`);
    const delay = actualDate && plannedDate
      ? Math.max(0, daysBetween(actualDate, plannedDate))
      : normalizeOptionalNumber(item.avg_delay, "Средняя задержка", rowLabel, issues, { nonNegative: true });
    if (delay === null) issues.errors.push(`${rowLabel}: укажите фактическую дату оплаты или среднюю задержку.`);
    return {
      id: String(item.invoice_id ?? "").trim(),
      counterparty: String(item.counterparty ?? "").trim(),
      amount: normalizeNumber(item.amount, "amount", rowLabel, issues, { positive: true }),
      plannedDate: plannedDate ?? fallbackDate,
      dueDays: normalizeNumber(item.due_days, "due_days", rowLabel, issues, { nonNegative: true }),
      delay: delay ?? 0
    };
  });

  if (issues.errors.length) {
    const empty = [];
    empty.importIssues = issues;
    return empty;
  }
  const last = contracts.at(-1);
  const delays = contracts.map((item) => item.delay);
  const nextPlannedDate = last ? addDays(last.plannedDate, last.dueDays || 30) : fallbackDate;
  const avgDelay = delays.length ? delays.reduce((sum, delay) => sum + delay, 0) / delays.length : 0;
  const receipt = {
    id: `Договор №${contracts.length + 1}`,
    counterparty: last?.counterparty ?? "Контрагент",
    amount: last?.amount ?? 0,
    plannedDate: nextPlannedDate,
    dueDays: last?.dueDays ?? 30,
    avgDelay,
    late5: delays.length ? delays.filter((delay) => delay >= 5).length / delays.length : 0,
    late10: delays.length ? delays.filter((delay) => delay >= 10).length / delays.length : 0,
    late30: delays.length ? delays.filter((delay) => delay >= 30).length / delays.length : 0,
    openAr: last?.amount ?? 0,
    documentsOk: true,
    bankMatch: true,
    historyTotal: delays.length,
    historyOnTime: delays.filter((delay) => delay === 0).length,
    historyAvgDelay: avgDelay,
    historyWorstDelay: delays.length ? Math.max(...delays) : 0,
    historyDelays: delays
  };
  const receipts = [receipt];
  receipts.importIssues = {
    errors: [],
    warnings: [`Лист1 распознан как модельный пример. Создан прогноз для ${receipt.id} по истории ${contracts.length} договоров.`]
  };
  return receipts;
}

export function parseOutflows(rows, fallbackDate, sheetName = "Исходящие") {
  const issues = createIssues();
  const headers = validateHeaders(rows, REQUIRED_OUTFLOW_HEADERS, sheetName, issues);
  const outflows = nonEmptyRows(rows).map((row, index) => {
    const item = rowObject(headers, row);
    const rowLabel = `${sheetName}, строка ${index + 2}${item.category ? ` (${item.category})` : ""}`;
    const date = normalizeDate(item.date);
    if (!date) issues.errors.push(`${rowLabel}: некорректная дата; используйте YYYY-MM-DD или ДД.ММ.ГГГГ.`);
    if (!String(item.category ?? "").trim()) issues.errors.push(`${rowLabel}: пустой category.`);
    const criticality = String(item.criticality ?? "").trim();
    if (!["must-pay", "moveable"].includes(criticality)) {
      issues.warnings.push(`${rowLabel}: criticality лучше указать как must-pay или moveable.`);
    }
    return {
      date: date ?? fallbackDate,
      category: String(item.category ?? "").trim(),
      amount: normalizeNumber(item.amount, "amount", rowLabel, issues, { positive: true }),
      criticality: criticality || "must-pay"
    };
  });
  outflows.importIssues = issues;
  return outflows;
}

export function parseBalances(rows, fallbackDate, sheetName = "Остатки") {
  const issues = createIssues();
  const headers = validateHeaders(rows, REQUIRED_BALANCE_HEADERS, sheetName, issues);
  const sourceRows = nonEmptyRows(rows);
  if (!sourceRows.length) {
    issues.warnings.push(`Лист ${sheetName} пустой. Используется значение из интерфейса.`);
    return { value: null, issues };
  }
  if (sourceRows.length > 1) issues.warnings.push(`Лист ${sheetName}: используется только первая строка данных.`);
  const item = rowObject(headers, sourceRows[0]);
  const rowLabel = `${sheetName}, строка 2`;
  const date = normalizeDate(item.date);
  if (!date) issues.errors.push(`${rowLabel}: некорректная дата.`);
  return {
    value: {
      date: date ?? fallbackDate,
      openingBalance: normalizeNumber(item.opening_balance, "Входящий остаток", rowLabel, issues, { nonNegative: true })
    },
    issues
  };
}

function normalizedText(value) {
  return String(value ?? "").trim();
}

function requiredText(value, fieldName, rowLabel, issues) {
  const text = normalizedText(value);
  if (!text) issues.errors.push(`${rowLabel}: пустой ${fieldName}.`);
  return text;
}

function normalizeMinorAmount(value, fieldName, rowLabel, issues) {
  const amount = normalizeNumber(value, fieldName, rowLabel, issues, { positive: true });
  if (!Number.isSafeInteger(amount)) issues.errors.push(`${rowLabel}: ${fieldName} должен быть целым числом копеек.`);
  return amount;
}

function normalizeInteger(value, fieldName, rowLabel, issues, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = normalizeNumber(value, fieldName, rowLabel, issues, { nonNegative: min >= 0 });
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    issues.errors.push(`${rowLabel}: ${fieldName} должен быть целым числом от ${min} до ${max}.`);
  }
  return number;
}

function normalizeConfirmed(value, rowLabel, issues) {
  const text = normalizedText(value).toLowerCase();
  const known = ["true", "1", "yes", "y", "да", "истина", "false", "0", "no", "n", "нет", "ложь"];
  if (typeof value !== "boolean" && !known.includes(text)) issues.errors.push(`${rowLabel}: confirmed должен быть true/false или да/нет.`);
  return normalizeBoolean(value);
}

export function parseCanonicalReceivables(rows, fallbackDate, sheetName = "Receivables") {
  const issues = createIssues();
  const headers = validateHeaders(rows, REQUIRED_CANONICAL_RECEIVABLE_HEADERS, sheetName, issues);
  const receivables = nonEmptyRows(rows).map((row, index) => {
    const item = rowObject(headers, row);
    const rowLabel = `${sheetName}, строка ${index + 2}`;
    const dueDate = normalizeDate(item.contractual_due_date);
    if (!dueDate) issues.errors.push(`${rowLabel}: некорректная contractual_due_date.`);
    return {
      legalEntityId: requiredText(item.legal_entity_id, "legal_entity_id", rowLabel, issues),
      receivableId: requiredText(item.receivable_id, "receivable_id", rowLabel, issues),
      paymentScheduleId: requiredText(item.payment_schedule_id, "payment_schedule_id", rowLabel, issues),
      counterpartyId: requiredText(item.counterparty_id, "counterparty_id", rowLabel, issues),
      counterpartyName: requiredText(item.counterparty_name, "counterparty_name", rowLabel, issues),
      contractId: requiredText(item.contract_id, "contract_id", rowLabel, issues),
      contractualDueDate: dueDate ?? fallbackDate,
      originalAmountMinor: normalizeMinorAmount(item.original_amount_minor, "original_amount_minor", rowLabel, issues),
      currency: requiredText(item.currency, "currency", rowLabel, issues).toUpperCase(),
      status: requiredText(item.status, "status", rowLabel, issues).toLowerCase(),
      _sourceRow: index + 2
    };
  });
  receivables.importIssues = issues;
  return receivables;
}

export function parsePayments(rows, fallbackDate, sheetName = "Bank") {
  const issues = createIssues();
  const headers = validateHeaders(rows, REQUIRED_PAYMENT_HEADERS, sheetName, issues);
  const payments = nonEmptyRows(rows).map((row, index) => {
    const item = rowObject(headers, row);
    const rowLabel = `${sheetName}, строка ${index + 2}`;
    const bookingDate = normalizeDate(item.booking_date);
    if (!bookingDate) issues.errors.push(`${rowLabel}: некорректная booking_date.`);
    return {
      paymentId: requiredText(item.payment_id, "payment_id", rowLabel, issues),
      legalEntityId: requiredText(item.legal_entity_id, "legal_entity_id", rowLabel, issues),
      payerId: requiredText(item.payer_id, "payer_id", rowLabel, issues),
      payerName: requiredText(item.payer_name, "payer_name", rowLabel, issues),
      bookingDate: bookingDate ?? fallbackDate,
      amountMinor: normalizeMinorAmount(item.amount_minor, "amount_minor", rowLabel, issues),
      currency: requiredText(item.currency, "currency", rowLabel, issues).toUpperCase(),
      bankReference: requiredText(item.bank_reference, "bank_reference", rowLabel, issues),
      purpose: normalizedText(item.purpose),
      _sourceRow: index + 2
    };
  });
  payments.importIssues = issues;
  return payments;
}

export function parseAllocations(rows, sheetName = "Allocations") {
  const issues = createIssues();
  const headers = validateHeaders(rows, REQUIRED_ALLOCATION_HEADERS, sheetName, issues);
  const allocations = nonEmptyRows(rows).map((row, index) => {
    const item = rowObject(headers, row);
    const rowLabel = `${sheetName}, строка ${index + 2}`;
    return {
      allocationId: requiredText(item.allocation_id, "allocation_id", rowLabel, issues),
      paymentId: requiredText(item.payment_id, "payment_id", rowLabel, issues),
      receivableId: requiredText(item.receivable_id, "receivable_id", rowLabel, issues),
      paymentScheduleId: requiredText(item.payment_schedule_id, "payment_schedule_id", rowLabel, issues),
      amountMinor: normalizeMinorAmount(item.amount_minor, "amount_minor", rowLabel, issues),
      method: requiredText(item.method, "method", rowLabel, issues).toLowerCase(),
      confidenceBps: normalizeInteger(item.confidence_bps, "confidence_bps", rowLabel, issues, { min: 0, max: 10_000 }),
      confirmed: normalizeConfirmed(item.confirmed, rowLabel, issues),
      _sourceRow: index + 2
    };
  });
  allocations.importIssues = issues;
  return allocations;
}

function findSheet(sheets, aliases) {
  const key = Object.keys(sheets).find((name) => aliases.includes(name));
  return key ? { name: key, rows: sheets[key] } : null;
}

export function validateWorkbookSheets(sheets, { fallbackDate }) {
  const canonicalReceivablesSheet = findSheet(sheets, ["Receivables", "Задолженность", "ДЗ"]);
  const bankSheet = findSheet(sheets, ["Bank", "Банк", "Банковские поступления"]);
  const allocationsSheet = findSheet(sheets, ["Allocations", "Аллокации", "Сверка"]);
  const receiptsSheet = findSheet(sheets, ["Receipts", "Поступления", "Входящие", "Incoming"]);
  const outflowsSheet = findSheet(sheets, ["Outflows", "Исходящие", "Платежи", "Payments"]);
  const balanceSheet = findSheet(sheets, ["Balances", "Остатки", "Остатки денежных средств", "Cash"]);
  const modelSheet = findSheet(sheets, ["Лист1"]);
  const structuralErrors = [];

  if (canonicalReceivablesSheet) {
    if (!bankSheet) structuralErrors.push("Для канонического формата не найден обязательный лист Bank (или Банк). ");
    if (!outflowsSheet) structuralErrors.push("Для канонического формата не найден обязательный лист Outflows (или Исходящие). ");
    if (structuralErrors.length) {
      throw new WorkbookValidationError({
        errors: structuralErrors.map((item) => item.trim()),
        warnings: [],
        summary: "Файл не загружен: нарушена структура канонической книги."
      });
    }
    const balances = balanceSheet
      ? parseBalances(balanceSheet.rows, fallbackDate, balanceSheet.name)
      : { value: null, issues: { errors: [], warnings: ["Лист Остатки не найден. Используется значение из интерфейса."] } };
    const asOfDate = balances.value?.date ?? fallbackDate;
    const receivables = parseCanonicalReceivables(canonicalReceivablesSheet.rows, asOfDate, canonicalReceivablesSheet.name);
    const payments = parsePayments(bankSheet.rows, asOfDate, bankSheet.name);
    const allocations = allocationsSheet
      ? parseAllocations(allocationsSheet.rows, allocationsSheet.name)
      : Object.assign([], { importIssues: { errors: [], warnings: ["Лист Allocations не найден: используется только детерминированный автоматический матчинг."] } });
    const outflows = parseOutflows(outflowsSheet.rows, asOfDate, outflowsSheet.name);
    const errors = [
      ...receivables.importIssues.errors,
      ...payments.importIssues.errors,
      ...allocations.importIssues.errors,
      ...outflows.importIssues.errors,
      ...balances.issues.errors
    ];
    const warnings = [
      ...receivables.importIssues.warnings,
      ...payments.importIssues.warnings,
      ...allocations.importIssues.warnings,
      ...outflows.importIssues.warnings,
      ...balances.issues.warnings
    ];
    if (!receivables.length) errors.push("Лист Receivables не содержит строк данных.");
    if (errors.length) throw new WorkbookValidationError({ errors, warnings, summary: "Файл не загружен: найдены ошибки канонических данных." });
    return {
      kind: "canonical",
      asOfDate,
      receivables,
      payments,
      allocations,
      outflows,
      balance: balances.value,
      report: {
        errors: [],
        warnings,
        summary: `Канонические данные готовы: ${receivables.length} ДЗ, ${payments.length} банковских платежей, ${allocations.length} аллокаций.`
      }
    };
  }

  if (!receiptsSheet && !modelSheet) structuralErrors.push("Не найден обязательный лист Поступления (или Receipts). ");
  if (!outflowsSheet && !modelSheet) structuralErrors.push("Не найден обязательный лист Исходящие (или Outflows). ");
  if (structuralErrors.length) {
    throw new WorkbookValidationError({
      errors: structuralErrors.map((item) => item.trim()),
      warnings: [],
      summary: "Файл не загружен: нарушена структура книги."
    });
  }

  const receipts = modelSheet && !receiptsSheet
    ? parseModelContracts(modelSheet.rows, fallbackDate)
    : parseReceipts(receiptsSheet.rows, fallbackDate, receiptsSheet.name);
  const outflows = outflowsSheet
    ? parseOutflows(outflowsSheet.rows, fallbackDate, outflowsSheet.name)
    : Object.assign([], { importIssues: { errors: [], warnings: ["Лист Исходящие не найден. Для модельного примера используются нулевые списания."] } });
  const balances = balanceSheet
    ? parseBalances(balanceSheet.rows, fallbackDate, balanceSheet.name)
    : { value: null, issues: { errors: [], warnings: ["Лист Остатки не найден. Используется значение из интерфейса."] } };
  const errors = [...receipts.importIssues.errors, ...outflows.importIssues.errors, ...balances.issues.errors];
  const warnings = [...receipts.importIssues.warnings, ...outflows.importIssues.warnings, ...balances.issues.warnings];

  if (!receipts.length) errors.push("Лист Поступления не содержит корректных строк данных.");
  if (!outflows.length && !modelSheet) errors.push("Лист Исходящие не содержит строк данных.");
  if (errors.length) {
    throw new WorkbookValidationError({ errors, warnings, summary: "Файл не загружен: найдены ошибки в исходных данных." });
  }
  return {
    kind: "legacy",
    receipts,
    outflows,
    balance: balances.value,
    report: {
      errors: [],
      warnings,
      summary: `Файл готов к расчету: ${receipts.length} поступлений и ${outflows.length} исходящих платежей.`
    }
  };
}

const RUB = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0
});

const DATE = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short" });

const demoForecastStartDate = new Date("2026-06-30T00:00:00");
let forecastStartDate = new Date(demoForecastStartDate);
const msDay = 24 * 60 * 60 * 1000;

const state = {
  scenario: "p50",
  stress: false,
  openingBalance: 500_000,
  funding: {
    overdraftLimit: 0,
    factoringLimit: 0,
    creditLineLimit: 0,
    liquidityReserve: 0
  },
  receipts: [],
  outflows: [],
  importReport: {
    errors: [],
    warnings: [],
    summary: "Используются демо-данные."
  }
};

const scenarioLabels = {
  p50: "P50",
  p80: "P80",
  p90: "P90",
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
  state.funding = {
    overdraftLimit: 0,
    factoringLimit: 0,
    creditLineLimit: 0,
    liquidityReserve: 0
  };
  state.receipts = parseReceipts(demoReceipts);
  state.outflows = parseOutflows(demoOutflows);
  syncBalanceControls("Модель ООО Ромашка: стартовый остаток 500 000 руб., дата старта 30 июня 2026.");
  syncFundingControls();
  const excelInput = document.querySelector("#excelInput");
  if (excelInput) {
    excelInput.value = "";
  }
  setUploadStatus("Используются демо-данные. Можно загрузить типовой Excel и пересчитать модель.", "neutral");
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
    overdraftLimitInput: state.funding.overdraftLimit,
    factoringLimitInput: state.funding.factoringLimit,
    creditLineLimitInput: state.funding.creditLineLimit,
    liquidityReserveInput: state.funding.liquidityReserve
  };
  Object.entries(bindings).forEach(([id, value]) => {
    const input = document.querySelector(`#${id}`);
    if (input) input.value = String(Math.round(value));
  });
}

function setScenario(scenario) {
  const nextScenario = scenarioLabels[scenario] ? scenario : "p50";
  state.scenario = nextScenario;
  state.stress = nextScenario === "stress";

  document.querySelectorAll(".segmented button").forEach((button) => {
    button.classList.toggle("active", button.dataset.scenario === nextScenario);
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
  container.innerHTML = `
    <strong>${summary}</strong>
    ${items.length ? `<ul>${items.map((item) => `<li>${item}</li>`).join("")}${more > 0 ? `<li>Еще ${more} замечаний. Исправьте первые ошибки и повторите загрузку.</li>` : ""}</ul>` : "<span>Ошибок структуры не найдено.</span>"}
  `;
}

function normalizeNumber(value, fieldName, rowLabel, issues, options = {}) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value ?? "").trim();
  if (!raw) {
    issues.errors.push(`${rowLabel}: пустое значение ${fieldName}.`);
    return 0;
  }

  const cleaned = raw
    .replace(/\s/g, "")
    .replace(/руб\.?|₽/gi, "")
    .replace("%", "")
    .replace(",", ".");
  const parsed = Number(cleaned);

  if (!Number.isFinite(parsed)) {
    issues.errors.push(`${rowLabel}: не удалось прочитать ${fieldName}="${raw}" как число.`);
    return 0;
  }

  if (options.nonNegative && parsed < 0) {
    issues.errors.push(`${rowLabel}: ${fieldName} не может быть отрицательным.`);
  }

  return parsed;
}

function normalizeOptionalNumber(value, fieldName, rowLabel, issues, options = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return normalizeNumber(value, fieldName, rowLabel, issues, options);
}

function normalizeRate(value, fieldName, rowLabel, issues) {
  const rawText = String(value ?? "").trim();
  let parsed = normalizeNumber(value, fieldName, rowLabel, issues, { nonNegative: true });

  if (rawText.includes("%") || parsed > 1) {
    if (parsed <= 100) {
      parsed = parsed / 100;
      issues.warnings.push(`${rowLabel}: ${fieldName} прочитан как процент и преобразован в долю.`);
    } else {
      issues.errors.push(`${rowLabel}: ${fieldName} должен быть от 0 до 1 или от 0% до 100%.`);
    }
  }

  if (parsed > 1) {
    issues.errors.push(`${rowLabel}: ${fieldName} должен быть не больше 1.`);
  }

  return clamp(parsed, 0, 1);
}

function normalizeOptionalRate(value, fieldName, rowLabel, issues) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  return normalizeRate(value, fieldName, rowLabel, issues);
}

function normalizeDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    const excelEpoch = Date.UTC(1899, 11, 30);
    return new Date(excelEpoch + value * msDay);
  }
  const text = String(value ?? "").trim();
  if (!text) return null;
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00`);
  const ruMatch = text.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/);
  if (ruMatch) {
    const [, day, month, year] = ruMatch;
    return new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00`);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "y", "да", "истина"].includes(text)) return true;
  if (["false", "0", "no", "n", "нет", "ложь"].includes(text)) return false;
  return false;
}

function normalizeDelayHistory(value, rowLabel, issues) {
  if (value === undefined || value === null || String(value).trim() === "") return [];
  const parts = String(value).split(/[;,]/).map((part) => part.trim()).filter(Boolean);
  const delays = parts.map((part) => Number(part.replace(",", "."))).filter((item) => Number.isFinite(item) && item >= 0);
  if (parts.length && delays.length !== parts.length) {
    issues.warnings.push(`${rowLabel}: часть значений в истории задержек не распознана.`);
  }
  return delays;
}

function normalizeHeader(value) {
  return String(value ?? "").trim();
}

const headerAliases = {
  invoice_id: ["invoice_id", "номер счета", "номер счёта", "счет", "счёт", "номер документа", "документ", "invoice", "invoice id"],
  counterparty: ["counterparty", "контрагент", "дебитор", "клиент", "покупатель"],
  amount: ["amount", "сумма", "сумма платежа", "сумма поступления", "плановая сумма", "сумма постоплаты"],
  planned_date: ["planned_date", "плановая дата оплаты", "дата оплаты", "плановая дата", "дата поступления", "плановая дата поступления"],
  actual_payment_date: ["actual_payment_date", "фактическая дата оплаты", "фактическая дата оплаты ", "факт оплаты", "дата факта", "фактическая дата поступления"],
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
  opening_balance: ["opening_balance", "входящий остаток", "входящий остаток денежных средств", "остаток денежных средств", "стартовый остаток", "остаток"]
};

function canonicalHeader(value) {
  const normalized = normalizeHeader(value).toLowerCase().replace(/\s+/g, " ");
  const found = Object.entries(headerAliases).find(([, aliases]) => aliases.includes(normalized));
  return found ? found[0] : normalizeHeader(value);
}

function validateHeaders(headers, required, sheetName) {
  const present = new Set(headers.map(canonicalHeader));
  const missing = required.filter((key) => !present.has(key));
  if (missing.length) {
    throw new Error(`На листе ${sheetName} не хватает колонок: ${missing.join(", ")}. Можно использовать русские названия из шаблона.`);
  }
}

function parseReceipts(rows) {
  const issues = { errors: [], warnings: [] };
  const headers = rows[0].map(canonicalHeader);
  validateHeaders(headers, ["invoice_id", "counterparty", "amount", "planned_date", "due_days"], "Receipts");
  const receipts = rows.slice(1).filter((row) => row.some((cell) => String(cell ?? "").trim() !== "")).map((row, idx) => {
    const item = Object.fromEntries(headers.map((key, idx) => [key, row[idx]]));
    const rowLabel = `Receipts строка ${idx + 2}${item.invoice_id ? ` (${item.invoice_id})` : ""}`;
    const plannedDate = normalizeDate(item.planned_date);
    if (!plannedDate) {
      issues.errors.push(`${rowLabel}: некорректная planned_date.`);
    }
    if (!item.invoice_id) {
      issues.errors.push(`${rowLabel}: пустой invoice_id.`);
    }
    if (!item.counterparty) {
      issues.errors.push(`${rowLabel}: пустой counterparty.`);
    }
    return {
      id: item.invoice_id,
      counterparty: item.counterparty,
      amount: normalizeNumber(item.amount, "amount", rowLabel, issues, { nonNegative: true }),
      plannedDate: plannedDate ?? forecastStartDate,
      dueDays: normalizeNumber(item.due_days, "due_days", rowLabel, issues, { nonNegative: true }),
      avgDelay: item.avg_delay === undefined ? null : normalizeOptionalNumber(item.avg_delay, "avg_delay", rowLabel, issues, { nonNegative: true }),
      late5: item.late_5 === undefined ? 0 : normalizeOptionalRate(item.late_5, "late_5", rowLabel, issues),
      late10: item.late_10 === undefined ? 0 : normalizeOptionalRate(item.late_10, "late_10", rowLabel, issues),
      late30: item.late_30 === undefined ? 0 : normalizeOptionalRate(item.late_30, "late_30", rowLabel, issues),
      openAr: item.open_ar === undefined ? 0 : normalizeOptionalNumber(item.open_ar, "open_ar", rowLabel, issues, { nonNegative: true }) ?? 0,
      documentsOk: item.documents_ok === undefined ? true : normalizeBoolean(item.documents_ok),
      bankMatch: item.bank_match === undefined ? true : normalizeBoolean(item.bank_match),
      historyTotal: item.history_total === undefined ? null : normalizeOptionalNumber(item.history_total, "history_total", rowLabel, issues, { nonNegative: true }),
      historyOnTime: item.history_on_time === undefined ? null : normalizeOptionalNumber(item.history_on_time, "history_on_time", rowLabel, issues, { nonNegative: true }),
      historyAvgDelay: item.history_avg_delay === undefined ? null : normalizeOptionalNumber(item.history_avg_delay, "history_avg_delay", rowLabel, issues, { nonNegative: true }),
      historyWorstDelay: item.history_worst_delay === undefined ? null : normalizeOptionalNumber(item.history_worst_delay, "history_worst_delay", rowLabel, issues, { nonNegative: true }),
      historyDelays: normalizeDelayHistory(item.history_delays, rowLabel, issues)
    };
  });
  receipts.importIssues = issues;
  return receipts;
}

function parseModelContracts(rows) {
  const issues = { errors: [], warnings: [] };
  const headers = rows[0].map(canonicalHeader);
  validateHeaders(headers, ["invoice_id", "counterparty", "amount", "planned_date", "due_days"], "Лист1");
  const contracts = rows.slice(1).filter((row) => row.some((cell) => String(cell ?? "").trim() !== "")).map((row, idx) => {
    const item = Object.fromEntries(headers.map((key, idx) => [key, row[idx]]));
    const rowLabel = `Лист1 строка ${idx + 2}${item.invoice_id ? ` (${item.invoice_id})` : ""}`;
    const plannedDate = normalizeDate(item.planned_date);
    const factDate = normalizeDate(item.actual_payment_date);
    if (!plannedDate) issues.errors.push(`${rowLabel}: некорректная плановая дата оплаты.`);
    if (!item.counterparty) issues.errors.push(`${rowLabel}: пустой контрагент.`);
    const delay = factDate && plannedDate
      ? Math.max(0, daysBetween(factDate, plannedDate))
      : normalizeOptionalNumber(item.avg_delay, "Средняя задержка", rowLabel, issues, { nonNegative: true });
    if (delay === null) {
      issues.errors.push(`${rowLabel}: укажите фактическую дату оплаты или среднюю задержку.`);
    }
    return {
      id: item.invoice_id,
      counterparty: item.counterparty,
      amount: normalizeNumber(item.amount, "amount", rowLabel, issues, { nonNegative: true }),
      plannedDate: plannedDate ?? forecastStartDate,
      dueDays: normalizeNumber(item.due_days, "due_days", rowLabel, issues, { nonNegative: true }),
      delay: delay ?? 0
    };
  });
  if (issues.errors.length) {
    const receipts = [];
    receipts.importIssues = issues;
    return receipts;
  }
  const last = contracts[contracts.length - 1];
  const delays = contracts.map((item) => item.delay);
  const nextNumber = contracts.length + 1;
  const nextPlannedDate = last ? addDays(last.plannedDate, last.dueDays || 30) : forecastStartDate;
  const avgDelay = delays.length ? delays.reduce((sum, delay) => sum + delay, 0) / delays.length : 0;
  const receipt = {
    id: `Договор №${nextNumber}`,
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

function parseOutflows(rows) {
  const issues = { errors: [], warnings: [] };
  const headers = rows[0].map(canonicalHeader);
  validateHeaders(headers, ["date", "category", "amount", "criticality"], "Outflows");
  const outflows = rows.slice(1).filter((row) => row.some((cell) => String(cell ?? "").trim() !== "")).map((row, idx) => {
    const item = Object.fromEntries(headers.map((key, idx) => [key, row[idx]]));
    const rowLabel = `Outflows строка ${idx + 2}${item.category ? ` (${item.category})` : ""}`;
    const date = normalizeDate(item.date);
    if (!date) {
      issues.errors.push(`${rowLabel}: некорректная date.`);
    }
    if (!item.category) {
      issues.errors.push(`${rowLabel}: пустой category.`);
    }
    if (!["must-pay", "moveable"].includes(String(item.criticality ?? "").trim())) {
      issues.warnings.push(`${rowLabel}: criticality лучше указать как must-pay или moveable.`);
    }
    return {
      date: date ?? forecastStartDate,
      category: item.category,
      amount: normalizeNumber(item.amount, "amount", rowLabel, issues, { nonNegative: true }),
      criticality: String(item.criticality ?? "").trim() || "must-pay"
    };
  });
  outflows.importIssues = issues;
  return outflows;
}

function parseBalances(rows) {
  const issues = { errors: [], warnings: [] };
  const headers = rows[0].map(canonicalHeader);
  validateHeaders(headers, ["date", "opening_balance"], "Остатки");
  const sourceRows = rows.slice(1).filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""));
  if (!sourceRows.length) {
    issues.warnings.push("Лист Остатки пустой. Используется значение из интерфейса.");
    return { value: null, issues };
  }

  const item = Object.fromEntries(headers.map((key, idx) => [key, sourceRows[0][idx]]));
  const date = normalizeDate(item.date);
  const rowLabel = "Остатки строка 2";
  if (!date) {
    issues.errors.push(`${rowLabel}: некорректная дата.`);
  }

  return {
    value: {
      date: date ?? forecastStartDate,
      openingBalance: normalizeNumber(item.opening_balance, "Входящий остаток", rowLabel, issues, { nonNegative: true })
    },
    issues
  };
}

async function inflateRaw(bytes) {
  if (!("DecompressionStream" in window)) {
    throw new Error("Браузер не поддерживает распаковку Excel ZIP. Откройте MVP в Chrome или Edge.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeText(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

async function unzipXlsx(buffer) {
  const bytes = new Uint8Array(buffer);
  const entries = new Map();
  const u16 = (offset) => bytes[offset] | (bytes[offset + 1] << 8);
  const u32 = (offset) => (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  let eocdOffset = -1;

  for (let idx = bytes.length - 22; idx >= Math.max(0, bytes.length - 66000); idx -= 1) {
    if (u32(idx) === eocdSignature) {
      eocdOffset = idx;
      break;
    }
  }

  if (eocdOffset < 0) {
    throw new Error("Не удалось прочитать структуру .xlsx: файл не похож на Excel Workbook.");
  }

  const centralEntries = u16(eocdOffset + 10);
  const centralOffset = u32(eocdOffset + 16);
  let offset = centralOffset;

  for (let entryIdx = 0; entryIdx < centralEntries; entryIdx += 1) {
    if (u32(offset) !== centralSignature) {
      throw new Error("Не удалось прочитать центральный каталог Excel-файла.");
    }

    const method = u16(offset + 10);
    const compressedSize = u32(offset + 20);
    const fileNameLength = u16(offset + 28);
    const extraLength = u16(offset + 30);
    const commentLength = u16(offset + 32);
    const localHeaderOffset = u32(offset + 42);
    const nameStart = offset + 46;
    const name = decodeText(bytes.slice(nameStart, nameStart + fileNameLength)).replace(/\\/g, "/");

    if ([compressedSize, localHeaderOffset].includes(0xffffffff)) {
      throw new Error("ZIP64 Excel-файлы пока не поддерживаются. Сохраните файл как обычный .xlsx без ZIP64.");
    }

    if (u32(localHeaderOffset) !== localSignature) {
      throw new Error(`Не удалось прочитать локальный ZIP-заголовок для ${name}.`);
    }

    const localNameLength = u16(localHeaderOffset + 26);
    const localExtraLength = u16(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);
    let data;

    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      data = await inflateRaw(compressed);
    } else {
      throw new Error(`Неподдерживаемый метод сжатия ZIP: ${method}`);
    }

    entries.set(name, data);
    offset = nameStart + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function parseXml(text) {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  const error = xml.querySelector("parsererror");
  if (error) throw new Error("Не удалось прочитать XML внутри Excel-файла.");
  return xml;
}

function getXmlEntry(entries, path) {
  const data = entries.get(path);
  if (!data) throw new Error(`В Excel-файле не найден ${path}`);
  return parseXml(decodeText(data));
}

function relationshipMap(entries, relsPath) {
  const xml = getXmlEntry(entries, relsPath);
  return Object.fromEntries([...xml.getElementsByTagName("Relationship")].map((rel) => [
    rel.getAttribute("Id"),
    rel.getAttribute("Target")
  ]));
}

function normalizeTarget(baseDir, target) {
  if (target.startsWith("/")) return target.slice(1);
  const stack = baseDir.split("/").filter(Boolean);
  target.split("/").forEach((part) => {
    if (part === "..") stack.pop();
    else if (part !== ".") stack.push(part);
  });
  return stack.join("/");
}

function readSharedStrings(entries) {
  if (!entries.has("xl/sharedStrings.xml")) return [];
  const xml = getXmlEntry(entries, "xl/sharedStrings.xml");
  return [...xml.getElementsByTagName("si")].map((si) => [...si.getElementsByTagName("t")].map((t) => t.textContent).join(""));
}

function columnIndex(cellRef) {
  const letters = String(cellRef ?? "").match(/[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  return [...letters].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function cellValue(cell, sharedStrings) {
  const type = cell.getAttribute("t");
  if (type === "inlineStr") {
    return [...cell.getElementsByTagName("t")].map((node) => node.textContent).join("");
  }

  const value = cell.getElementsByTagName("v")[0]?.textContent ?? "";
  if (type === "s") return sharedStrings[Number(value)] ?? "";
  if (type === "b") return value === "1";
  if (value === "") return "";

  const number = Number(value);
  return Number.isNaN(number) ? value : number;
}

function readSheetRows(xml, sharedStrings) {
  const rows = [...xml.getElementsByTagName("row")];
  return rows.map((row) => {
    const result = [];
    [...row.getElementsByTagName("c")].forEach((cell) => {
      result[columnIndex(cell.getAttribute("r"))] = cellValue(cell, sharedStrings);
    });
    return result.map((value) => value ?? "");
  });
}

async function readExcelFile(file) {
  if (!file) throw new Error("Выберите Excel-файл .xlsx.");
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    throw new Error("Сейчас поддерживается формат .xlsx. Сохраните файл как Excel Workbook (*.xlsx).");
  }

  const entries = await unzipXlsx(await file.arrayBuffer());
  const workbook = getXmlEntry(entries, "xl/workbook.xml");
  const rels = relationshipMap(entries, "xl/_rels/workbook.xml.rels");
  const sharedStrings = readSharedStrings(entries);
  const sheets = {};

  [...workbook.getElementsByTagName("sheet")].forEach((sheet) => {
    const name = sheet.getAttribute("name");
    const relId = sheet.getAttribute("r:id");
    const target = rels[relId];
    if (!target) return;
    const path = normalizeTarget("xl", target);
    sheets[name] = readSheetRows(getXmlEntry(entries, path), sharedStrings);
  });

  const receiptsRows = sheets.Receipts ?? sheets["Поступления"] ?? sheets["Входящие"] ?? sheets.Incoming;
  const outflowsRows = sheets.Outflows ?? sheets["Исходящие"] ?? sheets["Платежи"] ?? sheets.Payments;
  const balanceRows = sheets.Balances ?? sheets["Остатки"] ?? sheets["Остатки денежных средств"] ?? sheets.Cash;
  const modelRows = sheets["Лист1"];

  if (!receiptsRows && !modelRows) {
    throw new Error("В Excel-файле должен быть лист Поступления или модельный лист Лист1.");
  }
  if (!outflowsRows && !modelRows) {
    throw new Error("В Excel-файле должны быть листы Поступления и Исходящие. Английские варианты Receipts и Outflows тоже поддерживаются.");
  }

  const receipts = modelRows && !receiptsRows ? parseModelContracts(modelRows) : parseReceipts(receiptsRows);
  const outflows = outflowsRows ? parseOutflows(outflowsRows) : (() => {
    const items = [];
    items.importIssues = { errors: [], warnings: ["Лист Исходящие не найден. Для модельного примера используются нулевые списания."] };
    return items;
  })();
  const balances = balanceRows ? parseBalances(balanceRows) : { value: null, issues: { errors: [], warnings: ["Лист Остатки не найден. Используется значение из интерфейса."] } };
  const errors = [...(receipts.importIssues?.errors ?? []), ...(outflows.importIssues?.errors ?? []), ...(balances.issues?.errors ?? [])];
  const warnings = [...(receipts.importIssues?.warnings ?? []), ...(outflows.importIssues?.warnings ?? []), ...(balances.issues?.warnings ?? [])];

  if (!receipts.length) errors.push("Лист Receipts не содержит строк данных.");
  if (!outflows.length && !modelRows) errors.push("Лист Outflows не содержит строк данных.");

  if (errors.length) {
    state.importReport = {
      errors,
      warnings,
      summary: "Файл не загружен: найдены ошибки в исходных данных."
    };
    renderImportReport();
    throw new Error("В Excel-файле есть ошибки. Смотрите отчет качества загрузки ниже.");
  }

  state.importReport = {
    errors: [],
    warnings,
    summary: `Файл готов к расчету: ${receipts.length} поступлений и ${outflows.length} исходящих платежей.`
  };
  renderImportReport();

  return {
    receipts,
    outflows,
    balance: balances.value
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function daysBetween(a, b) {
  return Math.round((a.getTime() - b.getTime()) / msDay);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function percentileDelay(delays, percentile) {
  if (!delays.length) return 0;
  const sorted = delays.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1));
  return Math.round(sorted[index]);
}

function buildTimingFromFallback(receipt) {
  if (receipt.avgDelay === null || receipt.avgDelay === undefined) {
    return { p50: 0, p80: 0, p90: 0, stress: 0, source: "new" };
  }
  let p50 = Math.max(0, Math.round(receipt.avgDelay * 0.5));
  let p80 = Math.max(p50, Math.round(receipt.avgDelay * 1.0));
  let p90 = Math.max(p80, Math.round(receipt.avgDelay * 1.3));
  let stress = Math.max(p90, Math.round(receipt.avgDelay * 1.6));
  if (!receipt.documentsOk) {
    p50 += 4;
    p80 += 4;
    p90 += 4;
    stress += 4;
  }
  if (!receipt.bankMatch) {
    p50 += 2;
    p80 += 2;
    p90 += 2;
    stress += 2;
  }
  if (receipt.late30 >= 0.3) {
    stress = Math.max(stress, 30);
  }
  return { p50, p80, p90, stress, source: "fallback" };
}

function scoreReceipt(receipt) {
  const historyDelays = receipt.historyDelays?.length
    ? receipt.historyDelays
    : receipt.historyTotal && receipt.historyAvgDelay !== null && receipt.historyWorstDelay !== null
      ? [0, receipt.historyAvgDelay, receipt.historyWorstDelay]
      : [];
  const timing = historyDelays.length
    ? {
      p50: percentileDelay(historyDelays, 0.5),
      p80: percentileDelay(historyDelays, 0.8),
      p90: percentileDelay(historyDelays, 0.9),
      stress: Math.max(...historyDelays),
      source: "history"
    }
    : buildTimingFromFallback(receipt);
  const onTimeCount = historyDelays.length ? historyDelays.filter((delay) => delay === 0).length : null;
  const onTimeProbability = historyDelays.length ? onTimeCount / historyDelays.length : timing.source === "new" ? 1 : null;
  const p50Date = addDays(receipt.plannedDate, timing.p50);
  const p80Date = addDays(receipt.plannedDate, timing.p80);
  const p90Date = addDays(receipt.plannedDate, timing.p90);
  const stressDate = addDays(receipt.plannedDate, timing.stress);
  const riskWindow = `${DATE.format(receipt.plannedDate)} — ${DATE.format(p80Date)}`;
  const reason = timing.source === "history"
    ? "история задержек контрагента"
    : timing.source === "new"
      ? "новый контрагент: истории оплат нет"
      : "fallback: средняя задержка, документы и качество данных";
  return {
    ...receipt,
    probability: onTimeProbability ?? 0,
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
    riskAmount: receipt.amount,
    riskWindowStart: receipt.plannedDate,
    riskWindowEnd: p80Date,
    riskWindow,
    shiftReason: reason,
    onTimeProbability,
    scoreExplanation: timing.source === "history"
      ? `P50/P80/P90 по истории задержек: ${historyDelays.join("; ")} дней.`
      : timing.source === "new"
        ? "Нет истории задержек и средней задержки: первый платеж дефолтно ставится в срок, надежность даты 100%, но без исторического скоринга."
        : "P50/P80/P90 по fallback-логике: средняя задержка, документы и матчинг с банком."
  };
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

function scenarioCashDate(receipt, scenario) {
  const delay = receipt.scenarioDelays?.[scenario] ?? receipt.expectedDelay;
  if (delay === null || delay === undefined) return null;
  return addDays(receipt.plannedDate, delay);
}

function buildForecast(scored, scenario) {
  const maxScenarioDate = scored.reduce((maxDate, receipt) => {
    const dates = [receipt.plannedDate, receipt.p50Date, receipt.p80Date, receipt.p90Date, receipt.stressDate].filter(Boolean);
    const receiptMax = dates.reduce((latest, date) => date > latest ? date : latest, maxDate);
    return receiptMax > maxDate ? receiptMax : maxDate;
  }, forecastStartDate);
  const maxOutflowDate = state.outflows.reduce((maxDate, outflow) => outflow.date > maxDate ? outflow.date : maxDate, maxScenarioDate);
  const horizonDays = Math.max(31, daysBetween(maxOutflowDate, forecastStartDate) + 1);
  const days = Array.from({ length: horizonDays }, (_, idx) => {
    const date = addDays(forecastStartDate, idx);
    return {
      date,
      openingBalance: 0,
      plannedIn: 0,
      expectedIn: 0,
      outflow: 0,
      closingBalance: 0,
      financingNeed: 0,
      balance: 0,
      p50Balance: 0,
      p80Balance: 0
    };
  });

  days.forEach((day) => {
    scored.forEach((receipt) => {
      if (daysBetween(receipt.plannedDate, day.date) === 0) {
        day.plannedIn += receipt.amount;
      }
      const cashDate = scenarioCashDate(receipt, scenario);
      if (cashDate && daysBetween(cashDate, day.date) === 0) {
        day.expectedIn += receipt.amount;
      }
    });
    state.outflows.forEach((outflow) => {
      if (daysBetween(outflow.date, day.date) === 0) {
        day.outflow += outflow.amount;
      }
    });
  });

  let balance = state.openingBalance;
  let p50Balance = state.openingBalance;
  let p80Balance = state.openingBalance;

  days.forEach((day) => {
    day.openingBalance = balance;
    balance += day.expectedIn - day.outflow;
    p50Balance += expectedForDay(scored, day.date, "p50") - day.outflow;
    p80Balance += expectedForDay(scored, day.date, "p80") - day.outflow;
    day.balance = balance;
    day.closingBalance = balance;
    day.financingNeed = Math.max(0, -balance);
    day.p50Balance = p50Balance;
    day.p80Balance = p80Balance;
  });

  return days;
}

function expectedForDay(scored, date, scenario) {
  return scored.reduce((sum, receipt) => {
    const cashDate = scenarioCashDate(receipt, scenario);
    if (!cashDate || daysBetween(cashDate, date) !== 0) return sum;
    return sum + receipt.amount;
  }, 0);
}

function formatMoney(value) {
  const sign = value < 0 ? "-" : "";
  return `${sign}${RUB.format(Math.abs(value)).replace("₽", "руб.")}`;
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

function riskPill(value) {
  if (value >= 0.75) return `<span class="pill good">низкий</span>`;
  if (value >= 0.55) return `<span class="pill warn">средний</span>`;
  return `<span class="pill bad">высокий</span>`;
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
  const planned = scored.reduce((sum, item) => sum + item.amount, 0);
  const scenarioCash = scored.reduce((sum, item) => scenarioCashDate(item, state.scenario) ? sum + item.amount : sum, 0);
  const minBalance = Math.min(...forecast.map((day) => day.closingBalance));
  const fundingNeed = Math.max(0, -minBalance);
  const medianShift = scored.length ? Math.round(scored.reduce((sum, item) => sum + item.p50Delay, 0) / scored.length) : 0;
  const shiftedAmount = scored.reduce((sum, item) => item.p50Delay > 0 ? sum + item.amount : sum, 0);

  const metrics = [
    ["Плановые поступления", formatMoney(planned), "полная сумма по договорным датам", "Σ всех плановых входящих платежей в горизонте прогноза.", "Справочная сумма плана: сама по себе не увеличивает остаток денег."],
    [`Сценарный cash-in ${scenarioLabel(state.scenario)}`, formatMoney(scenarioCash), "полная сумма на сценарных датах", "Σ полных сумм платежей, перенесенных на P50/P80/P90/Stress даты.", "Вероятность влияет на дату, а не дробит сумму."],
    ["Максимальный cash gap", formatMoney(fundingNeed), `минимальный исходящий остаток ${formatMoney(minBalance)}`, "MAX(0; -минимальный исходящий остаток по выбранному сценарию).", "Разрыв возникает между договорной датой cash-in и сценарной датой фактической оплаты."],
    ["Медианный сдвиг cash-in", `${medianShift} дн.`, `${formatMoney(shiftedAmount)} сдвинуто после плана`, "Среднее значение P50-сдвига по платежам в текущем наборе.", "Показывает, насколько реалистичная дата обычно позже договорной."]
  ];

  document.querySelector("#metricGrid").innerHTML = metrics.map(([label, value, note, formula, explanation]) => `
    <article class="metric-card" title="${formula} ${explanation}">
      <span>${label}<i class="info-dot" aria-hidden="true">i</i></span>
      <strong>${value}</strong>
      <small>${note}</small>
      <p class="formula-text">${formula}</p>
      <p class="metric-explain">${explanation}</p>
    </article>
  `).join("");
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
  const bars = forecast.map((day, idx) => {
    const barX = x(idx) - 6;
    const plannedH = Math.max(1, day.plannedIn / Math.max(...forecast.map((d) => d.plannedIn), 1) * 70);
    const outH = Math.max(1, day.outflow / Math.max(...forecast.map((d) => d.outflow), 1) * 70);
    return `
      <rect x="${barX}" y="${height - pad - plannedH}" width="5" height="${plannedH}" fill="#2563eb" opacity="0.45"></rect>
      <rect x="${barX + 6}" y="${height - pad - outH}" width="5" height="${outH}" fill="#c2413a" opacity="0.45"></rect>
    `;
  }).join("");

  svg.innerHTML = `
    <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"></rect>
    <line x1="${pad}" y1="${y(0)}" x2="${width - pad}" y2="${y(0)}" stroke="#c2413a" stroke-dasharray="5 5"></line>
    ${bars}
    <polyline fill="none" stroke="#0f9f8e" stroke-width="4" points="${line("balance")}"></polyline>
    <polyline fill="none" stroke="#6d5bd0" stroke-width="2.5" points="${line("p50Balance")}" opacity="0.8"></polyline>
    <polyline fill="none" stroke="#c47b16" stroke-width="2.5" points="${line("p80Balance")}" opacity="0.8"></polyline>
    ${forecast.filter((_, idx) => idx % 5 === 0).map((day, idx) => {
      const pos = idx * 5;
      return `<text x="${x(pos)}" y="${height - 10}" text-anchor="middle" font-size="12" fill="#687487">${DATE.format(day.date)}</text>`;
    }).join("")}
    <text x="${pad}" y="22" font-size="12" fill="#687487">Остаток денег по сценарным датам реального cash-in</text>
  `;
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

  document.querySelector("#gapWarning").className = `gap-warning ${currentMin < 0 ? "danger" : ""}`;
  const riskWindows = scored.map((item) => `${item.counterparty}: ${item.riskWindow}`).join("; ");
  document.querySelector("#gapWarning").innerHTML = `
    <strong>${currentMin < 0 ? "Разрыв вероятен" : "Разрыв не подтвержден"}</strong>
    <p>Разрыв возникает, если обязательные платежи попадают между договорной датой cash-in и сценарной датой фактической оплаты.</p>
    <p>Минимальный исходящий остаток в сценарии ${scenarioLabel(state.scenario)}: ${formatMoney(currentMin)} на ${DATE.format(currentDay.date)}</p>
    <p>Риск-окно: <b>${riskWindows || "нет сдвинутых поступлений"}</b></p>
    <p>Сумма, на которую нужно искать финансирование или останавливать платежи: <b>${formatMoney(reserve)}</b></p>
  `;

  document.querySelector("#scenarioCards").innerHTML = scenarios.map((item) => `
    <div class="scenario-card ${item.scenario === state.scenario ? "active" : ""}" aria-label="Минимальный остаток в сценарии ${scenarioLabel(item.scenario)}">
      <span>${scenarioLabel(item.scenario)}<small>минимальный остаток</small></span>
      <strong>${formatMoney(item.min)}</strong>
    </div>
  `).join("");
}

function renderCalendar(forecast) {
  document.querySelector("#calendarRows").innerHTML = forecast.map((day) => {
    const status = day.closingBalance < 0
      ? `<span class="pill bad">разрыв</span>`
      : day.closingBalance < 5_000_000
        ? `<span class="pill warn">низкий запас</span>`
        : `<span class="pill good">ок</span>`;
    const gapOrSurplus = day.financingNeed > 0
      ? `<span class="pill bad">${formatMoney(day.financingNeed)}</span>`
      : `<span class="pill good">${formatMoney(day.closingBalance)}</span>`;
    return `
      <tr>
        <td>${DATE.format(day.date)}</td>
        <td class="money" title="Входящий остаток = исходящий остаток предыдущего дня">${formatMoney(day.openingBalance)}</td>
        <td class="money muted-money" title="Справочно: договорная дата из платежного календаря. В исходящий остаток не прибавляется напрямую.">${formatMoney(day.plannedIn)}</td>
        <td class="money" title="Сценарные поступления = полная сумма договора на сценарную дату оплаты">${formatMoney(day.expectedIn)}</td>
        <td class="money" title="Списания = обязательные исходящие платежи на дату">${formatMoney(day.outflow)}</td>
        <td class="money" title="Исходящий остаток = входящий остаток + сценарные поступления - списания">${formatMoney(day.closingBalance)}</td>
        <td class="money">${gapOrSurplus}</td>
        <td>${status}</td>
      </tr>
    `;
  }).join("");
}

function renderReceipts(scored) {
  const rows = scored
    .slice()
    .sort((a, b) => b.p80Delay - a.p80Delay)
    .slice(0, 20);

  document.querySelector("#receiptRows").innerHTML = rows.map((item) => `
    <tr>
      <td><strong>${item.counterparty}</strong><br><span>${item.id}</span></td>
      <td class="money">${formatMoney(item.amount)}</td>
      <td>${DATE.format(item.plannedDate)}</td>
      <td>${DATE.format(item.p50Date)}</td>
      <td>${DATE.format(item.p80Date)}</td>
      <td>
        <strong>+${item.p50Delay} / +${item.p80Delay} дн.</strong>
        <small>${item.scoreExplanation}</small>
      </td>
      <td>${item.riskWindow}</td>
      <td><span>${item.shiftReason}</span></td>
    </tr>
  `).join("");
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

  document.querySelector("#debtorCards").innerHTML = debtors.map((item) => `
    <article class="debtor-card">
      <strong>${item.counterparty}</strong>
      <dl>
        <dt>Сдвинутая сумма</dt><dd>${formatMoney(item.shiftedAmount)}</dd>
        <dt>P50 сдвиг</dt><dd>${Math.round(item.p50Delay)} дн.</dd>
        <dt>P80 сдвиг</dt><dd>${Math.round(item.p80Delay)} дн.</dd>
        <dt>Средняя задержка</dt><dd>${item.avgDelay ?? "нет истории"}${item.avgDelay === null || item.avgDelay === undefined ? "" : " дн."}</dd>
      </dl>
    </article>
  `).join("");
}

function renderActions(scored, forecast) {
  const minBalance = Math.min(...forecast.map((day) => day.closingBalance));
  const required = Math.max(0, -minBalance);
  const { overdraftLimit, factoringLimit, creditLineLimit, liquidityReserve } = state.funding;
  const topFactoring = scored
    .filter((item) => item.documentsOk && item.bankMatch && item.p80Delay > 0)
    .sort((a, b) => (b.amount * b.p80Delay) - (a.amount * a.p80Delay))[0] ?? scored
    .slice()
    .sort((a, b) => (b.amount * b.p80Delay) - (a.amount * a.p80Delay))[0];
  const fundingRecommendation = (limit, availableText, missingText) => required <= 0
    ? "Не требуется"
    : limit > 0
      ? availableText
      : missingText;
  const factoringRecommendation = required <= 0
    ? "Не требуется"
    : factoringLimit <= 0
    ? "Нет лимита"
    : topFactoring?.documentsOk && topFactoring?.bankMatch
      ? "Доступен"
      : "Проверить документы и лимит";
  const movable = state.outflows.filter((item) => item.criticality === "moveable").sort((a, b) => b.amount - a.amount)[0];
  if (!topFactoring) {
    document.querySelector("#actionRows").innerHTML = `
      <tr>
        <td colspan="7">Недостаточно данных для расчета рекомендаций. Загрузите поступления.</td>
      </tr>
    `;
    return;
  }
  const actions = [
    ["Овердрафт", Math.min(required, overdraftLimit), "14 дней", "19% годовых", "1 день", "средний", fundingRecommendation(overdraftLimit, "Доступен", "Нет лимита")],
    [`Факторинг по ${topFactoring.counterparty}`, Math.min(required, topFactoring.amount, factoringLimit), topFactoring.riskWindow, "2.1% от суммы", "2-3 дня", "низкий", factoringRecommendation],
    [movable ? `Перенос платежа: ${movable.category}` : "Перенос платежей", required > 0 && movable ? Math.min(required, movable.amount) : 0, movable ? "7 дней" : "—", "0 / риск отношений", movable ? "сегодня" : "—", "средний", required > 0 && movable ? "Опция" : required > 0 ? "Нет исходящих платежей" : "Не требуется"],
    ["Кредитная линия", Math.min(required, creditLineLimit), "30 дней", "18% годовых", "5-10 дней", "низкий", fundingRecommendation(creditLineLimit, "Доступна", "Нет лимита")],
    ["Резерв ликвидности", Math.min(required, liquidityReserve), "сразу", "opportunity cost", "сразу", "низкий", fundingRecommendation(liquidityReserve, "Доступен", "Нет резерва")],
    ["Остановка/перенос части платежей", required, "до даты разрыва", "0 / риск отношений", "сегодня", "средний", required > 0 ? "Подготовить список" : "Не требуется"]
  ];

  document.querySelector("#actionRows").innerHTML = actions.map(([option, amount, term, cost, speed, risk, recommendation]) => `
    <tr>
      <td><strong>${option}</strong></td>
      <td class="money">${formatMoney(amount)}</td>
      <td>${term}</td>
      <td>${cost}</td>
      <td>${speed}</td>
      <td>${risk}</td>
      <td>${recommendation}</td>
    </tr>
  `).join("");
}

function renderIntake() {
  document.querySelector("#intakeList").innerHTML = intakeItems.map(([title, text]) => `
    <label class="check-item">
      <strong><input type="checkbox" checked> ${title}</strong>
      <span>${text}</span>
    </label>
  `).join("");
}

function renderFactors() {
  const items = [
    ["История задержек", "Основной источник P50/P80/P90. В Excel это колонка \"История задержек, дней\": например 0;1;4;14;30."],
    ["Fallback без истории", "Если истории нет, но есть средняя задержка, документы и банковский матчинг, MVP строит осторожную дату по этим признакам."],
    ["Новый контрагент", "Если это первый платеж и истории нет, MVP ставит P50/P80/P90/Stress на договорную дату, надежность срока 100%, но помечает расчет как \"нет истории\"."],
    ["Сценарии", "P50/P80/P90/Stress меняют дату полного платежа. Сумма платежа не дробится по вероятности."]
  ];

  document.querySelector("#riskFactors").innerHTML = items.map(([title, text]) => `
    <div class="factor-item">
      <strong>${title}</strong>
      <span>${text}</span>
    </div>
  `).join("");
}

function exportReport() {
  const scored = state.receipts.map(scoreReceipt).sort((a, b) => b.p80Delay - a.p80Delay);
  const header = ["invoice_id","counterparty","amount","planned_date","p50_date","p80_date","p90_date","stress_date","p50_shift_days","p80_shift_days","risk_window"];
  const rows = scored.map((item) => [
    item.id,
    item.counterparty,
    item.amount,
    item.plannedDate.toISOString().slice(0, 10),
    item.p50Date.toISOString().slice(0, 10),
    item.p80Date.toISOString().slice(0, 10),
    item.p90Date.toISOString().slice(0, 10),
    item.stressDate.toISOString().slice(0, 10),
    item.p50Delay,
    item.p80Delay,
    item.riskWindow
  ]);
  const escapeCsv = (value) => {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = [header, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "cash-in-risk-audit.csv";
  link.click();
  URL.revokeObjectURL(url);
}

document.querySelector("#exportButton").addEventListener("click", exportReport);

document.querySelector("#loadSampleButton").addEventListener("click", () => {
  loadDemo();
  render();
});

document.querySelector("#parseExcelButton").addEventListener("click", async () => {
  try {
    const file = document.querySelector("#excelInput").files[0];
    setUploadStatus("Читаю Excel-файл и пересчитываю модель...", "neutral");
    const data = await readExcelFile(file);
    state.receipts = data.receipts;
    state.outflows = data.outflows;
    if (data.balance) {
      forecastStartDate = data.balance.date;
      state.openingBalance = data.balance.openingBalance;
      syncBalanceControls("Источник: лист Остатки из загруженного Excel. Можно изменить вручную.");
    } else {
      const inferredStartDate = inferForecastStartDate(state.receipts, state.outflows);
      if (inferredStartDate) {
        forecastStartDate = inferredStartDate;
        syncBalanceControls("Источник: дата старта автоматически взята из загруженных поступлений/исходящих. Остаток — из интерфейса.");
      } else {
        syncBalanceControls("Источник: значение из интерфейса. Лист Остатки в Excel не найден.");
      }
    }
    render();
    setUploadStatus(`Загружено: ${file.name}. Поступлений: ${state.receipts.length}, исходящих платежей: ${state.outflows.length}.`, "success");
  } catch (error) {
    setUploadStatus(error.message, "error");
  }
});

document.querySelector("#openingBalanceInput").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  state.openingBalance = Number.isFinite(value) ? Math.max(0, value) : 0;
  const source = document.querySelector("#openingBalanceSource");
  if (source) source.textContent = "Источник: ручной ввод во фронте.";
  render();
});

[
  ["#overdraftLimitInput", "overdraftLimit"],
  ["#factoringLimitInput", "factoringLimit"],
  ["#creditLineLimitInput", "creditLineLimit"],
  ["#liquidityReserveInput", "liquidityReserve"]
].forEach(([selector, key]) => {
  const updateFundingLimit = (event) => {
    const value = Number(event.target.value);
    state.funding[key] = Number.isFinite(value) ? Math.max(0, value) : 0;
    render();
  };
  document.querySelector(selector)?.addEventListener("input", updateFundingLimit);
  document.querySelector(selector)?.addEventListener("change", updateFundingLimit);
});

document.querySelector("#startDateInput").addEventListener("change", (event) => {
  const date = normalizeDate(event.target.value);
  if (date) {
    forecastStartDate = date;
    const source = document.querySelector("#openingBalanceSource");
    if (source) source.textContent = "Источник: ручной ввод во фронте.";
    render();
  }
});

document.querySelector("#stressModeButton").addEventListener("click", () => {
  setScenario(state.scenario === "stress" ? "p50" : "stress");
  render();
});

document.querySelectorAll(".segmented button").forEach((button) => {
  button.addEventListener("click", () => {
    setScenario(button.dataset.scenario);
    render();
  });
});

loadDemo();
syncFundingControls();
setScenario(state.scenario);
render();

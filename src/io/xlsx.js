import { WorkbookValidationError, validateWorkbookSheets } from "./schema.js";
import { LedgerValidationError } from "../domain/ledger.js";
import { projectLedgerToForecastReceipts, reconcileCanonicalData } from "../domain/reconcile.js";

export const XLSX_PARSER_VERSION = "0.20.3";
export const XLSX_LIMITS = Object.freeze({
  maxFileBytes: 25 * 1024 * 1024,
  maxZipEntries: 256,
  maxUncompressedBytes: 250 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxSheets: 12,
  maxRowsPerSheet: 50_001,
  maxColumnsPerSheet: 64,
  maxCells: 1_600_000,
  maxNormalizedEvents: 150_000
});

export class ExcelIntakeError extends Error {
  constructor(message, report = null) {
    super(message);
    this.name = "ExcelIntakeError";
    this.report = report ?? {
      errors: [message],
      warnings: [],
      summary: "Файл не загружен. Активный расчет не изменен."
    };
  }
}

function fail(message, summary = "Файл не загружен: превышены безопасные ограничения.") {
  throw new ExcelIntakeError(message, { errors: [message], warnings: [], summary });
}

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

export function inspectXlsxArchive(arrayBuffer, limits = XLSX_LIMITS) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.byteLength > limits.maxFileBytes) {
    fail(`Размер файла ${bytes.byteLength} байт превышает лимит ${limits.maxFileBytes} байт.`);
  }
  if (bytes.byteLength < 22 || readU32(bytes, 0) !== 0x04034b50) {
    fail("Файл не похож на корректную книгу .xlsx.", "Файл не загружен: неверный формат.");
  }

  let eocdOffset = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (readU32(bytes, offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) fail("Не найден центральный каталог XLSX.", "Файл не загружен: книга повреждена.");

  const entryCount = readU16(bytes, eocdOffset + 10);
  const centralSize = readU32(bytes, eocdOffset + 12);
  const centralOffset = readU32(bytes, eocdOffset + 16);
  if (entryCount > limits.maxZipEntries) fail(`В книге ${entryCount} ZIP-объектов; разрешено не больше ${limits.maxZipEntries}.`);
  if (centralOffset + centralSize > bytes.length) fail("Центральный каталог XLSX выходит за границы файла.", "Файл не загружен: книга повреждена.");

  let offset = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || readU32(bytes, offset) !== 0x02014b50) {
      fail("Повреждена запись центрального каталога XLSX.", "Файл не загружен: книга повреждена.");
    }
    const flags = readU16(bytes, offset + 8);
    const compressed = readU32(bytes, offset + 20);
    const uncompressed = readU32(bytes, offset + 24);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const localOffset = readU32(bytes, offset + 42);
    if ([compressed, uncompressed, localOffset].includes(0xffffffff)) fail("ZIP64-книги не поддерживаются. Сохраните файл как обычный .xlsx.");
    if (flags & 0x1) fail("Защищенные паролем Excel-файлы не поддерживаются.", "Файл не загружен: книга зашифрована.");
    totalCompressed += compressed;
    totalUncompressed += uncompressed;
    if (totalUncompressed > limits.maxUncompressedBytes) {
      fail(`Распакованный объем книги превышает лимит ${limits.maxUncompressedBytes} байт.`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  const ratio = totalUncompressed / Math.max(1, totalCompressed);
  if (ratio > limits.maxCompressionRatio) {
    fail(`Коэффициент сжатия XLSX ${ratio.toFixed(1)} превышает безопасный лимит ${limits.maxCompressionRatio}.`);
  }
  return { entryCount, totalCompressed, totalUncompressed, compressionRatio: ratio };
}

function parserOrFail(parser) {
  if (!parser || typeof parser.read !== "function" || typeof parser.utils?.sheet_to_json !== "function") {
    throw new ExcelIntakeError("Локальный XLSX-парсер не загружен. Обновите страницу и повторите попытку.");
  }
  if (parser.version !== XLSX_PARSER_VERSION) {
    throw new ExcelIntakeError(`Версия XLSX-парсера ${parser.version ?? "неизвестна"} не совпадает с закрепленной ${XLSX_PARSER_VERSION}.`);
  }
  return parser;
}

function workbookToRows(workbook, parser, limits) {
  if (workbook.SheetNames.length > limits.maxSheets) {
    fail(`В книге ${workbook.SheetNames.length} листов; разрешено не больше ${limits.maxSheets}.`);
  }
  const sheets = {};
  let totalCells = 0;
  let totalEvents = 0;

  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return;
    const range = sheet["!ref"] ? parser.utils.decode_range(sheet["!ref"]) : null;
    const rowCount = range ? range.e.r - range.s.r + 1 : 0;
    const columnCount = range ? range.e.c - range.s.c + 1 : 0;
    if (rowCount > limits.maxRowsPerSheet) {
      fail(`Лист ${sheetName}: ${rowCount} строк; разрешено не больше ${limits.maxRowsPerSheet}.`);
    }
    if (columnCount > limits.maxColumnsPerSheet) {
      fail(`Лист ${sheetName}: ${columnCount} колонок; разрешено не больше ${limits.maxColumnsPerSheet}.`);
    }
    totalCells += rowCount * columnCount;
    if (totalCells > limits.maxCells) fail(`В книге больше ${limits.maxCells} ячеек в используемых диапазонах.`);
    totalEvents += Math.max(0, rowCount - 1);
    if (totalEvents > limits.maxNormalizedEvents) {
      fail(`В книге больше ${limits.maxNormalizedEvents} строк данных; уменьшите объем выгрузки.`);
    }
    sheets[sheetName] = parser.utils.sheet_to_json(sheet, {
      header: 1,
      raw: true,
      defval: "",
      blankrows: false
    });
  });
  return sheets;
}

export function readWorkbookArrayBuffer(arrayBuffer, {
  fallbackDate,
  parser = globalThis.XLSX,
  limits = XLSX_LIMITS
} = {}) {
  inspectXlsxArchive(arrayBuffer, limits);
  const xlsx = parserOrFail(parser);
  let workbook;
  try {
    workbook = xlsx.read(arrayBuffer, {
      type: "array",
      cellDates: false,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      dense: true,
      sheetRows: limits.maxRowsPerSheet + 1,
      WTF: false
    });
  } catch {
    throw new ExcelIntakeError("Не удалось безопасно прочитать XLSX. Проверьте, что файл не поврежден и не защищен паролем.");
  }

  try {
    const normalized = validateWorkbookSheets(workbookToRows(workbook, xlsx, limits), { fallbackDate });
    if (normalized.kind !== "canonical") return normalized;
    const reconciliation = reconcileCanonicalData({
      receivables: normalized.receivables,
      payments: normalized.payments,
      allocations: normalized.allocations,
      asOfDate: normalized.asOfDate
    });
    const receipts = projectLedgerToForecastReceipts(reconciliation);
    const warnings = [
      ...normalized.report.warnings,
      ...reconciliation.ledger.report.warnings,
      ...reconciliation.unmatchedPayments.map(({ payment, unallocatedAmountMinor, reason }) =>
        `Bank ${payment.paymentId}: не распределено ${unallocatedAmountMinor} коп.; статус ${reason === "overpayment" ? "переплата" : "не сопоставлен"}.`
      ),
      ...reconciliation.proposedAllocations.map((allocation) =>
        `Bank ${allocation.paymentId}: сопоставление с ${allocation.receivableId} требует подтверждения.`
      )
    ];
    return {
      ...normalized,
      receipts,
      reconciliation,
      report: {
        errors: [],
        warnings,
        reconciliation: {
          unmatchedPayments: reconciliation.stats.unmatchedPayments,
          pendingAllocations: reconciliation.stats.pendingAllocations,
          confirmedAllocations: reconciliation.stats.confirmedAllocations
        },
        summary: `Сверка готова: ${receipts.length} открытых ДЗ, ${reconciliation.stats.confirmedAllocations} подтвержденных аллокаций, платежей без полного распределения: ${reconciliation.stats.unmatchedPayments}.`
      }
    };
  } catch (error) {
    if (error instanceof LedgerValidationError) {
      throw new ExcelIntakeError(error.message, {
        errors: error.report.errors,
        warnings: error.report.warnings,
        summary: "Файл не загружен: банковская сверка нарушает инварианты ledger."
      });
    }
    if (error instanceof WorkbookValidationError || error instanceof ExcelIntakeError) {
      throw new ExcelIntakeError(error.message, error.report);
    }
    throw new ExcelIntakeError("Не удалось проверить структуру Excel-файла.");
  }
}

export async function readExcelFile(file, options = {}) {
  if (!file) throw new ExcelIntakeError("Выберите Excel-файл .xlsx.");
  const fileName = String(file.name ?? "");
  if (!fileName.toLowerCase().endsWith(".xlsx")) {
    throw new ExcelIntakeError("Поддерживается только формат .xlsx. Сохраните файл как Excel Workbook (*.xlsx).");
  }
  if (Number(file.size) > XLSX_LIMITS.maxFileBytes) {
    fail(`Размер файла ${file.size} байт превышает лимит ${XLSX_LIMITS.maxFileBytes} байт.`);
  }
  return readWorkbookArrayBuffer(await file.arrayBuffer(), options);
}

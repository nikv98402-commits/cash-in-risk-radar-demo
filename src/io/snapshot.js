import { parseDateOnly, toDateOnly } from "../domain/date.js";

export const SNAPSHOT_FORMAT = "cash-in-risk-audit-snapshot";
export const SNAPSHOT_VERSION = "1.0.0";
export const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;

export class SnapshotValidationError extends Error {
  constructor(message, code = "INVALID_SNAPSHOT") {
    super(message);
    this.name = "SnapshotValidationError";
    this.code = code;
  }
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^[a-f0-9]{64}$/;

function normalizeValue(value, path = "snapshot") {
  if (value instanceof Date) return toDateOnly(value);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SnapshotValidationError(`${path}: число должно быть конечным.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalizeValue(item, `${path}[${index}]`));
  if (typeof value !== "object") {
    throw new SnapshotValidationError(`${path}: функции и исполняемые значения запрещены.`);
  }
  const result = {};
  Object.keys(value).sort().forEach((key) => {
    if (FORBIDDEN_KEYS.has(key)) throw new SnapshotValidationError(`${path}.${key}: запрещенное имя поля.`);
    if (value[key] !== undefined) result[key] = normalizeValue(value[key], `${path}.${key}`);
  });
  return result;
}

export function canonicalStringify(value) {
  return JSON.stringify(normalizeValue(value));
}

export async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) throw new SnapshotValidationError("SHA-256 недоступен в текущем окружении.", "CRYPTO_UNAVAILABLE");
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new TextEncoder().encode(typeof value === "string" ? value : canonicalStringify(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SnapshotValidationError(`${path}: ожидается объект.`);
  }
  return value;
}

function validatePrimitiveContracts(value, path = "snapshot") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validatePrimitiveContracts(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.entries(value).forEach(([key, item]) => {
    if (FORBIDDEN_KEYS.has(key)) throw new SnapshotValidationError(`${path}.${key}: запрещенное имя поля.`);
    if (key.endsWith("Minor") && item !== null && !Number.isSafeInteger(item)) {
      throw new SnapshotValidationError(`${path}.${key}: денежное значение должно быть целым числом минимальных единиц.`);
    }
    if ((key.endsWith("Date") || key.endsWith("DateIso") || key === "asOfDate")
      && item !== null && !DATE_ONLY.test(String(item))) {
      throw new SnapshotValidationError(`${path}.${key}: дата должна иметь формат YYYY-MM-DD.`);
    }
    validatePrimitiveContracts(item, `${path}.${key}`);
  });
}

function validateRun(run) {
  requireObject(run, "snapshot.run");
  if (!String(run.runId ?? "").trim()) throw new SnapshotValidationError("snapshot.run.runId отсутствует.");
  if (Number.isNaN(new Date(run.createdAt).getTime())) throw new SnapshotValidationError("snapshot.run.createdAt некорректен.");
  if (!DATE_ONLY.test(String(run.asOfDate ?? ""))) throw new SnapshotValidationError("snapshot.run.asOfDate должен быть YYYY-MM-DD.");
  if (!Number.isInteger(run.horizonDays) || run.horizonDays < 0 || run.horizonDays > 366) {
    throw new SnapshotValidationError("snapshot.run.horizonDays должен быть от 0 до 366.");
  }
  requireObject(run.versions, "snapshot.run.versions");
  ["schema", "timingModel", "forecast", "funding"].forEach((key) => {
    if (!String(run.versions[key] ?? "").trim()) throw new SnapshotValidationError(`snapshot.run.versions.${key} отсутствует.`);
  });
  if (!Array.isArray(run.sources)) throw new SnapshotValidationError("snapshot.run.sources должен быть массивом.");
  requireObject(run.qualityReport, "snapshot.run.qualityReport");
  requireObject(run.inputs, "snapshot.run.inputs");
  requireObject(run.outputs, "snapshot.run.outputs");
  if (!Array.isArray(run.inputs.receipts) || !Array.isArray(run.inputs.outflows) || !Array.isArray(run.inputs.fundingSources)) {
    throw new SnapshotValidationError("snapshot.run.inputs должен содержать receipts, outflows и fundingSources.");
  }
  if (!Array.isArray(run.outputs.calendar) || !Array.isArray(run.outputs.scenarioDates)) {
    throw new SnapshotValidationError("snapshot.run.outputs должен содержать calendar и scenarioDates.");
  }
  requireObject(run.outputs.funding, "snapshot.run.outputs.funding");
  if (run.signOff !== undefined) {
    requireObject(run.signOff, "snapshot.run.signOff");
    requireObject(run.signOff.reconciliation, "snapshot.run.signOff.reconciliation");
    requireObject(run.signOff.cfoReport, "snapshot.run.signOff.cfoReport");
    const reconciliationStatuses = new Set(["reconciliation-pending", "reconciliation-confirmed"]);
    const cfoStatuses = new Set(["cfo-pending", "cfo-ready"]);
    if (!reconciliationStatuses.has(run.signOff.reconciliation.status)) {
      throw new SnapshotValidationError("snapshot.run.signOff.reconciliation.status некорректен.");
    }
    if (!cfoStatuses.has(run.signOff.cfoReport.status)) {
      throw new SnapshotValidationError("snapshot.run.signOff.cfoReport.status некорректен.");
    }
    [run.signOff.reconciliation, run.signOff.cfoReport].forEach((section) => {
      if (section.confirmation === null) return;
      const confirmation = requireObject(section.confirmation, "snapshot.run.signOff.confirmation");
      if (!String(confirmation.operator ?? "").trim() || confirmation.runId !== run.runId
        || Number.isNaN(new Date(confirmation.confirmedAt).getTime())) {
        throw new SnapshotValidationError("snapshot.run.signOff.confirmation не привязан к валидному оператору, времени и runId.");
      }
      const counts = requireObject(confirmation.qualityCounts, "snapshot.run.signOff.confirmation.qualityCounts");
      ["unmatchedPayments", "pendingAllocations", "errors", "warnings"].forEach((key) => {
        if (!Number.isInteger(counts[key]) || counts[key] < 0) {
          throw new SnapshotValidationError(`snapshot.run.signOff.confirmation.qualityCounts.${key} некорректен.`);
        }
      });
    });
    if (run.signOff.reconciliation.status === "reconciliation-pending" && run.signOff.reconciliation.confirmation !== null) {
      throw new SnapshotValidationError("Неподтвержденная сверка не может содержать confirmation.");
    }
    if (run.signOff.cfoReport.status === "cfo-ready"
      && run.signOff.reconciliation.status !== "reconciliation-confirmed") {
      throw new SnapshotValidationError("Готовность CFO невозможна без подтвержденной сверки.");
    }
    if (run.signOff.cfoReport.status === "cfo-ready"
      && Number(run.outputs.funding.uncoveredNeedMinor ?? 0) > 0
      && run.signOff.cfoReport.confirmation?.uncoveredGapAccepted !== true) {
      throw new SnapshotValidationError("Непокрытый кассовый разрыв должен быть явно принят в отчет CFO.");
    }
  }
  validatePrimitiveContracts(run, "snapshot.run");
}

function contentPayload(snapshot) {
  return {
    format: snapshot.format,
    version: snapshot.version,
    exportedAt: snapshot.exportedAt,
    run: snapshot.run,
    inputSha256: snapshot.integrity.inputSha256,
    financialResultSha256: snapshot.integrity.financialResultSha256
  };
}

export async function createAuditSnapshot(run, { clock = () => new Date() } = {}) {
  const normalizedRun = normalizeValue(run, "run");
  validateRun(normalizedRun);
  const inputSha256 = await sha256Hex(normalizedRun.inputs);
  const financialResultSha256 = await sha256Hex(normalizedRun.outputs);
  const snapshot = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    exportedAt: clock().toISOString(),
    run: normalizedRun,
    integrity: {
      algorithm: "SHA-256",
      inputSha256,
      financialResultSha256,
      contentSha256: ""
    }
  };
  snapshot.integrity.contentSha256 = await sha256Hex(contentPayload(snapshot));
  return snapshot;
}

function parseJsonSafely(text) {
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new SnapshotValidationError("Файл расчета пуст или превышает безопасный лимит 10 МБ.", "SNAPSHOT_SIZE_LIMIT");
  }
  try {
    return JSON.parse(text, (key, value) => {
      if (FORBIDDEN_KEYS.has(key)) throw new SnapshotValidationError(`Запрещенное поле ${key}.`);
      return value;
    });
  } catch (error) {
    if (error instanceof SnapshotValidationError) throw error;
    throw new SnapshotValidationError("Файл расчета не является корректным JSON.", "INVALID_JSON");
  }
}

export async function parseAuditSnapshot(text) {
  const snapshot = parseJsonSafely(text);
  requireObject(snapshot, "snapshot");
  if (snapshot.format !== SNAPSHOT_FORMAT) throw new SnapshotValidationError("Неизвестный формат файла расчета.", "UNKNOWN_FORMAT");
  if (snapshot.version !== SNAPSHOT_VERSION) throw new SnapshotValidationError(`Версия файла расчета ${snapshot.version ?? "не указана"} не поддерживается.`, "UNSUPPORTED_VERSION");
  if (Number.isNaN(new Date(snapshot.exportedAt).getTime())) throw new SnapshotValidationError("snapshot.exportedAt некорректен.");
  validateRun(snapshot.run);
  const integrity = requireObject(snapshot.integrity, "snapshot.integrity");
  if (integrity.algorithm !== "SHA-256" || !HASH.test(integrity.inputSha256)
    || !HASH.test(integrity.financialResultSha256) || !HASH.test(integrity.contentSha256)) {
    throw new SnapshotValidationError("Файл расчета не содержит корректный блок SHA-256.", "INVALID_INTEGRITY_BLOCK");
  }
  const expectedInput = await sha256Hex(snapshot.run.inputs);
  const expectedResult = await sha256Hex(snapshot.run.outputs);
  const expectedContent = await sha256Hex(contentPayload(snapshot));
  if (expectedInput !== integrity.inputSha256) throw new SnapshotValidationError("Контрольная сумма входных данных не совпадает.", "INPUT_CHECKSUM_MISMATCH");
  if (expectedResult !== integrity.financialResultSha256) throw new SnapshotValidationError("Контрольная сумма финансового результата не совпадает.", "RESULT_CHECKSUM_MISMATCH");
  if (expectedContent !== integrity.contentSha256) throw new SnapshotValidationError("Контрольная сумма файла расчета не совпадает.", "CONTENT_CHECKSUM_MISMATCH");
  return normalizeValue(snapshot);
}

export function reviveDateFields(value) {
  if (Array.isArray(value)) return value.map(reviveDateFields);
  if (!value || typeof value !== "object") return value;
  const result = {};
  Object.entries(value).forEach(([key, item]) => {
    if ((key.endsWith("Date") || key.endsWith("DateIso") || key === "asOfDate") && DATE_ONLY.test(String(item ?? ""))) {
      result[key] = parseDateOnly(item);
    } else {
      result[key] = reviveDateFields(item);
    }
  });
  return result;
}

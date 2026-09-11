export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_HORIZON_DAYS = 366;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export class DateDomainError extends Error {
  constructor(message, code = "INVALID_DATE") {
    super(message);
    this.name = "DateDomainError";
    this.code = code;
  }
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function requireDate(value, fieldName = "date") {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DateDomainError(`${fieldName}: ожидается корректная календарная дата.`);
  }
  return value;
}

function localParts(date) {
  const valid = requireDate(date);
  return [valid.getFullYear(), valid.getMonth() + 1, valid.getDate()];
}

export function dateOrdinal(date) {
  const [year, month, day] = localParts(date);
  return Math.trunc(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

export function daysBetween(a, b) {
  return dateOrdinal(a) - dateOrdinal(b);
}

export function addDays(date, days) {
  requireDate(date);
  if (!Number.isInteger(days)) {
    throw new DateDomainError(`days: ожидается целое число, получено ${days}.`, "INVALID_DAY_OFFSET");
  }
  const [year, month, day] = localParts(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return new Date(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}

export function formatDateInput(date) {
  const [year, month, day] = localParts(date);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseDateOnly(isoDate) {
  const match = String(isoDate ?? "").match(ISO_DATE_PATTERN);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
  ) {
    return null;
  }
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}

export function toDateOnly(date) {
  return formatDateInput(date);
}

export function assertDateWithinHorizon(date, anchorDate, options = {}) {
  const fieldName = options.fieldName ?? "date";
  const maxDays = options.maxDays ?? DEFAULT_MAX_HORIZON_DAYS;
  if (!Number.isInteger(maxDays) || maxDays < 0) {
    throw new DateDomainError("maxDays должен быть неотрицательным целым числом.", "INVALID_HORIZON");
  }
  const offset = daysBetween(requireDate(date, fieldName), requireDate(anchorDate, "anchorDate"));
  if (offset < 0 || offset > maxDays) {
    throw new DateDomainError(
      `${fieldName}: дата ${toDateOnly(date)} вне допустимого горизонта 0..${maxDays} дней от ${toDateOnly(anchorDate)}.`,
      "DATE_OUT_OF_HORIZON"
    );
  }
  return date;
}

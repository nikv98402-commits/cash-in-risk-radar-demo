import { addDays, daysBetween, parseDateOnly } from "./date.js";

export const DEFAULT_PLANNING_MAX_AGE_WORKING_DAYS = 5;

function requireDate(value, field) {
  const date = value instanceof Date ? value : parseDateOnly(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError(`${field}: нужна ISO-дата.`);
  }
  return date;
}

export function workingDaysBetween(asOfValue, sourceValue) {
  const asOfDate = requireDate(asOfValue, "asOfDate");
  const sourceDate = requireDate(sourceValue, "planningAsOfDate");
  const calendarDays = daysBetween(asOfDate, sourceDate);
  if (calendarDays < 0) throw new RangeError("Дата плановых данных не может быть позже даты расчета.");
  let result = 0;
  for (let offset = 1; offset <= calendarDays; offset += 1) {
    const day = addDays(sourceDate, offset).getDay();
    if (day !== 0 && day !== 6) result += 1;
  }
  return result;
}

export function assessPlanningFreshness(asOfDate, planningAsOfDate, maxAgeWorkingDays = DEFAULT_PLANNING_MAX_AGE_WORKING_DAYS) {
  if (!Number.isInteger(maxAgeWorkingDays) || maxAgeWorkingDays < 0) {
    throw new RangeError("Порог свежести должен быть неотрицательным целым числом рабочих дней.");
  }
  const ageWorkingDays = workingDaysBetween(asOfDate, planningAsOfDate);
  return {
    status: ageWorkingDays > maxAgeWorkingDays ? "stale" : "fresh",
    ageWorkingDays,
    maxAgeWorkingDays
  };
}

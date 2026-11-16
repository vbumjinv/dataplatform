const END_LATEST_TOKEN = "__TODAY__";
const START_RELATIVE_TOKEN_REGEX = /^__TODAY_MINUS_(\d+)(D|M|Q|A|Y)__$/i;

const kstToday = (nowMs: number) => {
  const shifted = new Date(nowMs + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
};

const shiftUtcDate = (base: Date, offset: number, unit: "D" | "M" | "Q" | "A" | "Y") => {
  const next = new Date(base);
  if (unit === "D") next.setUTCDate(next.getUTCDate() - offset);
  else if (unit === "M") next.setUTCMonth(next.getUTCMonth() - offset);
  else if (unit === "Q") next.setUTCMonth(next.getUTCMonth() - offset * 3);
  else next.setUTCFullYear(next.getUTCFullYear() - offset);
  return next;
};

const formatUtcDate = (date: Date) => date.toISOString().slice(0, 10);

const isCalendarDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
};

/** API 조회일과 같은 토큰을 뉴스 수집용 YYYY-MM-DD(KST)로 바꿉니다. */
export const resolveNewsDateToken = (raw: string, nowMs = Date.now()) => {
  const value = raw.trim();
  if (!value) return null;
  if (/^\d{8}$/.test(value)) {
    const compact = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    return isCalendarDate(compact) ? compact : null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return isCalendarDate(value) ? value : null;

  const today = kstToday(nowMs);
  if (value === END_LATEST_TOKEN) return formatUtcDate(today);

  const tokenMatch = START_RELATIVE_TOKEN_REGEX.exec(value);
  if (tokenMatch) {
    const offset = Number(tokenMatch[1]);
    if (!Number.isFinite(offset) || offset < 0) return null;
    const unit = tokenMatch[2].toUpperCase() as "D" | "M" | "Q" | "A" | "Y";
    return formatUtcDate(shiftUtcDate(today, offset, unit));
  }
  return null;
};

import sessions from "./xkrx-sessions.json";

export type TimeKey = "W0" | "W2";

const POINTS = {
  W0: { hour: 16, minute: 30 },
  W2: { hour: 8, minute: 30 },
} as const;

const LIST = sessions as string[];

const seoulParts = (now: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return {
    date: `${pick("year")}-${pick("month")}-${pick("day")}`,
    minutes: Number(pick("hour")) * 60 + Number(pick("minute")),
  };
};

const addDays = (iso: string, days: number) => {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

const previousSession = (iso: string) => {
  let low = 0;
  let high = LIST.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (LIST[mid] < iso) low = mid + 1;
    else high = mid;
  }
  return low === 0 ? "" : LIST[low - 1];
};

const stamp = (day: string, hour: number, minute: number) =>
  `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`;

const targetAfter = (base: string) => {
  const index = LIST.indexOf(base);
  return index >= 0 ? LIST[index + 5] ?? "" : "";
};

export type PointDate = { runDay: string; at: string; base: string; target: string };

export const pointForDate = (key: TimeKey, runDay: string): PointDate => {
  const spec = POINTS[key];
  const base = key === "W0" && LIST.includes(runDay) ? runDay : previousSession(runDay);
  return { runDay, at: runDay ? stamp(runDay, spec.hour, spec.minute) : "", base, target: targetAfter(base) };
};

export const suggestedRun = (key: TimeKey, now = new Date()): PointDate => {
  const spec = POINTS[key];
  const seoul = seoulParts(now);
  const runDay = seoul.minutes >= spec.hour * 60 + spec.minute ? seoul.date : addDays(seoul.date, -1);
  return pointForDate(key, runDay);
};

export const formatStamp = (value: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(date);
};

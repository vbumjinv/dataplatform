import sessions from "./xkrx-sessions.json";

export type TimeKey = "T0" | "T1" | "T2";

const POINTS = {
  T0: { anchor: "prev", hour: 16, minute: 0 },
  T1: { anchor: "target", hour: 2, minute: 0 },
  T2: { anchor: "target", hour: 8, minute: 30 },
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

const nextSession = (iso: string) => {
  let low = 0;
  let high = LIST.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (LIST[mid] < iso) low = mid + 1;
    else high = mid;
  }
  return LIST[low] ?? "";
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

export type PointDate = { target: string; at: string };

export const suggestedPoint = (key: TimeKey, now = new Date()): PointDate => {
  const spec = POINTS[key];
  const seoul = seoulParts(now);
  const runDay = seoul.minutes >= spec.hour * 60 + spec.minute ? seoul.date : addDays(seoul.date, -1);
  const first = spec.anchor === "prev" ? addDays(runDay, 1) : runDay;
  return { target: nextSession(first), at: stamp(runDay, spec.hour, spec.minute) };
};

export const suggestedTargets = (now = new Date()) => ({
  T0: suggestedPoint("T0", now),
  T1: suggestedPoint("T1", now),
  T2: suggestedPoint("T2", now),
});

export const cutoffOf = (key: TimeKey, target: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return "";
  const spec = POINTS[key];
  const day = spec.anchor === "prev" ? previousSession(target) : target;
  return day ? stamp(day, spec.hour, spec.minute) : "";
};

export const formatStamp = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return "";
  return `${Number(match[2])}/${Number(match[3])} ${match[4]}:${match[5]}`;
};

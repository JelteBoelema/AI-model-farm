// Time-zone helpers built on Intl (no dependencies). Schedules are stored in UTC; slots, days and
// calendar views are interpreted in a creator's or viewer's IANA time zone.

const partsFormatter = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = partsFormatter.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    partsFormatter.set(timeZone, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  /** ISO weekday, 1 = Monday. */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(date).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), weekday: WEEKDAYS[p.weekday!]! };
}

/** Offset of the zone from UTC at that instant, in minutes. */
function offsetMinutes(date: Date, timeZone: string) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / 60_000) * 60_000) / 60_000);
}

/**
 * The UTC instant of a wall-clock time in a zone. Times that do not exist (spring-forward gap) move
 * forward by the gap; ambiguous times (fall-back) resolve to the first occurrence.
 */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // The offsets in force half a day before and after cover both sides of any DST change.
  const a = guess - offsetMinutes(new Date(guess - 12 * 3_600_000), timeZone) * 60_000;
  const b = guess - offsetMinutes(new Date(guess + 12 * 3_600_000), timeZone) * 60_000;
  const matches = (t: number) => {
    const p = zonedParts(new Date(t), timeZone);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  };
  const valid = [a, b].filter(matches);
  // Ambiguous: earliest occurrence. Nonexistent (no candidate matches): the later one, i.e. after the gap.
  return new Date(valid.length ? Math.min(...valid) : Math.max(a, b));
}

/** Calendar day key (YYYY-MM-DD) of an instant in a zone. */
export function dayKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function formatInZone(date: Date, timeZone: string, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }) {
  return new Intl.DateTimeFormat("en-GB", { timeZone, ...opts }).format(date);
}

export function isKnownTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Adds whole days to a YYYY-MM-DD key. */
export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** ISO weekday (1 = Monday) of a YYYY-MM-DD key. */
export function weekdayOf(key: string): number {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

// Pure Intl-based time zone helpers. No DOM, no Tauri — runnable under `node --test`.
// Offsets are never computed by hand: everything is derived from Intl.DateTimeFormat.

export interface ZonedTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
const offsetCache = new Map<string, Intl.DateTimeFormat>();
const dateCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partsCache.set(tz, f);
  }
  return f;
}

export function zonedTime(tz: string, date: Date): ZonedTime {
  const out: ZonedTime = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of partsFormatter(tz).formatToParts(date)) {
    if (p.type in out) out[p.type as keyof ZonedTime] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0; // guard against old ICU "24:00" output
  return out;
}

/** Comparable calendar-day key, e.g. 20261021. */
export function dayKey(t: ZonedTime): number {
  return t.year * 10000 + t.month * 100 + t.day;
}

/** UTC offset in minutes (east positive), parsed from Intl's `shortOffset` name, e.g. "GMT+5:30". */
export function offsetMinutes(tz: string, date: Date): number {
  let f = offsetCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' });
    offsetCache.set(tz, f);
  }
  const name = f.formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+\-−])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === '+' ? mins : -mins;
}

const MINUS = '−';

function hm(abs: number): { h: number; m: number } {
  return { h: Math.floor(abs / 60), m: abs % 60 };
}

/** "UTC+5:30", "UTC−4", "UTC+0". */
export function formatUtcOffset(mins: number): string {
  const { h, m } = hm(Math.abs(mins));
  const sign = mins < 0 ? MINUS : '+';
  return `UTC${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}

/** Offset relative to local: "+13h", "−4h", "+5h30m", "±0h". */
export function formatRelative(diffMins: number): string {
  if (diffMins === 0) return '±0h';
  const { h, m } = hm(Math.abs(diffMins));
  const sign = diffMins < 0 ? MINUS : '+';
  if (h === 0) return `${sign}${m}m`;
  return `${sign}${h}h${m ? m + 'm' : ''}`;
}

/** "14:05", "2:05" + suffix for 12h. */
export function formatTime(t: ZonedTime, hour12: boolean): { hm: string; sec: string; suffix: string } {
  const mm = String(t.minute).padStart(2, '0');
  const sec = String(t.second).padStart(2, '0');
  if (!hour12) return { hm: `${String(t.hour).padStart(2, '0')}:${mm}`, sec, suffix: '' };
  const h = t.hour % 12 || 12;
  return { hm: `${h}:${mm}`, sec, suffix: t.hour < 12 ? 'AM' : 'PM' };
}

export type DateFormat = 'short' | 'long' | 'withYear' | 'dayMonth' | 'numeric' | 'iso';
export const DATE_FORMATS: readonly DateFormat[] = ['short', 'long', 'withYear', 'dayMonth', 'numeric', 'iso'];

// `locale` undefined = the user's locale. 'iso' is built from parts instead.
const DATE_STYLES: Record<Exclude<DateFormat, 'iso'>, { locale?: string; opts: Intl.DateTimeFormatOptions }> = {
  short: { opts: { weekday: 'short', month: 'short', day: 'numeric' } }, // Wed, Oct 21
  long: { opts: { weekday: 'long', month: 'long', day: 'numeric' } }, // Wednesday, October 21
  withYear: { opts: { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' } }, // Wed, Oct 21, 2026
  dayMonth: { locale: 'en-GB', opts: { weekday: 'short', day: 'numeric', month: 'short' } }, // Wed 21 Oct
  numeric: { opts: { month: 'numeric', day: 'numeric' } }, // 10/21
};

/** Date line in the zone, e.g. "Wed, Oct 21" for 'short'. */
export function formatDate(tz: string, date: Date, format: DateFormat = 'short'): string {
  if (format === 'iso') {
    const t = zonedTime(tz, date);
    return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
  }
  const key = `${format}|${tz}`;
  let f = dateCache.get(key);
  if (!f) {
    const style = DATE_STYLES[format] ?? DATE_STYLES.short;
    f = new Intl.DateTimeFormat(style.locale, { ...style.opts, timeZone: tz });
    dateCache.set(key, f);
  }
  return f.format(date);
}

export function isDaytime(t: ZonedTime): boolean {
  return t.hour >= 6 && t.hour < 18;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Legacy IANA IDs that some ICU builds still report as canonical. */
export const LEGACY_IDS: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Europe/Kiev': 'Europe/Kyiv',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'America/Godthab': 'America/Nuuk',
  'Pacific/Truk': 'Pacific/Chuuk',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Louisville': 'America/Kentucky/Louisville',
};

export function canonicalId(tz: string): string {
  return LEGACY_IDS[tz] ?? tz;
}

/** "America/Argentina/Buenos_Aires" → "Buenos Aires". */
export function cityFromTimeZone(tz: string): string {
  const id = canonicalId(tz);
  if (id === 'UTC' || id === 'Etc/UTC') return 'UTC';
  const last = id.split('/').pop() ?? id;
  return last.replace(/_/g, ' ');
}

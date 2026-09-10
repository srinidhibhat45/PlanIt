/** Timezone engine.
 *  Built on Intl so it needs no data files and follows the host's tzdb.
 *  Everything crossing this boundary is a UTC epoch; naive wall-clock values
 *  only ever exist as an explicit {parts, zone} pair. */

import type { Epoch, IsoDate, Zone } from './types';

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export interface Parts {
  year: number; month: number; day: number;   // month is 1-12
  hour: number; minute: number; second: number;
  weekday: number;                            // 0 = Sunday
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(zone: Zone): Intl.DateTimeFormat {
  let f = partsCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    partsCache.set(zone, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Break a UTC instant into wall-clock parts for a zone. */
export function toParts(epoch: Epoch, zone: Zone): Parts {
  const raw = partsFormatter(zone).formatToParts(new Date(epoch));
  const get = (t: string) => raw.find((p) => p.type === t)?.value ?? '0';
  const hour = Number(get('hour'));
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: hour === 24 ? 0 : hour,     // some engines emit 24 for midnight
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: Math.max(0, WEEKDAYS.indexOf(get('weekday'))),
  };
}

/** Offset of `zone` from UTC at `epoch`, in minutes (east of UTC is positive). */
export function offsetMinutes(epoch: Epoch, zone: Zone): number {
  const p = toParts(epoch, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - epoch) / MIN);
}

/** Wall-clock in a zone -> UTC instant.
 *
 *  A local time is not always a single instant. On the night the clocks go
 *  back, 01:30 happens twice; on the night they go forward, it never happens
 *  at all. Probing the offset a day either side gives both candidate offsets;
 *  a candidate is real only if the zone actually reports that offset at the
 *  instant it implies.
 *
 *  Matching Temporal's 'compatible' disambiguation: an ambiguous time resolves
 *  to the earlier (pre-transition) instant, and a skipped time is pushed
 *  forward past the gap. */
export function fromZoned(
  year: number, month: number, day: number,
  hour = 0, minute = 0, second = 0, zone: Zone,
): Epoch {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const before = offsetMinutes(naive - DAY, zone);
  const after = offsetMinutes(naive + DAY, zone);

  const valid: Epoch[] = [];
  for (const off of before === after ? [before] : [before, after]) {
    const candidate = naive - off * MIN;
    if (offsetMinutes(candidate, zone) === off) valid.push(candidate);
  }

  if (valid.length) return Math.min(...valid);   // ambiguous -> the earlier one
  return naive - before * MIN;                   // in a gap -> just after it
}

/** Parse 'YYYY-MM-DD' + optional 'HH:MM' in a zone. */
export function parseLocal(date: IsoDate, time: string, zone: Zone): Epoch {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  return fromZoned(y, m, d, hh || 0, mm || 0, 0, zone);
}

/** The 'YYYY-MM-DD' calendar date an instant falls on, in a zone. */
export function dateKey(epoch: Epoch, zone: Zone): IsoDate {
  const p = toParts(epoch, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Midnight starting the given calendar date in a zone. */
export function startOfDay(epoch: Epoch, zone: Zone): Epoch {
  const p = toParts(epoch, zone);
  return fromZoned(p.year, p.month, p.day, 0, 0, 0, zone);
}

export function endOfDay(epoch: Epoch, zone: Zone): Epoch {
  return addDays(startOfDay(epoch, zone), 1, zone);
}

/** Calendar-correct day arithmetic (a DST day may not be 24h long). */
export function addDays(epoch: Epoch, n: number, zone: Zone): Epoch {
  const p = toParts(epoch, zone);
  return fromZoned(p.year, p.month, p.day + n, p.hour, p.minute, p.second, zone);
}

export function dateKeyToEpoch(key: IsoDate, zone: Zone): Epoch {
  const [y, m, d] = key.split('-').map(Number);
  return fromZoned(y, m, d, 0, 0, 0, zone);
}

/** Inclusive list of calendar date keys spanning two instants. */
export function eachDay(from: Epoch, to: Epoch, zone: Zone): IsoDate[] {
  const out: IsoDate[] = [];
  let cur = startOfDay(from, zone);
  const stop = startOfDay(to, zone);
  let guard = 0;
  while (cur <= stop && guard++ < 400) {
    out.push(dateKey(cur, zone));
    cur = addDays(cur, 1, zone);
  }
  return out;
}

export function pad(n: number): string { return String(n).padStart(2, '0'); }

/* ---------- formatting ---------- */

export interface FormatOpts { zone: Zone; hour12?: boolean }

export function fmtTime(epoch: Epoch, { zone, hour12 = false }: FormatOpts): string {
  const p = toParts(epoch, zone);
  if (!hour12) return `${pad(p.hour)}:${pad(p.minute)}`;
  const h = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h}:${pad(p.minute)} ${p.hour < 12 ? 'am' : 'pm'}`;
}

export function fmtDate(epoch: Epoch, zone: Zone, style: 'short' | 'medium' | 'long' | 'weekday' = 'medium'): string {
  const opts: Intl.DateTimeFormatOptions =
    style === 'short' ? { day: 'numeric', month: 'short' }
    : style === 'long' ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
    : style === 'weekday' ? { weekday: 'short' }
    : { weekday: 'short', day: 'numeric', month: 'short' };
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: zone }).format(new Date(epoch));
}

export function fmtRange(start: Epoch, end: Epoch, opts: FormatOpts): string {
  return `${fmtTime(start, opts)}–${fmtTime(end, opts)}`;
}

/** '2 h 45 m', '45 m', '3 d 2 h' */
export function fmtDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / MIN));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const bits: string[] = [];
  if (d) bits.push(`${d} d`);
  if (h) bits.push(`${h} h`);
  if (m || bits.length === 0) bits.push(`${m} m`);
  return bits.slice(0, 2).join(' ');
}

/** 'GMT+5:30' style label. */
export function zoneAbbr(epoch: Epoch, zone: Zone): string {
  const off = offsetMinutes(epoch, zone);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return `UTC${sign}${h}${m ? `:${pad(m)}` : ''}`;
}

/** Short city label from an IANA id: 'Asia/Kolkata' -> 'Kolkata'. */
export function zoneCity(zone: Zone): string {
  const tail = zone.split('/').pop() ?? zone;
  return tail.replace(/_/g, ' ');
}

/** Difference in whole calendar days between the same instant in two zones. */
export function dayShift(epoch: Epoch, a: Zone, b: Zone): number {
  const ka = dateKey(epoch, a);
  const kb = dateKey(epoch, b);
  if (ka === kb) return 0;
  return ka < kb ? 1 : -1;
}

export function deviceZone(): Zone {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

/** Snap an instant to the nearest `stepMin` boundary of its local wall clock. */
export function snap(epoch: Epoch, stepMin: number, zone: Zone): Epoch {
  const p = toParts(epoch, zone);
  const mins = p.hour * 60 + p.minute + p.second / 60;
  const snapped = Math.round(mins / stepMin) * stepMin;
  return fromZoned(p.year, p.month, p.day, 0, 0, 0, zone) + snapped * MIN;
}

export function overlaps(aStart: Epoch, aEnd: Epoch, bStart: Epoch, bEnd: Epoch): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

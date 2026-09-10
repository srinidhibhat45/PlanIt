/** Pure geometry for the timeline and day grid. No React, no DOM. */

import type { Epoch, ID, LaneMode, Segment, Trip, Zone } from './types';
import { DAY, HOUR, MIN, addDays, dateKey, dateKeyToEpoch, eachDay, fromZoned, toParts } from './time';
import { attendeesOf } from './schedule';

export interface Lane {
  id: string;
  label: string;
  sublabel?: string;
  color?: string;
  kind: LaneMode;
  /** The entity this lane represents, when there is one. */
  refId?: ID;
  segments: Segment[];
  /** Row index per segment id, after overlap packing. */
  rows: Map<ID, number>;
  rowCount: number;
}

/** Greedy interval packing: put each segment in the first row it fits. */
function packRows(segments: Segment[]): { rows: Map<ID, number>; rowCount: number } {
  const sorted = [...segments].sort((a, b) => a.start - b.start || b.end - a.end);
  const rowEnds: number[] = [];
  const rows = new Map<ID, number>();
  for (const s of sorted) {
    let r = rowEnds.findIndex((end) => end <= s.start);
    if (r === -1) { r = rowEnds.length; rowEnds.push(0); }
    rowEnds[r] = s.end;
    rows.set(s.id, r);
  }
  return { rows, rowCount: Math.max(1, rowEnds.length) };
}

export interface BuildLanesArgs {
  trip: Trip;
  segments: Segment[];
  mode: LaneMode;
  /** Restrict person lanes to this set; empty means all. */
  personIds?: ID[];
}

export function buildLanes({ trip, segments, mode, personIds = [] }: BuildLanesArgs): Lane[] {
  const make = (id: string, label: string, segs: Segment[], extra: Partial<Lane> = {}): Lane => ({
    id, label, kind: mode, segments: segs, ...packRows(segs), ...extra,
  });

  switch (mode) {
    case 'person': {
      const people = personIds.length ? trip.people.filter((p) => personIds.includes(p.id)) : trip.people;
      return people.map((p) => {
        const segs = segments.filter((s) => attendeesOf(s, trip).includes(p.id));
        return make(p.id, p.name, segs, {
          color: p.color, refId: p.id,
          sublabel: `${p.homeCity.split(',')[0]} · ${plural(segs.length, 'block')}`,
        });
      });
    }
    case 'group':
      return trip.groups.map((g) => {
        const segs = segments.filter(
          (s) => s.groupIds.includes(g.id) || attendeesOf(s, trip).some((a) => g.memberIds.includes(a)),
        );
        return make(g.id, g.name, segs, { color: g.color, refId: g.id, sublabel: `${g.memberIds.length} people` });
      });
    case 'place': {
      const used = trip.places.filter((pl) =>
        segments.some((s) => s.placeId === pl.id || s.fromPlaceId === pl.id || s.toPlaceId === pl.id));
      return used.map((pl) => {
        const segs = segments.filter((s) => s.placeId === pl.id || s.toPlaceId === pl.id);
        return make(pl.id, pl.name, segs, { refId: pl.id, sublabel: pl.kind });
      });
    }
    case 'kind': {
      const kinds = [...new Set(segments.map((s) => s.kind))];
      return kinds.map((k) => {
        const segs = segments.filter((s) => s.kind === k);
        return make(k, KIND_LABEL[k] ?? k, segs, { sublabel: plural(segs.length, 'block') });
      });
    }
    default:
      return [make('all', 'Everything', segments)];
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export const KIND_LABEL: Record<string, string> = {
  flight: 'Flight', transfer: 'Transfer', checkin: 'Check in', checkout: 'Check out',
  session: 'Session', workshop: 'Workshop', meal: 'Meal', activity: 'Activity',
  free: 'Free time', rest: 'Rest', buffer: 'Buffer', note: 'Note',
};

/* ---------- horizontal scale ---------- */

export interface Scale {
  start: Epoch;
  end: Epoch;
  pxPerHour: number;
  width: number;
  zone: Zone;
  x: (t: Epoch) => number;
  t: (x: number) => Epoch;
}

export function makeScale(start: Epoch, end: Epoch, pxPerHour: number, zone: Zone): Scale {
  const width = ((end - start) / HOUR) * pxPerHour;
  return {
    start, end, pxPerHour, width, zone,
    x: (t) => ((t - start) / HOUR) * pxPerHour,
    t: (x) => start + (x / pxPerHour) * HOUR,
  };
}

/** Pixels per hour.
 *
 *  The scale stops at 14px/h. Below that a block is a coloured sliver with no
 *  room for a single character, and a whole trip rendered that way tells you
 *  nothing you could not get from the trip grid — so "fit" scrolls a readable
 *  timeline rather than shrinking it into confetti. */
export const ZOOMS = [14, 22, 34, 52, 76, 110, 160, 230, 330] as const;
export const DEFAULT_ZOOM_INDEX = 3;

/** Hour ticks, thinned so labels never collide. */
export function hourTicks(scale: Scale): { t: Epoch; label: string; major: boolean }[] {
  const stepHours =
    scale.pxPerHour >= 120 ? 1 :
    scale.pxPerHour >= 60 ? 2 :
    scale.pxPerHour >= 34 ? 3 :
    scale.pxPerHour >= 20 ? 6 : 12;

  const out: { t: Epoch; label: string; major: boolean }[] = [];
  let cursor = scale.start;
  let guard = 0;
  while (cursor < scale.end && guard++ < 2000) {
    const p = toParts(cursor, scale.zone);
    if (p.hour % stepHours === 0) {
      out.push({
        t: cursor,
        label: `${String(p.hour).padStart(2, '0')}`,
        major: p.hour === 0 || p.hour === 12,
      });
    }
    cursor += HOUR;
  }
  return out;
}

export function dayBands(scale: Scale): { key: string; start: Epoch; end: Epoch; weekend: boolean }[] {
  return eachDay(scale.start, scale.end, scale.zone).map((key) => {
    const start = dateKeyToEpoch(key, scale.zone);
    const end = addDays(start, 1, scale.zone);
    const wd = toParts(start, scale.zone).weekday;
    return { key, start, end, weekend: wd === 0 || wd === 6 };
  });
}

/** Overnight bands (22:00 – 06:00) so sleep hours read at a glance. */
export function nightBands(scale: Scale, from = 22, to = 6): { start: Epoch; end: Epoch }[] {
  const out: { start: Epoch; end: Epoch }[] = [];
  for (const d of dayBands(scale)) {
    const p = toParts(d.start, scale.zone);
    out.push({
      start: fromZoned(p.year, p.month, p.day, from, 0, 0, scale.zone),
      end: fromZoned(p.year, p.month, p.day + 1, to, 0, 0, scale.zone),
    });
  }
  return out;
}

/* ---------- vertical (day grid) ---------- */

export interface VScale {
  dayStart: Epoch;
  pxPerHour: number;
  y: (t: Epoch) => number;
  t: (y: number) => Epoch;
  height: number;
}

export function makeVScale(dayStart: Epoch, pxPerHour: number): VScale {
  return {
    dayStart, pxPerHour,
    height: 24 * pxPerHour,
    y: (t) => ((t - dayStart) / HOUR) * pxPerHour,
    t: (y) => dayStart + (y / pxPerHour) * HOUR,
  };
}

/** Side-by-side placement for overlapping segments in one vertical column. */
export function packColumns(segments: Segment[]): Map<ID, { col: number; cols: number }> {
  const sorted = [...segments].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = new Map<ID, { col: number; cols: number }>();
  let cluster: Segment[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (!cluster.length) return;
    const colEnds: number[] = [];
    const assign = new Map<ID, number>();
    for (const s of cluster) {
      let c = colEnds.findIndex((e) => e <= s.start);
      if (c === -1) { c = colEnds.length; colEnds.push(0); }
      colEnds[c] = s.end;
      assign.set(s.id, c);
    }
    const cols = Math.max(1, colEnds.length);
    for (const s of cluster) out.set(s.id, { col: assign.get(s.id) ?? 0, cols });
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const s of sorted) {
    if (s.start >= clusterEnd) flush();
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, s.end);
  }
  flush();
  return out;
}

/** Nearest sensible snap step for the current zoom. */
export function snapStepFor(pxPerHour: number): number {
  if (pxPerHour >= 200) return 5;
  if (pxPerHour >= 100) return 10;
  if (pxPerHour >= 50) return 15;
  if (pxPerHour >= 26) return 30;
  return 60;
}

export function segmentsOnDay(segments: Segment[], key: string, zone: Zone): Segment[] {
  return segments.filter((s) => {
    const a = dateKey(s.start, zone);
    const b = dateKey(s.end - 1, zone);
    return a === key || b === key || (a < key && b > key);
  });
}

/** Clip a segment to a single day, for the day grid. */
export function clipToDay(seg: Segment, dayStart: Epoch): { top: Epoch; bottom: Epoch; clippedStart: boolean; clippedEnd: boolean } {
  const dayEnd = dayStart + DAY;
  return {
    top: Math.max(seg.start, dayStart),
    bottom: Math.min(seg.end, dayEnd),
    clippedStart: seg.start < dayStart,
    clippedEnd: seg.end > dayEnd,
  };
}

export const MINUTE = MIN;

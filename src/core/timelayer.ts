/** The time layer.
 *
 *  The board is not a calendar. Where a card sits says which day it belongs to
 *  and what it comes after — never what o'clock it is. That is deliberate, and
 *  nothing here changes it.
 *
 *  But a planner still has to see the clock. *Is Tuesday already full? How
 *  long between these two? Does this collide with that? Where is the free
 *  afternoon?* Reading the answer off twelve card headers is no way to plan a
 *  day, and a date alone is not enough to plan with.
 *
 *  So the time layer **derives** the clock from the cards and draws it where
 *  the question gets asked:
 *
 *    · a **ribbon** under each day frame — the shape of that day, its first
 *      and last hour, how much of it is spoken for, where the free stretch is,
 *      and any double-booking
 *    · a **gap chip** in the gutter between two stacked cards — how long the
 *      board is leaving between them, or by how much they overlap
 *
 *  Both are readouts. Position still means exactly what it meant, `resolve.ts`
 *  still reads the same board, and turning the layer off changes nothing but
 *  what you can see. The one place the clock flows the other way is the card's
 *  own time chip, where a planner types a time in — and that is an edit to the
 *  card, not to the board.
 *
 *  No React, no DOM. */

import type { Epoch, ID, IsoDate, Point, Segment, SegmentKind, Trip, Zone } from './types';
import { DAY, HOUR, MIN, clamp, dateKey, overlaps, pad, parseLocal, startOfDay } from './time';
import { boardColumns } from './resolve';
import { attendeesOf } from './schedule';
import { CARD_H, CARD_W } from './board';

/** A hole in the day shorter than this is not worth calling free time. */
export const FREE_STRETCH_MIN = 45;

/** Ribbon blocks are never thinner than this, so a fifteen-minute transfer is
 *  still something you can see and click. */
const MIN_BLOCK_MIN = 12;

/** `fmtDuration` with the spaces squeezed out: `3h55`, `1h`, `40m`.
 *
 *  The board reads durations in 9px type inside 60px chips, where "3 h 55 m"
 *  gets clipped to a lie ("3 h") and two of them in a row are unreadable.
 *  Everywhere with room to breathe still uses `fmtDuration`. */
export function compactDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / MIN));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h${pad(m)}` : `${h}h`;
}

/* ---------- one day, as a ribbon ---------- */

export interface DayBlock {
  id: ID;
  title: string;
  kind: SegmentKind;
  start: Epoch;
  end: Epoch;
  /** Where the card sits in the 24 hours, as fractions: 0 is midnight, 1 is
   *  the next midnight. Taken from the card's *own* local midnight, so a card
   *  that is still timed for the wrong date still shows the right hour. */
  from: number;
  to: number;
  /** Double-booked: overlaps another card on the day that shares somebody with
   *  it. Two parallel tracks for two different people are not a clash. */
  clash: boolean;
  /** Runs past midnight — the ribbon shows a stub rather than a lie. */
  wraps: boolean;
  /** Timed for another date than the frame it sits in, so resolving moves it. */
  offDay: boolean;
}

export interface DaySummary {
  count: number;
  first?: Epoch;
  last?: Epoch;
  /** Time actually spoken for, a double-booking counted once. */
  busyMs: number;
  /** The longest hole between the first start and the last end, when there is
   *  one worth mentioning. */
  gapFrom?: Epoch;
  gapTo?: Epoch;
  /** How many cards double-book somebody. */
  clashes: number;
  /** How many are timed for another date. */
  offDay: number;
  blocks: DayBlock[];
}

export const EMPTY_DAY: DaySummary = { count: 0, busyMs: 0, clashes: 0, offDay: 0, blocks: [] };

/** Read the clock off the cards in one day frame.
 *
 *  `zone` is the clock the planner is looking at — it decides where in the
 *  ribbon a block sits. Dates are bucketed in the trip's own zone instead,
 *  because that is the zone the resolver reads frames in: the board is one
 *  shared artefact and must not re-bucket itself when a viewer switches the UI
 *  to somebody else's clock. */
export function summariseDay(
  trip: Trip, cards: Segment[], dayKey: IsoDate, zone: Zone,
): DaySummary {
  const boardZone = trip.baseTimezone;
  const live = cards
    .filter((s) => s.status !== 'cancelled')
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (!live.length) return EMPTY_DAY;

  /* A clash is somebody being in two places at once — not two things merely
     happening at once. Two parallel tracks are the normal shape of a
     conference day, and a ribbon that called them a double-booking would cry
     wolf on every day of the trip. Read the same way the analyser reads it,
     free time included, so the board and the issues list agree. */
  const who = new Map<ID, Set<ID>>(live.map((s) => [s.id, new Set(attendeesOf(s, trip))]));
  const clashing = new Set<ID>();
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (b.start >= a.end) break;
      if (a.kind === 'free' || b.kind === 'free') continue;
      if (!overlaps(a.start, a.end, b.start, b.end)) continue;
      if (![...who.get(a.id)!].some((id) => who.get(b.id)!.has(id))) continue;
      clashing.add(a.id);
      clashing.add(b.id);
    }
  }

  const floor = MIN_BLOCK_MIN * MIN / DAY;
  const blocks: DayBlock[] = live.map((s) => {
    const midnight = startOfDay(s.start, zone);
    const from = clamp((s.start - midnight) / DAY, 0, 1);
    const raw = (s.end - midnight) / DAY;
    return {
      id: s.id, title: s.title, kind: s.kind, start: s.start, end: s.end,
      from,
      to: clamp(Math.max(raw, from + floor), 0, 1),
      clash: clashing.has(s.id),
      wraps: raw > 1,
      offDay: dateKey(s.start, boardZone) !== dayKey,
    };
  });

  // Busy time is the union of the cards, so an overlap is not counted twice.
  let busyMs = 0;
  let filledTo = -Infinity;
  for (const s of live) {
    const from = Math.max(s.start, filledTo);
    if (s.end > from) busyMs += s.end - from;
    filledTo = Math.max(filledTo, s.end);
  }

  // The biggest hole inside the day, which is where the next thing could go.
  let gapFrom: Epoch | undefined;
  let gapTo: Epoch | undefined;
  let widest = 0;
  filledTo = live[0].end;
  for (const s of live.slice(1)) {
    if (s.start - filledTo > widest) { widest = s.start - filledTo; gapFrom = filledTo; gapTo = s.start; }
    filledTo = Math.max(filledTo, s.end);
  }
  if (widest < FREE_STRETCH_MIN * MIN) { gapFrom = undefined; gapTo = undefined; }

  return {
    count: live.length,
    first: live[0].start,
    last: Math.max(...live.map((s) => s.end)),
    busyMs,
    gapFrom,
    gapTo,
    clashes: clashing.size,
    offDay: blocks.filter((b) => b.offDay).length,
    blocks,
  };
}

/* ---------- the gutter between two stacked cards ---------- */

export interface StackGap {
  key: string;
  fromId: ID;
  toId: ID;
  /** Where the chip goes, in board coordinates: the seam between the two. */
  at: Point;
  /** How much clear board the two cards leave for it. Negative when they
   *  physically overlap, in which case the view is better off staying quiet. */
  gutter: number;
  /** `to.start − from.end`. Negative when the two overlap in time. */
  ms: number;
  /** The lower card finishes before the upper one starts: the stack says one
   *  order and the clock says the other. Resolving swaps their times. */
  reversed: boolean;
  /** A connector already labels this pair, so the seam stays quiet rather than
   *  saying the same thing twice. */
  linked: boolean;
  /** The two are currently timed for different dates, which makes the number
   *  between them meaningless until the board is resolved. */
  crossDay: boolean;
}

export type GapTone = 'clash' | 'tight' | 'free' | 'long' | 'crossday';

/** Every seam in every day-frame column, top to bottom.
 *
 *  `boardZone` is the trip's own zone — the one the resolver reads dates in —
 *  so that two cards count as being on different days for the same reason the
 *  resolver would say so.
 *
 *  `visible` is the filtered set the view is showing: a column closes over a
 *  card the filters hid, so what you see stacked is what you get told about. */
export function stackGaps(trip: Trip, boardZone: Zone, visible?: Set<ID>): StackGap[] {
  const seg = new Map<ID, Segment>(trip.segments.map((s) => [s.id, s]));
  const wired = new Set<string>();
  for (const l of trip.links ?? []) { wired.add(`${l.fromId}>${l.toId}`); wired.add(`${l.toId}>${l.fromId}`); }

  const out: StackGap[] = [];
  const columns = boardColumns(trip, trip.segments.filter((s) => s.status !== 'cancelled'));
  for (const column of columns) {
    const members = column.members.filter((id) => !visible || visible.has(id));
    for (let i = 0; i < members.length - 1; i++) {
      const a = seg.get(members[i]);
      const b = seg.get(members[i + 1]);
      if (!a?.at || !b?.at) continue;
      const bottom = a.at.y + CARD_H;
      const gutter = b.at.y - bottom;
      out.push({
        key: `${a.id}~${b.id}`,
        fromId: a.id,
        toId: b.id,
        at: { x: (a.at.x + b.at.x) / 2 + CARD_W / 2, y: bottom + gutter / 2 },
        gutter,
        ms: b.start - a.end,
        reversed: b.end <= a.start,
        linked: wired.has(`${a.id}>${b.id}`),
        crossDay: dateKey(a.start, boardZone) !== dateKey(b.start, boardZone),
      });
    }
  }
  return out;
}

/** What the seam says. Short enough to sit in a 60px chip. */
export function describeGap(gap: StackGap): string {
  if (gap.crossDay) return 'next day';
  if (gap.reversed) return 'out of order';
  if (gap.ms <= -MIN) return `overlaps ${compactDuration(-gap.ms)}`;
  if (gap.ms < MIN) return 'no gap';
  return compactDuration(gap.ms);
}

/** How loudly it says it. */
export function gapTone(gap: StackGap): GapTone {
  if (gap.crossDay) return 'crossday';
  if (gap.reversed || gap.ms <= -MIN) return 'clash';
  if (gap.ms < 10 * MIN) return 'tight';
  if (gap.ms >= 4 * HOUR) return 'long';
  return 'free';
}

/* ---------- typing a time in ---------- */

/** Move a card to another time of day, keeping its date and its length.
 *
 *  `hhmm` is read in whatever zone the board is being *shown* in, because that
 *  is the clock the planner is reading off the card. The date comes from the
 *  same clock, so a card shown as Tuesday 23:30 stays on Tuesday. */
export function setTimeOfDay(seg: Segment, hhmm: string, zone: Zone): { start: Epoch; end: Epoch } {
  const start = parseLocal(dateKey(seg.start, zone), hhmm, zone);
  return { start, end: start + Math.max(5 * MIN, seg.end - seg.start) };
}

/** Change how long a card lasts. Its start does not move. */
export function setDuration(seg: Segment, minutes: number): { start: Epoch; end: Epoch } {
  return { start: seg.start, end: seg.start + Math.max(5, Math.round(minutes)) * MIN };
}

/** Nudge a card earlier or later, keeping its length. */
export function shiftBy(seg: Segment, minutes: number): { start: Epoch; end: Epoch } {
  return { start: seg.start + minutes * MIN, end: seg.end + minutes * MIN };
}

/** The durations worth offering as one click. */
export const DURATION_PRESETS = [15, 30, 45, 60, 90, 120, 180, 240] as const;

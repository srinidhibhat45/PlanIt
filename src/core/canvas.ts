/** Geometry for the planning canvas.
 *
 *  The canvas is a graph laid on a calendar: **days run across, hours run
 *  down**. Nothing floats freely — a node's position *is* its time, so moving
 *  it is scheduling it and there is no separate layout to keep in sync.
 *
 *  Three things are computed here, all pure:
 *    · columns — one per day, subdivided into tracks (the main line, then one
 *      per sub-trip running that day, so a day where the party splits is
 *      visibly wider than one where it does not);
 *    · nodes   — a rectangle per segment, clipped to its column and continued
 *      into the next one when it runs past midnight;
 *    · edges   — who goes from what to what. Edges are *bundled*: four people
 *      making the same hop is one thick line carrying four faces, not four
 *      lines. That is the difference between a diagram and a hairball.
 *
 *  No React, no DOM, no side effects — all of it is unit-testable. */

import type { Epoch, ID, IsoDate, Segment, Trip, Zone } from './types';
import { DAY, HOUR, MIN, dateKey, dateKeyToEpoch, toParts } from './time';
import { attendeesOf, byId } from './schedule';
import { estimateTravel, overheadMinutes, travelMinutes } from './travel';
import { branchDepth } from './branch';

export interface CanvasOptions {
  zone: Zone;
  days: IsoDate[];
  /** Visible time window, in local hours. `hourEnd` may exceed 24 to show the
   *  small hours of the following morning at the foot of a column. */
  hourStart: number;
  hourEnd: number;
  pxPerMin: number;
  /** Width of one track — a day column is this times its track count. */
  trackWidth: number;
  trackGap: number;
  /** Left gutter holding the hour labels. */
  gutter: number;
  /** Gap between day columns. */
  columnGap: number;
}

export const DEFAULT_CANVAS: Omit<CanvasOptions, 'zone' | 'days'> = {
  hourStart: 5, hourEnd: 26, pxPerMin: 1.15,
  trackWidth: 232, trackGap: 10, gutter: 62, columnGap: 26,
};

export interface CanvasTrack {
  /** 'main', or the branch id. */
  id: string;
  branchId?: ID;
  label: string;
  color?: string;
  depth: number;
  x: number;
  width: number;
}

export interface CanvasColumn {
  dayKey: IsoDate;
  index: number;
  /** Local midnight, the origin every y in this column is measured from. */
  dayStart: Epoch;
  x: number;
  width: number;
  tracks: CanvasTrack[];
  weekend: boolean;
}

export interface CanvasNode {
  /** Unique per rendered rectangle — a segment spanning midnight has two. */
  key: string;
  id: ID;
  seg: Segment;
  dayKey: IsoDate;
  x: number; y: number; w: number; h: number;
  trackId: string;
  branchId?: ID;
  attendees: ID[];
  clippedStart: boolean;
  clippedEnd: boolean;
  /** The tail of a segment that started on an earlier day. */
  continuation: boolean;
  /** Sub-column packing within the track, when things overlap. */
  col: number; cols: number;
  /** Stacking order, so a staggered card overlaps the ones behind it. */
  z: number;
}

export interface CanvasEdge {
  key: string;
  fromKey: string;
  toKey: string;
  fromId: ID;
  toId: ID;
  personIds: ID[];
  path: string;
  mid: { x: number; y: number };
  /** Straight-line seconds are not the point; this is the modelled journey. */
  needMin?: number;
  haveMin: number;
  distanceKm?: number;
  /** False when the journey cannot be made in the time allowed. */
  feasible: boolean;
  /** Same day, or a hop across columns. */
  crossesDay: boolean;
  /** A branch peeling off the shared line, or folding back into it. */
  role: 'flow' | 'split' | 'rejoin';
  color: string;
}

export interface PersonDay {
  personId: ID;
  dayKey: IsoDate;
  present: boolean;
  busyMin: number;
  /** Local-hour windows with nothing booked, inside the visible band. */
  free: { fromMin: number; toMin: number }[];
  firstStart?: Epoch;
  lastEnd?: Epoch;
  /** Set when the person is off on a sub-trip for some of this day. */
  branchIds: ID[];
}

export interface CanvasModel {
  options: CanvasOptions;
  columns: CanvasColumn[];
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  presence: PersonDay[];
  width: number;
  height: number;
  /** Fast lookup for hit-testing and for the inspector. */
  nodeByKey: Map<string, CanvasNode>;
  piecesById: Map<ID, CanvasNode[]>;
}

/* ---------- axis helpers ---------- */

/** Local minutes past midnight, allowing values past 1440 for an instant that
 *  falls on the following day — that is how a 01:00 finish lands at the bottom
 *  of the previous column rather than the top of the next one. */
export function minutesFromDayStart(at: Epoch, dayStart: Epoch): number {
  return (at - dayStart) / MIN;
}

export function yFor(minutes: number, o: Pick<CanvasOptions, 'hourStart' | 'pxPerMin'>): number {
  return (minutes - o.hourStart * 60) * o.pxPerMin;
}

/** Inverse of `yFor` — what instant a drop at this height means. */
export function timeAt(y: number, dayStart: Epoch, o: Pick<CanvasOptions, 'hourStart' | 'pxPerMin'>): Epoch {
  return dayStart + (y / o.pxPerMin + o.hourStart * 60) * MIN;
}

export function canvasHeight(o: Pick<CanvasOptions, 'hourStart' | 'hourEnd' | 'pxPerMin'>): number {
  return (o.hourEnd - o.hourStart) * 60 * o.pxPerMin;
}

/** Widen the window until every segment fits, then round out to whole hours.
 *  Starting from a fixed 05:00–02:00 and growing only when something falls
 *  outside keeps most trips on an identical, comparable axis. */
export function fitHours(
  segments: Segment[], days: IsoDate[], zone: Zone,
  base: { hourStart: number; hourEnd: number } = DEFAULT_CANVAS,
): { hourStart: number; hourEnd: number } {
  let lo = base.hourStart;
  let hi = base.hourEnd;
  for (const s of segments) {
    const key = dateKey(s.start, zone);
    if (!days.includes(key)) continue;
    const dayStart = dateKeyToEpoch(key, zone);
    lo = Math.min(lo, Math.floor(minutesFromDayStart(s.start, dayStart) / 60));
    hi = Math.max(hi, Math.ceil(minutesFromDayStart(s.end, dayStart) / 60));
  }
  return { hourStart: Math.max(0, lo), hourEnd: Math.min(48, Math.max(hi, lo + 6)) };
}

/* ---------- columns ---------- */

function tracksForDay(trip: Trip, dayStart: Epoch, o: CanvasOptions): CanvasTrack[] {
  const dayEnd = dayStart + (o.hourEnd - o.hourStart) * HOUR + o.hourStart * HOUR;
  const active = new Map<ID, number>();
  for (const s of trip.segments) {
    if (!s.branchId || s.status === 'cancelled') continue;
    if (s.end <= dayStart || s.start >= dayEnd) continue;
    active.set(s.branchId, (active.get(s.branchId) ?? 0) + 1);
  }

  const tracks: CanvasTrack[] = [
    { id: 'main', label: 'Everyone', depth: 0, x: 0, width: o.trackWidth },
  ];
  const branches = trip.branches
    .filter((b) => active.has(b.id))
    .sort((a, b) => branchDepth(trip, a.id) - branchDepth(trip, b.id) || a.name.localeCompare(b.name));
  for (const b of branches) {
    tracks.push({
      id: b.id, branchId: b.id, label: b.name, color: b.color,
      depth: branchDepth(trip, b.id) + 1,
      x: 0, width: o.trackWidth,
    });
  }
  let x = 0;
  for (const t of tracks) { t.x = x; x += t.width + o.trackGap; }
  return tracks;
}

export function buildColumns(trip: Trip, o: CanvasOptions): CanvasColumn[] {
  const cols: CanvasColumn[] = [];
  let x = o.gutter;
  o.days.forEach((dayKey, index) => {
    const dayStart = dateKeyToEpoch(dayKey, o.zone);
    const tracks = tracksForDay(trip, dayStart, o);
    const width = tracks.reduce((a, t) => a + t.width + o.trackGap, 0) - o.trackGap;
    const wd = toParts(dayStart + 12 * HOUR, o.zone).weekday;
    cols.push({ dayKey, index, dayStart, x, width, tracks, weekend: wd === 0 || wd === 6 });
    x += width + o.columnGap;
  });
  return cols;
}

/* ---------- nodes ---------- */

/** Greedy sub-column packing inside one track, so overlapping items sit side
 *  by side rather than on top of one another. */
function packWithin(items: { key: string; top: number; bottom: number }[]): Map<string, { col: number; cols: number }> {
  const out = new Map<string, { col: number; cols: number }>();
  const sorted = [...items].sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  let cluster: typeof sorted = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (!cluster.length) return;
    const colEnds: number[] = [];
    const assigned = new Map<string, number>();
    for (const it of cluster) {
      let c = colEnds.findIndex((end) => end <= it.top);
      if (c === -1) { c = colEnds.length; colEnds.push(0); }
      colEnds[c] = it.bottom;
      assigned.set(it.key, c);
    }
    const cols = Math.max(1, colEnds.length);
    for (const it of cluster) out.set(it.key, { col: assigned.get(it.key) ?? 0, cols });
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const it of sorted) {
    if (it.top >= clusterEnd && cluster.length) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.bottom);
  }
  flush();
  return out;
}

const MIN_NODE_H = 26;

export function buildNodes(trip: Trip, segments: Segment[], columns: CanvasColumn[], o: CanvasOptions): CanvasNode[] {
  const byDay = new Map<IsoDate, CanvasColumn>(columns.map((c) => [c.dayKey, c]));
  const height = canvasHeight(o);
  const raw: (Omit<CanvasNode, 'col' | 'cols' | 'x' | 'w' | 'z'> & { track: CanvasTrack; column: CanvasColumn })[] = [];

  for (const seg of segments) {
    // A segment can appear in more than one column when it runs past midnight.
    // Each appearance is its own rectangle so that neither piece has to be
    // drawn outside its own day.
    let cursorDay = dateKey(seg.start, o.zone);
    let piece = 0;
    while (piece < 4) {
      const column = byDay.get(cursorDay);
      if (!column) break;
      const fromMin = minutesFromDayStart(seg.start, column.dayStart);
      const toMin = minutesFromDayStart(seg.end, column.dayStart);
      const visTop = Math.max(fromMin, o.hourStart * 60);
      const visBottom = Math.min(toMin, o.hourEnd * 60);
      if (visBottom > visTop) {
        const track =
          column.tracks.find((t) => t.branchId === seg.branchId) ?? column.tracks[0];
        const y = yFor(visTop, o);
        const h = Math.max(MIN_NODE_H, yFor(visBottom, o) - y);
        raw.push({
          key: piece === 0 ? seg.id : `${seg.id}#${piece}`,
          id: seg.id,
          seg,
          dayKey: cursorDay,
          y, h,
          trackId: track.id,
          branchId: seg.branchId,
          attendees: attendeesOf(seg, trip),
          clippedStart: fromMin < o.hourStart * 60,
          clippedEnd: toMin > o.hourEnd * 60,
          continuation: piece > 0,
          track, column,
        });
      }
      // Continue into the next day only if the segment really reaches past the
      // bottom of the window we just drew.
      const nextDayStart = column.dayStart + DAY;
      if (seg.end <= nextDayStart + o.hourStart * HOUR) break;
      cursorDay = dateKey(nextDayStart + 6 * HOUR, o.zone);
      piece += 1;
    }
  }

  // Pack per (column, track) so a busy afternoon splits into sub-columns.
  const groups = new Map<string, typeof raw>();
  for (const r of raw) {
    const k = `${r.dayKey}|${r.trackId}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  const nodes: CanvasNode[] = [];
  for (const group of groups.values()) {
    const packed = packWithin(group.map((r) => ({ key: r.key, top: r.y, bottom: r.y + r.h })));
    for (const r of group) {
      const { col, cols } = packed.get(r.key) ?? { col: 0, cols: 1 };
      const inner = r.track.width;
      // Overlapping cards are *staggered*, not divided. Four concurrent
      // red-eyes split evenly would be 58 px each — too narrow for a flight
      // number. Fanned like a hand of cards, each one keeps most of the track
      // and the ones behind still show their spine and their start time.
      const inset = Math.min(26, inner * 0.14);
      const x = r.column.x + r.track.x + col * inset;
      const w = inner - col * inset;
      const { track: _t, column: _c, ...rest } = r;
      nodes.push({ ...rest, x, w, col, cols, z: 2 + col, y: Math.min(r.y, height - MIN_NODE_H) });
    }
  }
  return nodes.sort((a, b) => a.y - b.y || a.x - b.x);
}

/* ---------- edges ---------- */

function bezier(
  a: { x: number; y: number }, b: { x: number; y: number }, sameColumn: boolean,
): string {
  if (sameColumn) {
    const dy = Math.max(14, Math.min(70, Math.abs(b.y - a.y) * 0.45));
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`;
  }
  const dx = Math.max(28, Math.min(150, Math.abs(b.x - a.x) * 0.45));
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/** Midpoint of a cubic at t=0.5, which is where the headcount chip goes. */
function midOf(a: { x: number; y: number }, b: { x: number; y: number }, sameColumn: boolean) {
  if (sameColumn) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

interface PendingEdge {
  fromKey: string; toKey: string; fromId: ID; toId: ID;
  personIds: Set<ID>;
}

export function buildEdges(
  trip: Trip, nodes: CanvasNode[], opts: { bufferMin?: number } = {},
): CanvasEdge[] {
  const piecesById = new Map<ID, CanvasNode[]>();
  for (const n of nodes) piecesById.set(n.id, [...(piecesById.get(n.id) ?? []), n]);
  for (const list of piecesById.values()) list.sort((a, b) => a.x - b.x || a.y - b.y);

  const places = byId(trip.places);
  const pending = new Map<string, PendingEdge>();

  for (const person of trip.people) {
    const chain = trip.segments
      .filter((s) => s.status !== 'cancelled' && attendeesOf(s, trip).includes(person.id) && piecesById.has(s.id))
      .sort((a, b) => a.start - b.start || a.end - b.end);

    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      if (a.id === b.id) continue;
      const fromPieces = piecesById.get(a.id)!;
      const toPieces = piecesById.get(b.id)!;
      // Leave from the last rectangle the segment occupies and arrive at the
      // first, so an overnight flight departs from its tail, not its head.
      const from = fromPieces[fromPieces.length - 1];
      const to = toPieces[0];
      const key = `${from.key}->${to.key}`;
      const found = pending.get(key);
      if (found) found.personIds.add(person.id);
      else pending.set(key, { fromKey: from.key, toKey: to.key, fromId: a.id, toId: b.id, personIds: new Set([person.id]) });
    }
  }

  const nodeByKey = new Map(nodes.map((n) => [n.key, n]));
  const peopleById = byId(trip.people);
  const buffer = opts.bufferMin ?? 0;
  const edges: CanvasEdge[] = [];

  for (const p of pending.values()) {
    const from = nodeByKey.get(p.fromKey);
    const to = nodeByKey.get(p.toKey);
    if (!from || !to) continue;

    const sameColumn = from.dayKey === to.dayKey;
    const start = sameColumn
      ? { x: from.x + from.w / 2, y: from.y + from.h }
      : { x: from.x + from.w, y: from.y + from.h / 2 };
    const end = sameColumn
      ? { x: to.x + to.w / 2, y: to.y }
      : { x: to.x, y: to.y + to.h / 2 };

    const segA = from.seg;
    const segB = to.seg;
    const haveMin = (segB.start - segA.end) / MIN;

    let needMin: number | undefined;
    let distanceKm: number | undefined;
    const fromPlace = places.get(segA.toPlaceId ?? segA.placeId ?? '');
    const toPlace = places.get(segB.fromPlaceId ?? segB.placeId ?? '');
    if (fromPlace && toPlace && fromPlace.id !== toPlace.id && segA.kind !== 'transfer' && segB.kind !== 'transfer') {
      const est = estimateTravel({ from: fromPlace, to: toPlace, mode: 'taxi', departAt: segA.end });
      needMin = travelMinutes(est) + overheadMinutes('taxi', fromPlace.kind, toPlace.kind);
      distanceKm = est.distanceKm;
    }

    const ids = [...p.personIds];
    const role: CanvasEdge['role'] =
      !segA.branchId && segB.branchId ? 'split'
        : segA.branchId && !segB.branchId ? 'rejoin'
          : 'flow';

    edges.push({
      key: p.fromKey + '>' + p.toKey,
      fromKey: p.fromKey, toKey: p.toKey, fromId: p.fromId, toId: p.toId,
      personIds: ids,
      path: bezier(start, end, sameColumn),
      mid: midOf(start, end, sameColumn),
      needMin, haveMin, distanceKm,
      feasible: needMin === undefined || haveMin >= needMin + buffer,
      crossesDay: !sameColumn,
      role,
      color: ids.length === 1
        ? peopleById.get(ids[0])?.color ?? 'var(--line-3)'
        : 'var(--flow-bundle)',
    });
  }

  return edges.sort((a, b) => a.personIds.length - b.personIds.length);
}

/* ---------- presence and free time ---------- */

/** What each person's day looks like: are they even here, how loaded are they,
 *  and where are the gaps big enough to put something in. */
export function buildPresence(trip: Trip, o: CanvasOptions): PersonDay[] {
  const out: PersonDay[] = [];
  const minFreeMin = 45;

  for (const person of trip.people) {
    const segs = trip.segments
      .filter((s) => s.status !== 'cancelled' && attendeesOf(s, trip).includes(person.id))
      .sort((a, b) => a.start - b.start);

    for (const dayKey of o.days) {
      const dayStart = dateKeyToEpoch(dayKey, o.zone);
      const windowFrom = dayStart + o.hourStart * HOUR;
      const windowTo = dayStart + o.hourEnd * HOUR;
      const today = segs.filter((s) => s.start < windowTo && windowFrom < s.end);

      // Someone who has declared no window and booked nothing is available for
      // the whole trip — that is what the roster says on their card, and it is
      // what makes their face draggable onto the first card of an empty board.
      const present =
        today.length > 0 ||
        ((person.windowStart === undefined || person.windowStart < windowTo) &&
          (person.windowEnd === undefined || person.windowEnd > windowFrom));

      // Merge the day's commitments, then invert to get the gaps.
      const busy: { from: number; to: number }[] = [];
      for (const s of today) {
        const from = Math.max(minutesFromDayStart(s.start, dayStart), o.hourStart * 60);
        const to = Math.min(minutesFromDayStart(s.end, dayStart), o.hourEnd * 60);
        const last = busy[busy.length - 1];
        if (last && from <= last.to) last.to = Math.max(last.to, to);
        else busy.push({ from, to });
      }
      const busyMin = busy.reduce((a, b) => a + (b.to - b.from), 0);

      const free: { fromMin: number; toMin: number }[] = [];
      if (present) {
        let cursor = o.hourStart * 60;
        for (const b of busy) {
          if (b.from - cursor >= minFreeMin) free.push({ fromMin: cursor, toMin: b.from });
          cursor = Math.max(cursor, b.to);
        }
        if (o.hourEnd * 60 - cursor >= minFreeMin) free.push({ fromMin: cursor, toMin: o.hourEnd * 60 });
      }

      out.push({
        personId: person.id, dayKey, present, busyMin, free,
        firstStart: today[0]?.start,
        lastEnd: today.length ? today[today.length - 1].end : undefined,
        branchIds: [...new Set(today.map((s) => s.branchId).filter((b): b is ID => !!b))],
      });
    }
  }
  return out;
}

/* ---------- the whole model ---------- */

export function buildCanvas(trip: Trip, segments: Segment[], o: CanvasOptions): CanvasModel {
  const columns = buildColumns(trip, o);
  const nodes = buildNodes(trip, segments, columns, o);
  const edges = buildEdges(trip, nodes);
  const presence = buildPresence(trip, o);
  const last = columns[columns.length - 1];

  const piecesById = new Map<ID, CanvasNode[]>();
  for (const n of nodes) piecesById.set(n.id, [...(piecesById.get(n.id) ?? []), n]);

  return {
    options: o,
    columns, nodes, edges, presence,
    width: last ? last.x + last.width + o.columnGap : o.gutter,
    height: canvasHeight(o),
    nodeByKey: new Map(nodes.map((n) => [n.key, n])),
    piecesById,
  };
}

/** Which column and track a point lands in — the drop target for a drag. */
export function hitColumn(
  model: CanvasModel, x: number,
): { column: CanvasColumn; track: CanvasTrack } | null {
  for (const column of model.columns) {
    if (x < column.x || x > column.x + column.width) continue;
    const local = x - column.x;
    let best = column.tracks[0];
    for (const t of column.tracks) {
      if (local >= t.x && local <= t.x + t.width) { best = t; break; }
      if (local > t.x) best = t;
    }
    return { column, track: best };
  }
  return null;
}

/** Hour lines for the gutter and the grid behind the nodes. */
export function hourLines(o: CanvasOptions): { hour: number; label: string; y: number; major: boolean }[] {
  const out: { hour: number; label: string; y: number; major: boolean }[] = [];
  for (let h = Math.ceil(o.hourStart); h <= o.hourEnd; h++) {
    const wrapped = ((h % 24) + 24) % 24;
    out.push({
      hour: h,
      label: `${String(wrapped).padStart(2, '0')}:00`,
      y: yFor(h * 60, o),
      major: wrapped % 6 === 0,
    });
  }
  return out;
}

/** The hours most people are asleep, drawn as a darker band. */
export function nightSpans(o: CanvasOptions): { top: number; height: number }[] {
  const spans: { top: number; height: number }[] = [];
  for (let h = Math.floor(o.hourStart); h < o.hourEnd; h++) {
    const wrapped = ((h % 24) + 24) % 24;
    if (wrapped >= 22 || wrapped < 6) {
      const top = yFor(h * 60, o);
      const last = spans[spans.length - 1];
      const height = 60 * o.pxPerMin;
      if (last && Math.abs(last.top + last.height - top) < 0.5) last.height += height;
      else spans.push({ top, height });
    }
  }
  return spans;
}

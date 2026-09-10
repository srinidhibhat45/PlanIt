/** Geometry for the freeform board.
 *
 *  The board is an unbounded plane. Cards sit wherever they were put; nothing
 *  about a position implies a time on its own. What position *does* carry is
 *  containment — which frame a card is inside — and, within a day frame, the
 *  order of the day from top to bottom. `resolve.ts` turns that into a
 *  schedule; this file only ever deals in points and rectangles.
 *
 *  No React, no DOM. */

import type { Frame, ID, Point, Rect, Segment, Sticky, Trip, Zone } from './types';
import { DAY, HOUR, MIN, dateKey, eachDay } from './time';
import { attendeesOf } from './schedule';
import { area, contains } from './resolve';

/* ---------- the viewport ---------- */

export interface Viewport {
  /** Board coordinate currently at the top-left of the visible area. */
  x: number;
  y: number;
  zoom: number;
}

export const ZOOM_MIN = 0.12;
export const ZOOM_MAX = 3;
export const DEFAULT_VIEWPORT: Viewport = { x: -80, y: -80, zoom: 0.8 };

export function toWorld(v: Viewport, screenX: number, screenY: number): Point {
  return { x: v.x + screenX / v.zoom, y: v.y + screenY / v.zoom };
}

export function toScreen(v: Viewport, world: Point): Point {
  return { x: (world.x - v.x) * v.zoom, y: (world.y - v.y) * v.zoom };
}

/** Zoom about a fixed screen point, so the board does not slide out from under
 *  the cursor while the wheel turns. */
export function zoomAt(v: Viewport, screenX: number, screenY: number, factor: number): Viewport {
  const zoom = clampZoom(v.zoom * factor);
  const before = toWorld(v, screenX, screenY);
  const after = { x: before.x - screenX / zoom, y: before.y - screenY / zoom };
  return { x: after.x, y: after.y, zoom };
}

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** A viewport that fits `rect` inside a viewport of this size, with margin. */
export function fitTo(rect: Rect, width: number, height: number, margin = 72): Viewport {
  if (rect.w <= 0 || rect.h <= 0) return DEFAULT_VIEWPORT;
  const zoom = clampZoom(Math.min(
    (width - margin * 2) / rect.w,
    (height - margin * 2) / rect.h,
  ));
  return {
    x: rect.x + rect.w / 2 - width / (2 * zoom),
    y: rect.y + rect.h / 2 - height / (2 * zoom),
    zoom,
  };
}

/* ---------- card geometry ---------- */

export const CARD_W = 218;
export const CARD_H = 96;
export const STICKY_W = 168;
export const STICKY_H = 132;

export function cardRect(seg: Segment): Rect {
  return { x: seg.at?.x ?? 0, y: seg.at?.y ?? 0, w: CARD_W, h: CARD_H };
}

export function stickyRect(s: Sticky): Rect {
  return { x: s.at.x, y: s.at.y, w: STICKY_W, h: STICKY_H };
}

export function centreOf(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function overlapsRect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Normalise a drag rectangle, which may have been drawn in any direction. */
export function normalise(from: Point, to: Point): Rect {
  return {
    x: Math.min(from.x, to.x), y: Math.min(from.y, to.y),
    w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y),
  };
}

/** Everything on the board, as one rectangle. Used by "fit to content". */
export function contentBounds(trip: Trip): Rect {
  const rects: Rect[] = [
    ...trip.segments.filter((s) => s.at).map(cardRect),
    ...(trip.stickies ?? []).map(stickyRect),
    ...(trip.frames ?? []).map((f) => f.rect),
  ];
  if (!rects.length) return { x: 0, y: 0, w: 1200, h: 800 };
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

/* ---------- containment ---------- */

/** The smallest frame holding this point — "inside" in the visual sense, so a
 *  frame drawn inside another one wins. */
export function frameAt(trip: Trip, p: Point, filter?: (f: Frame) => boolean): Frame | undefined {
  return (trip.frames ?? [])
    .filter((f) => (!filter || filter(f)) && contains(f.rect, p))
    .sort((a, b) => area(a.rect) - area(b.rect))[0];
}

export function cardsInFrame(trip: Trip, frame: Frame): Segment[] {
  return trip.segments
    .filter((s) => s.at && contains(frame.rect, s.at))
    .sort((a, b) => (a.at!.y - b.at!.y) || (a.at!.x - b.at!.x));
}

/** Which cards a marquee caught. */
export function cardsIn(trip: Trip, rect: Rect): ID[] {
  return trip.segments.filter((s) => s.at && overlapsRect(cardRect(s), rect)).map((s) => s.id);
}

/* ---------- connectors ---------- */

export type Side = 'top' | 'right' | 'bottom' | 'left';

function portOf(r: Rect, side: Side): Point {
  switch (side) {
    case 'top': return { x: r.x + r.w / 2, y: r.y };
    case 'bottom': return { x: r.x + r.w / 2, y: r.y + r.h };
    case 'left': return { x: r.x, y: r.y + r.h / 2 };
    case 'right': return { x: r.x + r.w, y: r.y + r.h / 2 };
  }
}

/** Which way a connector should leave A and enter B, from where they sit.
 *  Mostly-horizontal separations route out of the sides; mostly-vertical ones
 *  route out of the top and bottom. It is what makes a hand-arranged graph
 *  read as a graph rather than as a bowl of spaghetti. */
export function sidesFor(a: Rect, b: Rect): { from: Side; to: Side } {
  const ca = centreOf(a);
  const cb = centreOf(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  if (Math.abs(dx) > Math.abs(dy) * 1.1) {
    return dx >= 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
  }
  return dy >= 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
}

export interface Connector {
  path: string;
  start: Point;
  end: Point;
  mid: Point;
}

/** A cubic with its control points pushed straight out of the chosen sides,
 *  which keeps the line clear of both cards as it leaves and arrives. */
export function connector(a: Rect, b: Rect): Connector {
  const { from, to } = sidesFor(a, b);
  const start = portOf(a, from);
  const end = portOf(b, to);
  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  const pull = Math.max(34, Math.min(150, dist * 0.42));
  const out = offset(from, pull);
  const into = offset(to, pull);
  const c1 = { x: start.x + out.x, y: start.y + out.y };
  const c2 = { x: end.x + into.x, y: end.y + into.y };
  return {
    path: `M ${r(start.x)} ${r(start.y)} C ${r(c1.x)} ${r(c1.y)}, ${r(c2.x)} ${r(c2.y)}, ${r(end.x)} ${r(end.y)}`,
    start,
    end,
    // The midpoint of a cubic at t = 0.5, where the label goes.
    mid: {
      x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
      y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8,
    },
  };
}

function offset(side: Side, by: number): Point {
  switch (side) {
    case 'top': return { x: 0, y: -by };
    case 'bottom': return { x: 0, y: by };
    case 'left': return { x: -by, y: 0 };
    case 'right': return { x: by, y: 0 };
  }
}

const r = (n: number) => Math.round(n * 10) / 10;

/* ---------- people flows ---------- */

export interface Flow {
  key: string;
  fromId: ID;
  toId: ID;
  personIds: ID[];
  path: string;
  mid: Point;
}

/** Who goes from what to what, derived from attendance and the clock rather
 *  than from anything the planner drew. Bundled: four people making the same
 *  hop is one line carrying four faces. Shown as an overlay, because on a
 *  freeform board the drawn connectors are the primary structure. */
export function peopleFlows(trip: Trip, rects: Map<ID, Rect>): Flow[] {
  const pending = new Map<string, { fromId: ID; toId: ID; people: Set<ID> }>();

  for (const person of trip.people) {
    const chain = trip.segments
      .filter((s) => s.status !== 'cancelled' && rects.has(s.id) && attendeesOf(s, trip).includes(person.id))
      .sort((a, b) => a.start - b.start);
    for (let i = 0; i < chain.length - 1; i++) {
      const key = `${chain[i].id}->${chain[i + 1].id}`;
      const found = pending.get(key);
      if (found) found.people.add(person.id);
      else pending.set(key, { fromId: chain[i].id, toId: chain[i + 1].id, people: new Set([person.id]) });
    }
  }

  const out: Flow[] = [];
  for (const [key, p] of pending) {
    const a = rects.get(p.fromId);
    const b = rects.get(p.toId);
    if (!a || !b) continue;
    const c = connector(a, b);
    out.push({ key, fromId: p.fromId, toId: p.toId, personIds: [...p.people], path: c.path, mid: c.mid });
  }
  return out.sort((x, y) => x.personIds.length - y.personIds.length);
}

/* ---------- laying a schedule out on the board ---------- */

export interface LayoutResult {
  positions: Map<ID, Point>;
  frames: Frame[];
}

const COL_W = CARD_W + 72;
const FRAME_PAD = 34;
/** Vertical breathing room between two cards stacked in one lane. The gap
 *  grows with the real gap between them, between these two bounds. */
const ROW_GAP_MIN = 20;
const ROW_GAP_MAX = 128;

/** Arrange the board from the schedule: a frame per day, cards stacked inside
 *  it in time order, lanes within a day for cards that overlap.
 *
 *  This is the reverse of `resolveBoard`, and it is what makes the round trip
 *  legible — tidy, drag things about, resolve, tidy again. It is deliberately
 *  an explicit action rather than something that happens on its own: a board
 *  that rearranges itself under your hands is not a board. */
export function layoutFromSchedule(
  trip: Trip, zone: Zone, opts: { makeFrames?: boolean } = {},
): LayoutResult {
  const positions = new Map<ID, Point>();
  const live = trip.segments.filter((s) => s.status !== 'cancelled');
  if (!live.length) return { positions, frames: [] };

  const days = eachDay(
    Math.min(...live.map((s) => s.start)),
    Math.max(...live.map((s) => s.end)),
    zone,
  );

  const frames: Frame[] = [];
  let x = 0;

  for (const [index, day] of days.entries()) {
    const onDay = live
      .filter((s) => dateKey(s.start, zone) === day)
      .sort((a, b) => a.start - b.start || a.end - b.end);

    // Lanes so that two things at once sit side by side rather than on top of
    // one another. A lane is free once its last card has finished.
    const lanes: { endsAt: number; bottom: number }[] = [];
    let deepest = 0;

    for (const seg of onDay) {
      let lane = lanes.findIndex((l) => l.endsAt <= seg.start);
      if (lane === -1) { lane = lanes.length; lanes.push({ endsAt: 0, bottom: FRAME_PAD - ROW_GAP_MIN }); }

      // Stack down the lane rather than deriving y from the clock. Deriving it
      // rounded two cards an hour apart onto the same row and overlapped them;
      // stacking cannot, and a gap proportional to the real one keeps the
      // vertical reading honest without making a twelve-hour day 2000px tall.
      const idle = Math.max(0, (seg.start - lanes[lane].endsAt) / HOUR);
      const gap = lanes[lane].endsAt === 0
        ? ROW_GAP_MIN
        : Math.min(ROW_GAP_MAX, Math.max(ROW_GAP_MIN, Math.round(idle * 44)));
      const y = lanes[lane].bottom + gap;

      positions.set(seg.id, { x: x + FRAME_PAD + lane * COL_W, y });
      lanes[lane] = { endsAt: seg.end, bottom: y + CARD_H };
      deepest = Math.max(deepest, y + CARD_H);
    }

    const laneCount = Math.max(1, lanes.length);
    const frameW = FRAME_PAD * 2 + laneCount * COL_W - (COL_W - CARD_W);
    const frameH = Math.max(280, deepest + FRAME_PAD);
    if (opts.makeFrames !== false) {
      const existing = (trip.frames ?? []).find((f) => f.dayKey === day);
      frames.push({
        id: existing?.id ?? `frame_day_${day}`,
        title: existing?.title ?? `Day ${index + 1}`,
        rect: { x, y: 0, w: frameW, h: frameH },
        color: existing?.color ?? 'var(--line-3)',
        dayKey: day,
      });
    }
    x += frameW + 56;
  }

  return { positions, frames };
}

/** Somewhere sensible to drop a brand new card: just right of everything, at
 *  the top, so it is never born underneath something else. */
export function nextFreeSpot(trip: Trip, near?: Point): Point {
  if (near) {
    const taken = (p: Point) => trip.segments.some(
      (s) => s.at && Math.abs(s.at.x - p.x) < 24 && Math.abs(s.at.y - p.y) < 24,
    );
    let spot = { ...near };
    let guard = 0;
    while (taken(spot) && guard++ < 40) spot = { x: spot.x + 26, y: spot.y + 26 };
    return spot;
  }
  const b = contentBounds(trip);
  return { x: b.x + b.w + 64, y: b.y };
}

/** Cards that would move if the planner hit resolve — used to show, before
 *  they commit to it, which parts of the board are actually wired up. */
export function isScheduled(trip: Trip, seg: Segment): boolean {
  if (seg.pinned) return false;
  if ((trip.links ?? []).some((l) => l.toId === seg.id)) return true;
  return !!seg.at && !!frameAt(trip, seg.at, (f) => !!f.dayKey);
}

export { contains, DAY, MIN };

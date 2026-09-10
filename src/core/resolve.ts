/** Board → timeline.
 *
 *  The board is arranged by hand and means nothing to a calendar on its own.
 *  This is the pass that reads it and hands back times, from three sources, in
 *  this order of authority:
 *
 *    1. **Pinned cards.** A time the planner typed in. Never moved; everything
 *       else schedules around it.
 *    2. **Frames.** A card sitting inside a day frame happens on that day, and
 *       within the frame *top to bottom is the order of the day* — which is
 *       what makes dragging a card up the board an act of planning rather than
 *       of tidying.
 *    3. **Connectors.** `A → B` means B is after A. A travel connector costs
 *       the modelled journey between the two places, traffic and airport
 *       overheads included.
 *
 *  Two rules keep it from being destructive, which matters because people run
 *  it on plans that are already half-timed:
 *
 *    · **A card opts in.** One that is neither pinned, framed, nor linked is
 *      left exactly where it is.
 *    · **It only ever pushes forward.** Times a planner typed are kept unless
 *      the board actually contradicts them: a card on the wrong day moves day
 *      (keeping its time of day), a card that cannot start that early is
 *      pushed later, and cards whose vertical order disagrees with their
 *      chronological order swap times with each other. Nothing is invented, and
 *      nothing is pulled earlier. */

import type { Epoch, ID, IsoDate, Issue, Link, Place, Segment, Trip } from './types';
import { DAY, MIN, addDays, dateKey, dateKeyToEpoch, fmtDate, fmtTime } from './time';

/** Kept in step with `CARD_W` in `board.ts`. It lives here as a plain number so
 *  the resolver does not have to import the board's geometry, which imports
 *  this file. */
const CARD_WIDTH = 218;

/** Cards closer together than this vertically are treated as level: a board is
 *  arranged by hand, and a few pixels is not an instruction. */
const NEAR_TIE = 48;
import { attendeesOf, byId } from './schedule';
import { estimateTravel, overheadMinutes, travelMinutes } from './travel';

export interface ResolveOptions {
  /** Slack added after every journey, on top of the modelled time. */
  bufferMin: number;
  /** Extra gap forced between two cards stacked in the same column. Zero by
   *  default: lunch ending as the afternoon session begins is a normal thing
   *  for a plan to say, and inventing ten minutes of slack there would rewrite
   *  a perfectly good schedule. Stacking means *after*, not *after a break*. */
  turnaroundMin: number;
  /** A travel connector with no places at either end still costs something. */
  unknownTravelMin: number;
}

export const DEFAULT_RESOLVE: ResolveOptions = {
  bufferMin: 10, turnaroundMin: 0, unknownTravelMin: 30,
};

export interface ResolvedMove {
  id: ID;
  from: Epoch;
  to: Epoch;
}

export interface Resolution {
  /** Only the cards whose time actually changed. */
  moves: ResolvedMove[];
  /** Cycles and pins that contradict their own inputs. */
  issues: Issue[];
  /** How many cards the resolver considered at all. */
  considered: number;
}

/* ---------- graph ---------- */

interface Graph {
  incoming: Map<ID, Link[]>;
  outgoing: Map<ID, Link[]>;
}

function buildGraph(links: Link[], live: Set<ID>): Graph {
  const incoming = new Map<ID, Link[]>();
  const outgoing = new Map<ID, Link[]>();
  for (const l of links) {
    if (!live.has(l.fromId) || !live.has(l.toId) || l.fromId === l.toId) continue;
    incoming.set(l.toId, [...(incoming.get(l.toId) ?? []), l]);
    outgoing.set(l.fromId, [...(outgoing.get(l.fromId) ?? []), l]);
  }
  return { incoming, outgoing };
}

/** Kahn's algorithm, with ties broken by the caller's ordering so that two
 *  cards with no relationship still resolve in the order they sit on the
 *  board rather than in whatever order the map happened to iterate. */
export function topoOrder(
  ids: ID[], graph: Graph, rank: (id: ID) => number,
): { order: ID[]; cycle: ID[] } {
  const indegree = new Map<ID, number>(ids.map((id) => [id, (graph.incoming.get(id) ?? []).length]));
  const ready = ids.filter((id) => (indegree.get(id) ?? 0) === 0).sort((a, b) => rank(a) - rank(b));
  const order: ID[] = [];

  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const l of graph.outgoing.get(id) ?? []) {
      const left = (indegree.get(l.toId) ?? 0) - 1;
      indegree.set(l.toId, left);
      if (left === 0) {
        // Insert by rank rather than pushing, so the queue stays sorted.
        const at = ready.findIndex((x) => rank(x) > rank(l.toId));
        if (at === -1) ready.push(l.toId); else ready.splice(at, 0, l.toId);
      }
    }
  }

  const cycle = ids.filter((id) => !order.includes(id));
  return { order, cycle };
}

/* ---------- the board's stacking grammar ---------- */

export interface BoardColumn {
  frameId: ID;
  dayKey: IsoDate;
  /** The cards in the column, top of the board first. */
  members: ID[];
}

/** The columns a day frame's arrangement makes.
 *
 *  Within a day frame, a card sits *below* another one because it happens
 *  after it — unless it sits *beside* it, which means the two run in parallel.
 *  Two cards are in the same column when their horizontal extents overlap; a
 *  column is then read top to bottom as the order of that part of the day.
 *
 *  That is the whole spatial grammar of the board, and it has two readers: the
 *  resolver, which turns it into edges, and the time layer, which draws the
 *  gap between each pair. They share this function so they can never disagree
 *  about what is stacked under what.
 *
 *  A card inside two nested day frames appears in a column for each of them;
 *  the resolver picks the smallest frame when it comes to deciding the date. */
export function boardColumns(trip: Trip, segments: Segment[]): BoardColumn[] {
  const out: BoardColumn[] = [];
  for (const frame of trip.frames ?? []) {
    if (!frame.dayKey) continue;
    const inFrame = segments
      .filter((s) => s.at && contains(frame.rect, s.at))
      .sort((a, b) => a.at!.y - b.at!.y || a.at!.x - b.at!.x);

    const columns: { min: number; max: number; members: ID[] }[] = [];
    for (const seg of inFrame) {
      const min = seg.at!.x;
      const max = seg.at!.x + CARD_WIDTH;
      const column = columns.find((c) => min < c.max && c.min < max);
      if (column) {
        column.members.push(seg.id);
        column.min = Math.min(column.min, min);
        column.max = Math.max(column.max, max);
      } else {
        columns.push({ min, max, members: [seg.id] });
      }
    }
    for (const c of columns) out.push({ frameId: frame.id, dayKey: frame.dayKey, members: c.members });
  }
  return out;
}

/* ---------- costs ---------- */

export function linkCost(
  link: Link, from: Segment, to: Segment, places: Map<ID, Place>, o: ResolveOptions,
): { minutes: number; note?: string } {
  const extra = link.bufferMin ?? 0;
  if (link.kind !== 'travel') return { minutes: extra };

  const a = places.get(from.toPlaceId ?? from.placeId ?? '');
  const b = places.get(to.fromPlaceId ?? to.placeId ?? '');
  if (!a || !b || a.id === b.id) return { minutes: o.unknownTravelMin + extra };

  const mode = link.mode ?? 'taxi';
  const est = estimateTravel({ from: a, to: b, mode, departAt: from.end });
  const minutes = travelMinutes(est) + overheadMinutes(mode, a.kind, b.kind) + o.bufferMin + extra;
  return { minutes, note: `${a.name} → ${b.name}` };
}

/* ---------- the pass ---------- */

export function resolveBoard(
  trip: Trip, options: Partial<ResolveOptions> = {},
): Resolution {
  const o = { ...DEFAULT_RESOLVE, ...options };
  const places = byId(trip.places);
  const segments = trip.segments.filter((s) => s.status !== 'cancelled');
  const byIdSeg = byId(segments);
  const live = new Set(segments.map((s) => s.id));
  const graph = buildGraph(trip.links ?? [], live);

  // Which frame, if any, each card is sitting in. A card inside two nested
  // frames belongs to the smallest, which is what "inside" means visually.
  const frameOf = new Map<ID, (typeof trip.frames)[number]>();
  for (const s of segments) {
    if (!s.at) continue;
    const holding = (trip.frames ?? [])
      .filter((f) => f.dayKey && contains(f.rect, s.at!))
      .sort((a, b) => area(a.rect) - area(b.rect))[0];
    if (holding) frameOf.set(s.id, holding);
  }

  /** A card is scheduled by this pass only if it opted in. */
  const scheduled = new Set<ID>(
    segments
      .filter((s) => !s.pinned && (frameOf.has(s.id) || (graph.incoming.get(s.id) ?? []).length > 0))
      .map((s) => s.id),
  );

  // Board order: day frame first, then height on the board, then the time the
  // card already had. Top of a frame is the start of that day.
  const rankOf = new Map<ID, number>();
  segments.forEach((s) => {
    const frame = frameOf.get(s.id);
    const day = frame ? dateKeyToEpoch(frame.dayKey!, trip.baseTimezone) : s.start;
    rankOf.set(s.id, day + (s.at ? s.at.y : 0) * 1000 + (s.at ? s.at.x : 0));
  });

  /* The stacking grammar, turned into real edges rather than left as a special
     case in the walk. `boardColumns` is shared with the time layer, so what
     the board *says* about a stack and what this pass *reads* from it cannot
     drift apart. */
  const implicit: Link[] = [];
  const columnsByFrame: ID[][] = [];
  for (const column of boardColumns(trip, segments)) {
    for (let i = 1; i < column.members.length; i++) {
      implicit.push({
        id: `col:${column.members[i - 1]}:${column.members[i]}`,
        fromId: column.members[i - 1], toId: column.members[i], kind: 'then',
      });
    }
    if (column.members.length > 1) columnsByFrame.push(column.members);
  }

  const ids = segments.map((s) => s.id);
  const withImplicit = buildGraph([...(trip.links ?? []), ...implicit], live);
  let { order, cycle } = topoOrder(ids, withImplicit, (id) => rankOf.get(id) ?? 0);
  let effective = withImplicit;

  // A loop that only exists because of the stacking rule is not the planner's
  // mistake — a connector pointing back up a column is a legitimate thing to
  // draw. Explicit connectors win, and the stacking gives way.
  if (cycle.length) {
    const explicitOnly = topoOrder(ids, graph, (id) => rankOf.get(id) ?? 0);
    order = explicitOnly.order;
    cycle = explicitOnly.cycle;
    effective = graph;
  }

  const issues: Issue[] = [];
  if (cycle.length) {
    issues.push({
      id: `cycle:${cycle.slice(0, 3).join(':')}`, code: 'link-cycle', severity: 'error',
      title: 'These cards point in a circle',
      detail:
        `${cycle.map((id) => `“${byIdSeg.get(id)?.title ?? id}”`).slice(0, 4).join(', ')}` +
        `${cycle.length > 4 ? ` and ${cycle.length - 4} more` : ''} form a loop, so there is no order ` +
        'that satisfies all of them. Delete one of the connectors.',
      segmentIds: cycle.slice(0, 6), personIds: [],
    });
  }

  const start = new Map<ID, Epoch>(segments.map((s) => [s.id, s.start]));
  const end = new Map<ID, Epoch>(segments.map((s) => [s.id, s.end]));
  const duration = (id: ID) => Math.max(5 * MIN, byIdSeg.get(id)!.end - byIdSeg.get(id)!.start);
  const set = (id: ID, at: Epoch) => { start.set(id, at); end.set(id, at + duration(id)); };

  /* --- 1. Re-sequencing.
     A column whose vertical order disagrees with its chronological order is a
     planner saying "these two swap". Rather than invent new times, the times
     already in that column are dealt back out in the order the cards now sit —
     so dragging a card above another swaps them and changes nothing else. */
  for (const column of columnsByFrame) {
    const movable = column.filter((id) => scheduled.has(id));
    if (movable.length < 2) continue;
    // Two cards at nearly the same height are not making a claim about order,
    // so their existing times decide it. Only a deliberate separation counts.
    const ordered = [...movable].sort((a, b) => {
      const ay = byIdSeg.get(a)!.at!.y;
      const by = byIdSeg.get(b)!.at!.y;
      return Math.abs(ay - by) < NEAR_TIE ? start.get(a)! - start.get(b)! : ay - by;
    });
    const times = movable.map((id) => start.get(id)!).sort((a, b) => a - b);
    if (ordered.every((id, i) => start.get(id) === times[i])) continue;
    ordered.forEach((id, i) => set(id, times[i]));
  }

  /* --- 2. The day a frame says.
     Keep the time of day and move the date, so dragging a card from Tuesday's
     frame to Thursday's keeps its 14:00 rather than resetting it.
     A frame's day is always read in the trip's own zone — the board is one
     shared artefact, and it must not re-bucket itself when somebody switches
     the UI to another traveller's clock. An overnight flight out of London is
     on the day the *trip* thinks it is, not the day London does. */
  const boardZone = trip.baseTimezone;
  for (const seg of segments) {
    if (!scheduled.has(seg.id)) continue;
    const frame = frameOf.get(seg.id);
    if (!frame) continue;
    const now = start.get(seg.id)!;
    const days = Math.round(
      (dateKeyToEpoch(frame.dayKey!, boardZone) - dateKeyToEpoch(dateKey(now, boardZone), boardZone)) / DAY,
    );
    if (days !== 0) set(seg.id, addDays(now, days, boardZone));
  }

  /* --- 3. Push forward.
     Everything else is a lower bound. A card that already starts late enough
     is left exactly where it is; one that does not is pushed, never pulled. */
  for (const id of order) {
    const seg = byIdSeg.get(id);
    if (!seg || !scheduled.has(id)) continue;

    let earliest = -Infinity;
    for (const link of effective.incoming.get(id) ?? []) {
      const from = byIdSeg.get(link.fromId);
      if (!from) continue;
      const cost = link.id.startsWith('col:')
        ? { minutes: o.turnaroundMin }
        : linkCost(link, { ...from, end: end.get(from.id)! }, seg, places, o);
      earliest = Math.max(earliest, end.get(from.id)! + cost.minutes * MIN);
    }
    if (earliest > start.get(id)!) set(id, earliest);
  }

  // A pin that its own inputs contradict is worth saying out loud: the pin
  // wins, so the plan silently stops adding up unless somebody is told.
  for (const seg of segments) {
    if (!seg.pinned) continue;
    for (const link of graph.incoming.get(seg.id) ?? []) {
      const from = byIdSeg.get(link.fromId);
      if (!from) continue;
      const earliest = end.get(from.id)! + linkCost(link, from, seg, places, o).minutes * MIN;
      if (seg.start >= earliest) continue;
      issues.push({
        id: `back:${link.id}`, code: 'link-backwards', severity: 'error',
        title: `“${seg.title}” is pinned earlier than it can happen`,
        detail:
          `It is wired to come after “${from.title}”, which does not finish until ` +
          `${fmtDate(end.get(from.id)!, seg.timezone, 'medium')} ${fmtTime(end.get(from.id)!, { zone: seg.timezone })}` +
          `${link.kind === 'travel' ? ', journey included' : ''} — but the pin holds it at ` +
          `${fmtTime(seg.start, { zone: seg.timezone })}. Unpin it, or move it later.`,
        segmentIds: [seg.id, from.id], personIds: attendeesOf(seg, trip),
      });
    }
  }

  const moves: ResolvedMove[] = [];
  for (const id of scheduled) {
    const seg = byIdSeg.get(id);
    if (!seg) continue;
    const to = start.get(id)!;
    if (Math.abs(to - seg.start) >= MIN) moves.push({ id, from: seg.start, to });
  }

  return { moves, issues, considered: scheduled.size };
}

/** A dry description of what resolving would do, for the button's tooltip and
 *  for the toast afterwards. */
export function describeResolution(r: Resolution, trip: Trip, zone: string): string {
  if (!r.considered) {
    return 'Nothing on the board is framed or wired up yet, so there is nothing to schedule.';
  }
  if (!r.moves.length) return 'Everything already sits where the board says it should.';
  const first = trip.segments.find((s) => s.id === r.moves[0].id);
  const rest = r.moves.length - 1;
  return `Moved “${first?.title ?? 'a card'}” to ${fmtDate(r.moves[0].to, zone, 'medium')} ` +
    `${fmtTime(r.moves[0].to, { zone })}${rest > 0 ? ` and ${rest} other${rest === 1 ? '' : 's'}` : ''}.`;
}

/* ---------- geometry helpers shared with the board ---------- */

export function contains(rect: { x: number; y: number; w: number; h: number }, p: { x: number; y: number }): boolean {
  return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
}

export function area(rect: { w: number; h: number }): number {
  return Math.max(1, rect.w * rect.h);
}

/** The day a card would be scheduled on, given the frames it sits in. */
export function frameDayFor(trip: Trip, seg: Segment): string | undefined {
  if (!seg.at) return undefined;
  return (trip.frames ?? [])
    .filter((f) => f.dayKey && contains(f.rect, seg.at!))
    .sort((a, b) => area(a.rect) - area(b.rect))[0]?.dayKey;
}

/** The branch a card would belong to, from the frame it sits in. */
export function frameBranchFor(trip: Trip, at: { x: number; y: number } | undefined): ID | undefined {
  if (!at) return undefined;
  return (trip.frames ?? [])
    .filter((f) => f.branchId && contains(f.rect, at))
    .sort((a, b) => area(a.rect) - area(b.rect))[0]?.branchId;
}

export { dateKey };

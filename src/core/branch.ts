/** Sub-trips.
 *
 *  A branch is a stretch of plan that only some of the party does: four people
 *  go to the beach while the rest stay for the second day of talks. It is not
 *  a separate trip — the people in it are still in the trip, still counted by
 *  the analyser, still on the shared timeline before and after.
 *
 *  Everything here is derived. A branch stores who is in it and nothing about
 *  when: the "when" is wherever its segments happen to be, so dragging a
 *  segment moves the branch with it and there is no second source of truth to
 *  fall out of step. */

import type { Branch, Epoch, ID, Segment, Trip } from './types';
import { attendeesOf } from './schedule';

export interface BranchSpan {
  branch: Branch;
  segments: Segment[];
  /** Undefined when the branch has no segments yet — a freshly created one. */
  start?: Epoch;
  end?: Epoch;
  /** The shared item the members were all at immediately before splitting. */
  splitFrom?: Segment;
  /** The shared item they are all next at, once they are back together. */
  rejoinAt?: Segment;
  /** Nesting depth: 0 forks off the main timeline. */
  depth: number;
}

export function branchById(trip: Trip, id: ID | undefined): Branch | undefined {
  return id ? trip.branches.find((b) => b.id === id) : undefined;
}

/** Segments on the shared timeline — everything not inside any branch. */
export function mainSegments(trip: Trip): Segment[] {
  return trip.segments.filter((s) => !s.branchId);
}

export function segmentsInBranch(trip: Trip, branchId: ID, includeNested = false): Segment[] {
  const ids = includeNested ? new Set([branchId, ...descendantIds(trip, branchId)]) : new Set([branchId]);
  return trip.segments
    .filter((s) => s.branchId && ids.has(s.branchId))
    .sort((a, b) => a.start - b.start);
}

export function childBranches(trip: Trip, parentId: ID | undefined): Branch[] {
  return trip.branches.filter((b) => (b.parentId ?? undefined) === parentId);
}

export function descendantIds(trip: Trip, branchId: ID): ID[] {
  const out: ID[] = [];
  const walk = (id: ID) => {
    for (const child of childBranches(trip, id)) { out.push(child.id); walk(child.id); }
  };
  walk(branchId);
  return out;
}

export function branchDepth(trip: Trip, branchId: ID | undefined): number {
  let depth = 0;
  let cursor = branchById(trip, branchId);
  // The guard is against a cycle introduced by a hand-edited import, not by
  // anything the UI can produce.
  const seen = new Set<ID>();
  while (cursor?.parentId && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    depth += 1;
    cursor = branchById(trip, cursor.parentId);
  }
  return depth;
}

/** Everyone the branch actually involves: its declared members, plus anyone
 *  attending one of its segments. Declared membership is the intent; the
 *  attendee lists are the fact, and both matter. */
export function branchMembers(trip: Trip, branch: Branch): ID[] {
  const set = new Set(branch.memberIds);
  for (const s of segmentsInBranch(trip, branch.id, true)) {
    for (const a of attendeesOf(s, trip)) set.add(a);
  }
  return [...set];
}

export function spanOf(trip: Trip, branch: Branch): BranchSpan {
  const segments = segmentsInBranch(trip, branch.id, true);
  const members = branchMembers(trip, branch);
  const start = segments.length ? Math.min(...segments.map((s) => s.start)) : undefined;
  const end = segments.length ? Math.max(...segments.map((s) => s.end)) : undefined;

  // The shared segment they were all last at, and the one they are all next
  // at. "All" is deliberate: a rejoin that half the branch misses is not a
  // rejoin, and the analyser has something to complain about.
  const shared = trip.segments
    .filter((s) => !s.branchId && s.status !== 'cancelled')
    .sort((a, b) => a.start - b.start);
  const attendedByAll = (s: Segment) => {
    const att = attendeesOf(s, trip);
    return members.length > 0 && members.every((m) => att.includes(m));
  };

  const splitFrom = start === undefined
    ? undefined
    : [...shared].reverse().find((s) => s.end <= start && attendedByAll(s));
  const rejoinAt = end === undefined
    ? undefined
    : shared.find((s) => s.start >= end && attendedByAll(s));

  return { branch, segments, start, end, splitFrom, rejoinAt, depth: branchDepth(trip, branch.id) };
}

export function allSpans(trip: Trip): BranchSpan[] {
  return trip.branches
    .map((b) => spanOf(trip, b))
    .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.depth - b.depth);
}

/** Branches with at least one segment overlapping the window — what the canvas
 *  needs in order to decide how many tracks a day column has. */
export function branchesInWindow(trip: Trip, from: Epoch, to: Epoch): Branch[] {
  return trip.branches.filter((b) =>
    segmentsInBranch(trip, b.id, false).some((s) => s.start < to && from < s.end));
}

/** Which branch a person is in at an instant, if any. Used to answer "where is
 *  everyone right now" without walking the whole tree at every render. */
export function branchOfPersonAt(trip: Trip, personId: ID, at: Epoch): Branch | undefined {
  const seg = trip.segments.find(
    (s) => s.branchId && s.start <= at && at < s.end && attendeesOf(s, trip).includes(personId),
  );
  return branchById(trip, seg?.branchId);
}

/** Members of the trip who are *not* in this branch — the other half of the
 *  split, which the canvas draws continuing along the main line. */
export function stayingBehind(trip: Trip, branch: Branch): ID[] {
  const inBranch = new Set(branchMembers(trip, branch));
  return trip.people.map((p) => p.id).filter((id) => !inBranch.has(id));
}

/** A colour that is distinct from the branches already in the trip. */
export function nextBranchColor(trip: Trip): string {
  const PALETTE = ['#8b7cff', '#14d4c4', '#ffb020', '#ff6b9d', '#5ac8fa', '#a3e635', '#ff8a4c', '#c084fc'];
  const used = new Set(trip.branches.map((b) => b.color));
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[trip.branches.length % PALETTE.length];
}

/** Summary line for a branch card: "4 people · 22–23 Sep · 6 stops". */
export function branchStats(trip: Trip, branch: Branch): { members: number; segments: number; hours: number } {
  const segs = segmentsInBranch(trip, branch.id, true);
  const hours = segs.reduce((a, s) => a + (s.end - s.start), 0) / 3_600_000;
  return { members: branchMembers(trip, branch).length, segments: segs.length, hours: Math.round(hours * 10) / 10 };
}

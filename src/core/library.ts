/** The trip library: many trips in one browser.
 *
 *  Storage is one key per trip plus a small index, rather than a single blob.
 *  That keeps a large trip from being rewritten every time an unrelated one is
 *  touched, and means a corrupt trip loses one trip rather than all of them.
 *
 *  Everything is best-effort: private mode, a full quota and a hand-edited
 *  localStorage all have to degrade to "you still have an app", never to a
 *  blank screen. */

import type { Branch, ID, IsoDate, Trip, Zone } from './types';
import { DAY, canonicalZone, dateKey, dateKeyToEpoch } from './time';
import { uid } from './store';

const INDEX = 'planit.library.v2';
const TRIP = (id: ID) => `planit.trip.v2.${id}`;
const LEGACY = 'planit.trip.v1';

export interface TripMeta {
  id: ID;
  name: string;
  subtitle?: string;
  startDate: IsoDate;
  endDate: IsoDate;
  baseTimezone: Zone;
  updatedAt: number;
  /** Denormalised so the library page never has to parse every trip. */
  peopleCount: number;
  segmentCount: number;
  branchCount: number;
  /** Up to six member colours, for the stacked avatars on the card. */
  swatches: string[];
}

interface Index {
  version: 2;
  trips: TripMeta[];
  activeId?: ID;
}

function readIndex(): Index {
  try {
    const raw = localStorage.getItem(INDEX);
    if (raw) {
      const parsed = JSON.parse(raw) as Index;
      if (parsed?.version === 2 && Array.isArray(parsed.trips)) return parsed;
    }
  } catch { /* fall through to a fresh index */ }
  return { version: 2, trips: [] };
}

function writeIndex(ix: Index) {
  try { localStorage.setItem(INDEX, JSON.stringify(ix)); } catch { /* quota */ }
}

export function metaOf(trip: Trip): TripMeta {
  return {
    id: trip.id,
    name: trip.name,
    subtitle: trip.subtitle,
    startDate: trip.startDate,
    endDate: trip.endDate,
    baseTimezone: trip.baseTimezone,
    updatedAt: trip.updatedAt,
    peopleCount: trip.people.length,
    segmentCount: trip.segments.length,
    branchCount: trip.branches?.length ?? 0,
    swatches: trip.people.slice(0, 6).map((p) => p.color),
  };
}

/** Newest first — the library page shows them in this order. */
export function listTrips(): TripMeta[] {
  return [...readIndex().trips].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readTrip(id: ID): Trip | null {
  try {
    const raw = localStorage.getItem(TRIP(id));
    if (!raw) return null;
    return migrate(JSON.parse(raw) as Trip);
  } catch { return null; }
}

export function writeTrip(trip: Trip) {
  try { localStorage.setItem(TRIP(trip.id), JSON.stringify(trip)); } catch { /* quota */ }
  const ix = readIndex();
  const meta = metaOf(trip);
  const at = ix.trips.findIndex((t) => t.id === trip.id);
  if (at === -1) ix.trips.push(meta); else ix.trips[at] = meta;
  writeIndex(ix);
}

export function deleteTrip(id: ID) {
  try { localStorage.removeItem(TRIP(id)); } catch { /* ignore */ }
  const ix = readIndex();
  ix.trips = ix.trips.filter((t) => t.id !== id);
  if (ix.activeId === id) delete ix.activeId;
  writeIndex(ix);
}

export function setActiveTrip(id: ID | null) {
  const ix = readIndex();
  if (id) ix.activeId = id; else delete ix.activeId;
  writeIndex(ix);
}

export function activeTripId(): ID | null {
  return readIndex().activeId ?? null;
}

/** Deep copy under a new identity, so the copy shares nothing with the source. */
export function duplicateTrip(id: ID): Trip | null {
  const src = readTrip(id);
  if (!src) return null;
  const copy = reidentify({ ...src, name: `${src.name} (copy)` });
  writeTrip(copy);
  return copy;
}

/** Rewrite every id in a trip. Used by duplicate and by import, so two trips
 *  from the same ancestor can live side by side without colliding. */
export function reidentify(trip: Trip): Trip {
  const map = new Map<ID, ID>();
  const swap = (old: ID | undefined, prefix: string): ID | undefined => {
    if (!old) return undefined;
    if (!map.has(old)) map.set(old, uid(prefix));
    return map.get(old);
  };
  const people = trip.people.map((p) => ({ ...p, id: swap(p.id, 'per')! }));
  const places = trip.places.map((p) => ({ ...p, id: swap(p.id, 'plc')! }));
  const branches = (trip.branches ?? []).map((b) => ({ ...b, id: swap(b.id, 'br')! }));
  const groups = trip.groups.map((g) => ({ ...g, id: swap(g.id, 'grp')! }));

  const re = (ids: ID[]) => ids.map((i) => map.get(i) ?? i);
  return {
    ...trip,
    id: uid('trip'),
    people,
    places,
    groups: groups.map((g) => ({ ...g, memberIds: re(g.memberIds), placeId: g.placeId && map.get(g.placeId) })),
    branches: branches.map((b) => ({ ...b, memberIds: re(b.memberIds), parentId: b.parentId && map.get(b.parentId) })),
    segments: trip.segments.map((s) => ({
      ...s,
      id: uid('seg'),
      attendeeIds: re(s.attendeeIds),
      groupIds: re(s.groupIds),
      placeId: s.placeId && map.get(s.placeId),
      fromPlaceId: s.fromPlaceId && map.get(s.fromPlaceId),
      toPlaceId: s.toPlaceId && map.get(s.toPlaceId),
      branchId: s.branchId && map.get(s.branchId),
      ownerId: s.ownerId && map.get(s.ownerId),
    })),
    ideas: trip.ideas.map((i) => ({
      ...i, id: uid('idea'), attendeeIds: re(i.attendeeIds), votes: re(i.votes),
      placeId: i.placeId && map.get(i.placeId),
    })),
    updatedAt: Date.now(),
    createdAt: Date.now(),
  };
}

/** Bring a trip written by an older build up to the current shape. Missing
 *  fields are the norm here, not an error — a share link may be months old. */
export function migrate(trip: Trip): Trip {
  const z = canonicalZone;
  return {
    ...trip,
    id: trip.id || uid('trip'),
    baseTimezone: z(trip.baseTimezone ?? 'UTC'),
    branches: Array.isArray(trip.branches) ? trip.branches : [],
    // Zones written by an older build may carry a pre-1993 alias picked up
    // from the device; they behave identically but read like a bug.
    places: (trip.places ?? []).map((p) => ({ ...p, timezone: z(p.timezone) })),
    people: (trip.people ?? []).map((p) => ({ ...p, homeTimezone: z(p.homeTimezone) })),
    groups: trip.groups ?? [],
    segments: (trip.segments ?? []).map((s) => ({ ...s, timezone: z(s.timezone) })),
    ideas: trip.ideas ?? [],
    createdAt: trip.createdAt ?? trip.updatedAt ?? Date.now(),
    schemaVersion: 1,
  };
}

export interface NewTripInput {
  name: string;
  subtitle?: string;
  startDate: IsoDate;
  endDate: IsoDate;
  baseTimezone: Zone;
  currency?: string;
}

export function blankTrip(input: NewTripInput): Trip {
  return {
    id: uid('trip'),
    name: input.name.trim() || 'Untitled trip',
    subtitle: input.subtitle?.trim() || undefined,
    startDate: input.startDate,
    endDate: input.endDate,
    baseTimezone: input.baseTimezone,
    currency: input.currency ?? 'INR',
    places: [], people: [], groups: [], segments: [], branches: [], ideas: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    schemaVersion: 1,
  };
}

export function defaultDates(zone: Zone): { startDate: IsoDate; endDate: IsoDate } {
  const now = Date.now();
  return { startDate: dateKey(now + 7 * DAY, zone), endDate: dateKey(now + 10 * DAY, zone) };
}

/** Day count, inclusive of both ends. */
export function tripLengthDays(meta: Pick<TripMeta, 'startDate' | 'endDate' | 'baseTimezone'>): number {
  const a = dateKeyToEpoch(meta.startDate, meta.baseTimezone);
  const b = dateKeyToEpoch(meta.endDate, meta.baseTimezone);
  return Math.max(1, Math.round((b - a) / DAY) + 1);
}

/** Run once at boot: adopt a trip saved by the single-trip build. */
export function importLegacyTrip(): Trip | null {
  try {
    const raw = localStorage.getItem(LEGACY);
    if (!raw) return null;
    const trip = migrate(JSON.parse(raw) as Trip);
    if (!Array.isArray(trip.segments)) return null;
    if (readIndex().trips.some((t) => t.id === trip.id)) return null;
    writeTrip(trip);
    localStorage.removeItem(LEGACY);
    return trip;
  } catch { return null; }
}

export function makeBranch(name: string, memberIds: ID[], color: string, parentId?: ID): Branch {
  return { id: uid('br'), name: name.trim() || 'Side trip', color, memberIds, parentId };
}

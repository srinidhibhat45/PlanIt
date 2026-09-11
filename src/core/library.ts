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
/** Every key a trip has ever been stored under starts with this, whatever the
 *  version that follows. The scan below leans on that, so a future version
 *  bump orphans nothing. */
const TRIP_PREFIX = 'planit.trip.';
const TRIP = (id: ID) => `${TRIP_PREFIX}v2.${id}`;
const LEGACY = 'planit.trip.v1';

/** What happened when we tried to save. Callers surface anything but `ok`:
 *  a save that silently failed is how somebody loses an afternoon's planning
 *  and only finds out when they reload. */
export type SaveResult = 'ok' | 'quota' | 'unavailable';

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

/** The index is a *cache*, not the record. The trips themselves are the record.
 *
 *  This matters most on a hosted site, where an update lands under people's
 *  feet: if a new build could not read the index — a version it does not know,
 *  a half-written value, anything — the old code would quietly start from an
 *  empty one and the next save would write that emptiness over the top, while
 *  every trip sat there in storage with nothing pointing at it. So the index is
 *  never trusted over the trip keys: whatever is missing from it is read back
 *  off them and put back. */
function readIndex(): Index {
  let stored: Index | null = null;
  try {
    const raw = localStorage.getItem(INDEX);
    if (raw) {
      const parsed = JSON.parse(raw) as Index;
      if (parsed?.version === 2 && Array.isArray(parsed.trips)) stored = parsed;
    }
  } catch { /* a corrupt index is a missing index — the trips are still there */ }
  return adoptOrphans(stored);
}

/** Fold any trip in storage that the index has lost back into it.
 *
 *  Keys are enumerated by name first and only parsed when the name is one the
 *  index does not already know, so the usual case — nothing lost — costs a
 *  handful of string comparisons on every save, not a parse of every trip. */
function adoptOrphans(stored: Index | null): Index {
  const ix: Index = stored ?? { version: 2, trips: [] };
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(TRIP_PREFIX)) keys.push(k);
    }
  } catch {
    return ix;                       // storage is unavailable; nothing to heal
  }

  const known = new Set(ix.trips.map((t) => t.id));
  // `planit.trip.v2.<id>` — ids never contain a dot, so the tail is the id.
  // A key whose tail is not an id (the single-trip build's `planit.trip.v1`)
  // simply never matches, and is read properly below.
  const suspects = keys.filter((k) => !known.has(k.slice(k.lastIndexOf('.') + 1)));
  if (!suspects.length) return ix;

  let found = 0;
  for (const key of suspects) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const trip = migrate(JSON.parse(raw) as Trip);
      if (!trip.id || !Array.isArray(trip.segments)) continue;
      const canonical = TRIP(trip.id);

      if (known.has(trip.id)) {
        // Already listed — this is a stale copy under an older key. Drop it,
        // but only once the current one is confirmed present, and never the
        // canonical key itself.
        if (key !== canonical && localStorage.getItem(canonical)) {
          try { localStorage.removeItem(key); } catch { /* ignore */ }
        }
        continue;
      }

      known.add(trip.id);
      ix.trips.push(metaOf(trip));
      found++;
      // Re-home a trip found under an older key, so the next build finds it
      // under the name it expects without another rescue. The old key only
      // goes once the new one is definitely written.
      if (key !== canonical) {
        try {
          localStorage.setItem(canonical, JSON.stringify(trip));
          localStorage.removeItem(key);
        } catch { /* quota — the trip stays where it is, and is found again */ }
      }
    } catch { /* one unreadable trip must not cost the others */ }
  }

  if (found || !stored) writeIndex(ix);
  return ix;
}

function writeIndex(ix: Index): SaveResult {
  try {
    localStorage.setItem(INDEX, JSON.stringify(ix));
    return 'ok';
  } catch (e) { return reasonFor(e); }
}

function reasonFor(e: unknown): SaveResult {
  const name = (e as { name?: string } | null)?.name ?? '';
  return /quota|storage/i.test(name) ? 'quota' : 'unavailable';
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

export function writeTrip(trip: Trip): SaveResult {
  let result: SaveResult = 'ok';
  try {
    localStorage.setItem(TRIP(trip.id), JSON.stringify(trip));
  } catch (e) {
    result = reasonFor(e);
  }
  const ix = readIndex();
  const meta = metaOf(trip);
  const at = ix.trips.findIndex((t) => t.id === trip.id);
  if (at === -1) ix.trips.push(meta); else ix.trips[at] = meta;
  const indexResult = writeIndex(ix);
  return result === 'ok' ? indexResult : result;
}

/** Can this browser store anything at all? Private windows, blocked site data
 *  and a full disk all land here, and all of them mean "nothing you do in this
 *  tab will survive a reload" — which the app has to say out loud. */
export function storageWorks(): boolean {
  try {
    const probe = 'planit.probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch { return false; }
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
  // Segments need their mapping up front, because links point at them.
  const segMap = new Map<ID, ID>(trip.segments.map((s) => [s.id, uid('seg')]));
  return {
    ...trip,
    id: uid('trip'),
    people,
    places,
    groups: groups.map((g) => ({ ...g, memberIds: re(g.memberIds), placeId: g.placeId && map.get(g.placeId) })),
    branches: branches.map((b) => ({ ...b, memberIds: re(b.memberIds), parentId: b.parentId && map.get(b.parentId) })),
    segments: trip.segments.map((s) => ({
      ...s,
      id: segMap.get(s.id)!,
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
    links: (trip.links ?? []).map((l) => ({
      ...l, id: uid('lnk'), fromId: segMap.get(l.fromId) ?? l.fromId, toId: segMap.get(l.toId) ?? l.toId,
    })),
    stickies: (trip.stickies ?? []).map((n) => ({
      ...n, id: uid('sty'), authorId: n.authorId && map.get(n.authorId),
    })),
    frames: (trip.frames ?? []).map((f) => ({
      ...f, id: uid('frm'), branchId: f.branchId && map.get(f.branchId),
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
    links: trip.links ?? [],
    stickies: trip.stickies ?? [],
    frames: trip.frames ?? [],
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
    places: [], people: [], groups: [], segments: [], branches: [],
    links: [], stickies: [], frames: [], ideas: [],
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

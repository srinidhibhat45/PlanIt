/** A compact wire format for share links.
 *
 *  The plain JSON of a nine-day, eight-person trip is about 46 kB, which
 *  survives LZ compression as a ~15 000-character URL — long enough that chat
 *  clients start mangling it. Three cheap transforms fix that:
 *
 *   1. Identifiers become array indices, so a 12-character id repeated across
 *      half a dozen attendee lists costs one digit.
 *   2. Instants become minutes from the trip epoch, turning 13-digit numbers
 *      into 4-digit ones, and an end time becomes a duration.
 *   3. Field names shorten, repeated strings (zones, tags) are interned into
 *      lookup tables, and anything empty, false or defaulted is dropped.
 *
 *  Everything is reversible; `unpack(pack(trip))` is asserted to be
 *  structurally identical to the original in the test suite. */

import type { Group, ID, Idea, Person, Place, Segment, SegmentKind, SegmentStatus, Trip } from './types';
import { MIN } from './time';

const KINDS: SegmentKind[] = [
  'flight', 'transfer', 'checkin', 'checkout', 'session', 'workshop',
  'meal', 'activity', 'free', 'rest', 'buffer', 'note',
];
const STATUSES: SegmentStatus[] = ['confirmed', 'tentative', 'cancelled'];
const PLACE_KINDS: Place['kind'][] = [
  'airport', 'hotel', 'venue', 'restaurant', 'bar', 'temple', 'landmark', 'transit', 'office', 'other',
];
const GROUP_KINDS: Group['kind'][] = ['track', 'hotel', 'affinity', 'custom'];

export interface Packed { [k: string]: unknown; v: 2 }

/** Drop keys whose value carries no information. */
function tidy<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === undefined || v === null || v === '' || v === false) delete o[k];
    else if (Array.isArray(v) && v.length === 0) delete o[k];
  }
  return o;
}

const ord = (prefix: string, i: number) => `${prefix}${i.toString(36)}`;

/** Index of a value in a table, appending it on first sight. */
function intern(table: string[], value: string): number {
  const i = table.indexOf(value);
  return i === -1 ? table.push(value) - 1 : i;
}

/** Undefined when the id is missing, so `tidy` can drop the field. */
const refOf = (map: Map<ID, number>, id?: ID): number | undefined =>
  id === undefined ? undefined : map.get(id);

export function pack(trip: Trip): Packed {
  const placeKey = new Map<ID, number>(trip.places.map((p, i) => [p.id, i]));
  const personKey = new Map<ID, number>(trip.people.map((p, i) => [p.id, i]));
  const groupKey = new Map<ID, number>(trip.groups.map((g, i) => [g.id, i]));

  // Intern the strings that repeat: a dozen segments in 'Asia/Kolkata' should
  // say so once, and 'conference' appears on every session.
  const zones: string[] = [];
  const tags: string[] = [];
  const zoneIdx = (z: string) => intern(zones, z);
  const tagIdx = (t: string[]) => t.map((x) => intern(tags, x));

  const t0 = trip.segments.length
    ? Math.floor(Math.min(...trip.segments.map((s) => s.start)) / MIN) * MIN
    : Date.now();

  const m = (epoch: number) => Math.round((epoch - t0) / MIN);

  return {
    v: 2,
    id: trip.id,
    n: trip.name,
    sb: trip.subtitle,
    sd: trip.startDate,
    ed: trip.endDate,
    tz: trip.baseTimezone,
    cu: trip.currency,
    ua: trip.updatedAt,
    t0,
    Z: zones,                                   // filled by the mappers below
    T: tags,
    A: trip.places.map((p) => tidy({
      n: p.name, k: PLACE_KINDS.indexOf(p.kind), y: round6(p.lat), x: round6(p.lon),
      z: zoneIdx(p.timezone), ad: p.address, c: p.code, u: p.url, no: p.notes, d: p.dwellMin,
    })),
    B: trip.people.map((p) => tidy({
      n: p.name, hc: p.homeCity, z: zoneIdx(p.homeTimezone), c: p.color,
      e: p.email, i: p.interests, di: p.dietary, mo: p.mobilityNotes, ph: p.phone, no: p.notes,
    })),
    C: trip.groups.map((g) => tidy({
      n: g.name, k: GROUP_KINDS.indexOf(g.kind), c: g.color,
      m: g.memberIds.map((x) => personKey.get(x)).filter((x) => x !== undefined),
      p: refOf(placeKey, g.placeId), d: g.description,
    })),
    D: trip.segments.map((s) => tidy({
      t: s.title,
      k: KINDS.indexOf(s.kind),
      s: m(s.start),
      d: Math.round((s.end - s.start) / MIN),
      z: zoneIdx(s.timezone),
      p: refOf(placeKey, s.placeId),
      f: refOf(placeKey, s.fromPlaceId),
      o: refOf(placeKey, s.toPlaceId),
      a: s.attendeeIds.map((x) => personKey.get(x)).filter((x) => x !== undefined),
      E: s.everyone || undefined,
      g: s.groupIds.map((x) => groupKey.get(x)).filter((x) => x !== undefined),
      // 'confirmed' is index 0 and by far the common case, so it is implied.
      st: STATUSES.indexOf(s.status) || undefined,
      tv: packTravel(s.travel),
      fl: packFlight(s.flight),
      no: s.notes,
      u: s.url,
      tg: tagIdx(s.tags),
      co: s.cost,
      cu: s.currency,
      L: s.locked || undefined,
      cl: s.color,
    })),
    E: trip.ideas.map((i) => tidy({
      t: i.title, k: KINDS.indexOf(i.kind), d: i.durationMin,
      p: refOf(placeKey, i.placeId),
      a: i.attendeeIds.map((x) => personKey.get(x)).filter((x) => x !== undefined),
      tg: tagIdx(i.tags), no: i.notes,
      vo: i.votes.map((x) => personKey.get(x)).filter((x) => x !== undefined),
    })),
  };
}

/** A travel block usually carries only a mode; the distances and factors are
 *  recomputed from the places on every render, so shipping zeroes is waste. */
function packTravel(t: Segment['travel']): unknown {
  if (!t) return undefined;
  const bare = t.distanceKm === 0 && t.baseMin === 0 && t.trafficFactor === 1 && t.source === 'estimate';
  return bare ? t.mode : { m: t.mode, d: t.distanceKm, b: t.baseMin, f: t.trafficFactor, s: t.source, g: t.geometry };
}

function unpackTravel(v: unknown): Segment['travel'] {
  if (!v) return undefined;
  if (typeof v === 'string') {
    return { mode: v as NonNullable<Segment['travel']>['mode'], distanceKm: 0, baseMin: 0, trafficFactor: 1, source: 'estimate' };
  }
  const o = v as Record<string, any>;
  return { mode: o.m, distanceKm: o.d ?? 0, baseMin: o.b ?? 0, trafficFactor: o.f ?? 1, source: o.s ?? 'estimate', geometry: o.g };
}

function packFlight(f: Segment['flight']): unknown {
  if (!f) return undefined;
  return tidy({ c: f.carrier, n: f.number, f: f.fromCode, t: f.toCode, tm: f.terminal, s: f.seat, r: f.confirmation });
}

function unpackFlight(v: unknown): Segment['flight'] {
  if (!v) return undefined;
  const o = v as Record<string, any>;
  return { carrier: o.c ?? '', number: o.n ?? '', fromCode: o.f ?? '', toCode: o.t ?? '', terminal: o.tm, seat: o.s, confirmation: o.r };
}

export function unpack(p: Packed): Trip {
  const o = p as Record<string, any>;
  const zones: string[] = o.Z ?? [];
  const tagTable: string[] = o.T ?? [];
  const z = (i: number) => zones[i] ?? 'UTC';
  const tg = (list?: number[]) => (list ?? []).map((i) => tagTable[i]).filter(Boolean);
  const t0: number = o.t0 ?? Date.now();
  const at = (mins: number) => t0 + mins * MIN;

  const placeId = (i: number) => ord('a', i);
  const personId = (i: number) => ord('b', i);
  const groupId = (i: number) => ord('c', i);

  const places: Place[] = (o.A ?? []).map((a: any, i: number) => ({
    id: placeId(i),
    name: a.n ?? 'Place',
    kind: PLACE_KINDS[a.k] ?? 'other',
    lat: a.y ?? 0,
    lon: a.x ?? 0,
    timezone: z(a.z ?? 0),
    address: a.ad,
    code: a.c,
    url: a.u,
    notes: a.no,
    dwellMin: a.d,
  }));

  const people: Person[] = (o.B ?? []).map((b: any, i: number) => ({
    id: personId(i),
    name: b.n ?? 'Traveller',
    homeCity: b.hc ?? '',
    homeTimezone: z(b.z ?? 0),
    color: b.c ?? '#8b94ab',
    groupIds: [],
    interests: b.i ?? [],
    email: b.e,
    dietary: b.di,
    mobilityNotes: b.mo,
    phone: b.ph,
    notes: b.no,
  }));

  const groups: Group[] = (o.C ?? []).map((c: any, i: number) => ({
    id: groupId(i),
    name: c.n ?? 'Group',
    kind: GROUP_KINDS[c.k] ?? 'custom',
    color: c.c ?? '#8b94ab',
    memberIds: (c.m ?? []).map(personId),
    placeId: c.p === undefined ? undefined : placeId(c.p),
    description: c.d,
  }));

  // groupIds on people are derivable, so they are never transmitted.
  for (const g of groups) {
    for (const mId of g.memberIds) {
      const person = people.find((x) => x.id === mId);
      if (person) person.groupIds.push(g.id);
    }
  }

  const segments: Segment[] = (o.D ?? []).map((d: any, i: number) => ({
    id: ord('d', i),
    title: d.t ?? 'Block',
    kind: KINDS[d.k] ?? 'note',
    start: at(d.s ?? 0),
    end: at((d.s ?? 0) + (d.d ?? 60)),
    timezone: z(d.z ?? 0),
    placeId: d.p === undefined ? undefined : placeId(d.p),
    fromPlaceId: d.f === undefined ? undefined : placeId(d.f),
    toPlaceId: d.o === undefined ? undefined : placeId(d.o),
    attendeeIds: (d.a ?? []).map(personId),
    everyone: d.E,
    groupIds: (d.g ?? []).map(groupId),
    status: STATUSES[d.st ?? 0] ?? 'confirmed',
    travel: unpackTravel(d.tv),
    flight: unpackFlight(d.fl),
    notes: d.no,
    url: d.u,
    tags: tg(d.tg),
    cost: d.co,
    currency: d.cu,
    locked: d.L,
    color: d.cl,
  }));

  const ideas: Idea[] = (o.E ?? []).map((e: any, i: number) => ({
    id: ord('e', i),
    title: e.t ?? 'Idea',
    kind: KINDS[e.k] ?? 'activity',
    durationMin: e.d ?? 90,
    placeId: e.p === undefined ? undefined : placeId(e.p),
    attendeeIds: (e.a ?? []).map(personId),
    tags: tg(e.tg),
    notes: e.no,
    votes: (e.vo ?? []).map(personId),
  }));

  return {
    id: o.id ?? 'trip',
    name: o.n ?? 'Trip',
    subtitle: o.sb,
    startDate: o.sd ?? '1970-01-01',
    endDate: o.ed ?? '1970-01-01',
    baseTimezone: o.tz ?? 'UTC',
    currency: o.cu ?? 'USD',
    places, people, groups, segments, ideas,
    updatedAt: o.ua ?? Date.now(),
    schemaVersion: 1,
  };
}

/** Coordinates beyond six decimals describe sub-centimetre precision. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** The id a person will have once the trip has been packed and reopened. */
export function packedIdFor(trip: Trip, id: ID): string | undefined {
  const i = trip.people.findIndex((p) => p.id === id);
  return i === -1 ? undefined : ord('b', i);
}

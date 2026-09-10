/* A small assertion harness — no framework, runs under plain node after an
   esbuild bundle. Covers the parts where a silent error would be worst:
   timezone arithmetic, the traffic model, calendar output and sharing. */

import {
  DAY, HOUR, MIN, addDays, canonicalZone, dateKey, eachDay, fmtDuration, fmtRange, fmtTime,
  fromZoned, offsetMinutes, parseLocal, snap, toParts, zoneAbbr,
} from '../src/core/time';
import { estimateTravel, haversineKm, overheadMinutes, profileFor, trafficFactor, travelMinutes } from '../src/core/travel';
import { buildIcs } from '../src/core/ics';
import { decodeTrip, encodeTrip } from '../src/core/share';
import { compressToEncodedURIComponent } from 'lz-string';
import { analyse, attendeesOf, segmentsFor } from '../src/core/schedule';
import { conferenceTrip } from '../src/data/conference';
import { reducer, initialState } from '../src/core/store';
import { packColumns } from '../src/core/layout';
import { guessZone, isShortMapLink, isValidZone, parseMapLink, searchBuiltin } from '../src/core/geo';
import { branchDepth, branchMembers, childBranches, mainSegments, segmentsInBranch, spanOf } from '../src/core/branch';
import { DEFAULT_CANVAS, buildCanvas, hitColumn, timeAt, yFor } from '../src/core/canvas';
import { makeBranch, migrate, reidentify } from '../src/core/library';
import { dateKeyToEpoch } from '../src/core/time';
import type { Trip } from '../src/core/types';

let pass = 0;
const fails: string[] = [];

function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; } else { fails.push(`${name}${extra ? ` — ${extra}` : ''}`); }
}
function eq<T>(name: string, actual: T, expected: T) {
  ok(name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected),
     `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
}

/* ============ time ============ */

const IST = 'Asia/Kolkata';
const LON = 'Europe/London';
const KTM = 'Asia/Kathmandu';
const TPE = 'Asia/Taipei';

eq('IST offset is +330 in September', offsetMinutes(Date.UTC(2026, 8, 23, 6), IST), 330);
eq('Kathmandu offset is +345', offsetMinutes(Date.UTC(2026, 8, 23, 6), KTM), 345);
eq('London is +60 in September (BST)', offsetMinutes(Date.UTC(2026, 8, 23, 6), LON), 60);
eq('London is +0 in January (GMT)', offsetMinutes(Date.UTC(2026, 0, 23, 6), LON), 0);

// Round-trip every zone through wall-clock and back.
for (const zone of [IST, LON, KTM, TPE, 'America/New_York', 'Pacific/Chatham', 'UTC']) {
  for (const month of [1, 3, 6, 10, 12]) {
    const t = fromZoned(2026, month, 15, 13, 45, 0, zone);
    const p = toParts(t, zone);
    eq(`round trip ${zone} m${month}`,
       [p.year, p.month, p.day, p.hour, p.minute],
       [2026, month, 15, 13, 45]);
  }
}

// DST spring forward: London 2026-03-29 01:00 -> 02:00. 01:30 does not exist.
const springGap = fromZoned(2026, 3, 29, 1, 30, 0, LON);
ok('skipped local time resolves forward, not backward',
   toParts(springGap, LON).hour >= 1,
   `resolved to ${fmtTime(springGap, { zone: LON })}`);

// DST autumn back: London 2026-10-25 02:00 -> 01:00, so 01:30 happens twice.
const fallAmbig = fromZoned(2026, 10, 25, 1, 30, 0, LON);
eq('ambiguous local time picks the earlier instant (BST)', offsetMinutes(fallAmbig, LON), 60);

eq('the earlier of two ambiguous 01:30s is 00:30 UTC',
   fallAmbig, Date.UTC(2026, 9, 25, 0, 30));
ok('both ambiguous readings render as 01:30 locally',
   fmtTime(fallAmbig, { zone: LON }) === '01:30' && fmtTime(fallAmbig + HOUR, { zone: LON }) === '01:30');
eq('a skipped 01:30 is pushed past the gap to 02:30 BST', fmtTime(springGap, { zone: LON }), '02:30');

// A DST day is not 24 hours long, but addDays must still land on the next date.
const beforeDst = fromZoned(2026, 3, 28, 12, 0, 0, LON);
eq('addDays crosses a 23-hour day correctly', dateKey(addDays(beforeDst, 1, LON), LON), '2026-03-29');
eq('addDays keeps the wall-clock hour across DST', toParts(addDays(beforeDst, 1, LON), LON).hour, 12);
ok('the DST day really is 23 hours', addDays(beforeDst, 1, LON) - beforeDst === 23 * HOUR,
   `${(addDays(beforeDst, 1, LON) - beforeDst) / HOUR} h`);

eq('eachDay is inclusive at both ends',
   eachDay(fromZoned(2026, 9, 21, 10, 0, 0, IST), fromZoned(2026, 9, 24, 3, 0, 0, IST), IST),
   ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24']);

// The real trip case: BA119 departs London 21:20 on the 21st, lands 11:15 IST on the 22nd.
const dep = parseLocal('2026-09-21', '21:20', LON);
const arr = parseLocal('2026-09-22', '11:15', IST);
eq('BA119 flight time is 9 h 25 m', fmtDuration(arr - dep), '9 h 25 m');
eq('BA119 departure renders as 01:50 IST', fmtTime(dep, { zone: IST }), '01:50');
eq('BA119 arrival renders as 06:45 London', fmtTime(arr, { zone: LON }), '06:45');
eq('the flight lands on the 22nd in trip time', dateKey(arr, IST), '2026-09-22');

eq('zone label for India', zoneAbbr(Date.now(), IST), 'UTC+5:30');
eq('the pre-1993 spelling of Kolkata is normalised', canonicalZone('Asia/Calcutta'), 'Asia/Kolkata');
eq('a modern zone is left alone', canonicalZone('Europe/London'), 'Europe/London');
eq('zone label for Kathmandu', zoneAbbr(Date.now(), KTM), 'UTC+5:45');

eq('snapping rounds to the nearest 15 minutes',
   fmtTime(snap(parseLocal('2026-09-23', '10:22', IST), 15, IST), { zone: IST }), '10:15');
eq('snapping rounds up past the halfway mark',
   fmtTime(snap(parseLocal('2026-09-23', '10:23', IST), 15, IST), { zone: IST }), '10:30');

eq('duration formats hours and minutes', fmtDuration(95 * MIN), '1 h 35 m');
eq('duration formats whole days', fmtDuration(2 * DAY + 3 * HOUR), '2 d 3 h');
eq('range formats as a 24-hour span',
   fmtRange(parseLocal('2026-09-23', '09:30', IST), parseLocal('2026-09-23', '12:30', IST), { zone: IST }),
   '09:30–12:30');

/* ============ travel ============ */

ok('Bengaluru airport to the venue is roughly 30 km',
   Math.abs(haversineKm(13.1986, 77.7066, 12.9606, 77.6387) - 27.5) < 3,
   `${haversineKm(13.1986, 77.7066, 12.9606, 77.6387).toFixed(1)} km`);

const blrProfile = profileFor(IST);
const peakAm = trafficFactor(parseLocal('2026-09-23', '09:15', IST), IST, blrProfile);
const midday = trafficFactor(parseLocal('2026-09-23', '14:00', IST), IST, blrProfile);
const night = trafficFactor(parseLocal('2026-09-23', '03:30', IST), IST, blrProfile);
ok('morning peak is worse than midday', peakAm > midday, `${peakAm} vs ${midday}`);
ok('midday is worse than the small hours', midday > night, `${midday} vs ${night}`);
ok('the small hours are all but free', night < 1.05, String(night));
ok('the model never speeds traffic up', peakAm >= 1 && midday >= 1 && night >= 1);

const delhi = profileFor(IST, 'delhi');
const goa = profileFor(IST, 'goa');
ok('Delhi jams harder than Goa', delhi.peak > goa.peak, `${delhi.peak} vs ${goa.peak}`);

const airportRun = estimateTravel({
  from: { lat: 13.1986, lon: 77.7066, timezone: IST, name: 'BLR' },
  to: { lat: 12.9606, lon: 77.6387, timezone: IST, name: 'Venue' },
  mode: 'taxi',
  departAt: parseLocal('2026-09-26', '09:15', IST),
});
const airportTotal = travelMinutes(airportRun) + overheadMinutes('taxi', 'airport', 'venue');
ok('door to door, the airport run tops an hour in morning traffic', airportTotal > 60,
   `${airportTotal} min (${travelMinutes(airportRun)} moving)`);
ok('the estimate is deterministic',
   travelMinutes(estimateTravel({
     from: { lat: 13.1986, lon: 77.7066, timezone: IST, name: 'BLR' },
     to: { lat: 12.9606, lon: 77.6387, timezone: IST, name: 'Venue' },
     mode: 'taxi', departAt: parseLocal('2026-09-26', '09:15', IST),
   })) === travelMinutes(airportRun));

/* ============ the seeded trip ============ */

const trip = conferenceTrip();
eq('eight travellers', trip.people.length, 8);
eq('nine airports: six origins, two hubs and the host',
   new Set(trip.places.filter((p) => p.kind === 'airport').map((p) => p.code)).size, 9);
ok('every segment ends after it starts', trip.segments.every((s) => s.end > s.start),
   trip.segments.filter((s) => s.end <= s.start).map((s) => s.title).join(', '));
ok('every place reference resolves',
   trip.segments.every((s) => [s.placeId, s.fromPlaceId, s.toPlaceId]
     .filter(Boolean).every((id) => trip.places.some((p) => p.id === id))));
ok('every attendee reference resolves',
   trip.segments.every((s) => s.attendeeIds.every((id) => trip.people.some((p) => p.id === id))));
ok('every group member resolves',
   trip.groups.every((g) => g.memberIds.every((id) => trip.people.some((p) => p.id === id))));

const joint = trip.segments.filter((s) => s.everyone);
ok('the joint workshop includes everyone',
   joint.length > 0 && joint.every((s) => attendeesOf(s, trip).length === 8));

const tom = trip.people.find((p) => p.name.startsWith('Tom'))!;
const tomSegs = segmentsFor(tom.id, trip);
ok('Tom has an itinerary', tomSegs.length > 5, `${tomSegs.length} items`);
ok('Tom’s items are in chronological order',
   tomSegs.every((s, i) => i === 0 || s.start >= tomSegs[i - 1].start));

/* ============ the analyser ============ */

const issues = analyse(trip);
/* Tom lands at BLR and is due 33 km away fifteen minutes later. No car, cab or
   train covers that, so the verdict has to be "impossible", not "tight". */
const impossible = issues.find((i) => i.code === 'unreachable');
ok('the impossible airport connection is caught', !!impossible, issues.map((i) => i.code).join(','));
ok('it names the person', !!impossible && impossible.personIds.includes(tom.id));
ok('it is raised as an error, not a hint', !!impossible && impossible.severity === 'error');
/* Yu-Chen is two minutes short on a 2.5 km hop. That is a slow cab, not a law
   of physics, and calling it impossible would teach people to ignore the ones
   that are. */
const merelyTight = issues.find((i) => i.code === 'travel-gap' || i.code === 'tight-connection');
ok('a two-minute shortfall is called tight, not impossible', !!merelyTight);
ok('and it is not escalated to an error', merelyTight?.severity !== 'error');
ok('free evenings are surfaced', issues.some((i) => i.code === 'orphan-evening'));
ok('no phantom overlaps in the seeded plan',
   !issues.some((i) => i.code === 'overlap' && i.severity === 'error' && i.title.includes('double-booked')),
   issues.filter((i) => i.code === 'overlap').map((i) => i.detail).join(' | '));
ok('every issue points at something real',
   issues.every((i) => i.segmentIds.every((id) => trip.segments.some((s) => s.id === id))));

// A plan with two distant airports back to back and no flight between them.
const broken = {
  ...trip,
  segments: [
    { ...trip.segments[0], id: 'x1', kind: 'checkin' as const, placeId: 'del', toPlaceId: undefined, fromPlaceId: undefined,
      attendeeIds: [tom.id], everyone: undefined,
      start: parseLocal('2026-09-23', '09:00', IST), end: parseLocal('2026-09-23', '10:00', IST) },
    { ...trip.segments[0], id: 'x2', kind: 'checkin' as const, placeId: 'blr', toPlaceId: undefined, fromPlaceId: undefined,
      attendeeIds: [tom.id], everyone: undefined,
      start: parseLocal('2026-09-23', '18:00', IST), end: parseLocal('2026-09-23', '19:00', IST) },
  ],
};
const brokenIssues = analyse(broken);
/* Delhi to Bengaluru in eight hours is not impossible — it is a two-hour
   flight. What is missing is the flight, and that is what it should say. */
const needsFlight = brokenIssues.find((i) => i.code === 'needs-flight');
ok('a 1700 km hop with no flight booked asks for the flight',
   !!needsFlight, brokenIssues.map((i) => i.code).join(','));
ok('and it is an error', needsFlight?.severity === 'error');
ok('it does not pretend a taxi could do it', !/taxi/i.test(needsFlight?.detail ?? ''));

/* The same hop with only three hours between: now nothing gets you there. */
const reallyBroken = {
  ...broken,
  segments: [
    broken.segments[0],
    { ...broken.segments[1],
      start: parseLocal('2026-09-23', '13:00', IST), end: parseLocal('2026-09-23', '14:00', IST) },
  ],
};
const hardIssues = analyse(reallyBroken);
ok('Delhi to Bengaluru in three hours is impossible, flight or not',
   hardIssues.some((i) => i.code === 'unreachable'), hardIssues.map((i) => i.code).join(','));

/* The example from the brief: Bengaluru to Goa and nothing like enough time. */
const goaHop = {
  ...trip,
  places: [...trip.places,
    { id: 'goa', name: 'Goa', kind: 'landmark' as const, lat: 15.2993, lon: 74.1240, timezone: IST }],
  segments: [
    { ...trip.segments[0], id: 'g1', kind: 'activity' as const, placeId: 'blr',
      toPlaceId: undefined, fromPlaceId: undefined, attendeeIds: [tom.id], everyone: undefined,
      start: parseLocal('2026-09-23', '09:00', IST), end: parseLocal('2026-09-23', '10:00', IST) },
    { ...trip.segments[0], id: 'g2', kind: 'activity' as const, placeId: 'goa',
      toPlaceId: undefined, fromPlaceId: undefined, attendeeIds: [tom.id], everyone: undefined,
      start: parseLocal('2026-09-23', '13:00', IST), end: parseLocal('2026-09-23', '14:00', IST) },
  ],
};
const goaIssues = analyse(goaHop).filter((i) => i.code === 'unreachable');
ok('Bengaluru to Goa in three hours is refused', goaIssues.length === 1,
   analyse(goaHop).map((i) => i.code).join(','));
ok('and the refusal quotes the distance', /\d{3} km/.test(goaIssues[0]?.detail ?? ''),
   goaIssues[0]?.detail);

/* ============ calendar export ============ */

const ics = buildIcs(trip, { personId: tom.id, alarmMin: 30 });
const lines = ics.split('\r\n');
ok('the file uses CRLF line endings', ics.includes('\r\n') && !ics.includes('\n\n'));
eq('it opens as a VCALENDAR', lines[0], 'BEGIN:VCALENDAR');
eq('it closes cleanly', lines[lines.length - 2], 'END:VCALENDAR');
eq('every VEVENT is closed',
   lines.filter((l) => l === 'BEGIN:VEVENT').length, lines.filter((l) => l === 'END:VEVENT').length);
ok('no content line exceeds 75 octets',
   lines.every((l) => new TextEncoder().encode(l).length <= 75),
   lines.filter((l) => new TextEncoder().encode(l).length > 75)[0]);
ok('timestamps are UTC', lines.some((l) => /^DTSTART:\d{8}T\d{6}Z$/.test(l)));
ok('alarms are attached', ics.includes('BEGIN:VALARM') && ics.includes('TRIGGER:-PT30M'));
ok('attendees carry a display name', ics.includes('ATTENDEE;CN=Tom Bradshaw'));
ok('geo coordinates are exported', lines.some((l) => l.startsWith('GEO:')));
eq('one event per non-cancelled segment Tom is on',
   lines.filter((l) => l === 'BEGIN:VEVENT').length,
   tomSegs.filter((s) => s.status !== 'cancelled').length);

// Escaping: a title with a comma, semicolon and newline must survive.
const nasty = {
  ...trip,
  segments: [{
    ...trip.segments[0],
    title: 'Dinner, drinks; then a walk',
    notes: 'line one\nline two',
  }],
};
const escaped = buildIcs(nasty);
ok('commas are escaped', escaped.includes('Dinner\\, drinks'));
ok('semicolons are escaped', escaped.includes('drinks\\; then'));
ok('newlines become \\n', escaped.includes('line one\\nline two'));

/* ============ sharing ============ */

const token = encodeTrip(trip, 'view', tom.id);
const back = decodeTrip(token);
ok('a shared trip decodes', !!back);
eq('the mode survives', back?.mode, 'view');
eq('every segment survives', back?.trip.segments.length, trip.segments.length);
eq('every place survives', back?.trip.places.length, trip.places.length);
eq('every group survives', back?.trip.groups.length, trip.groups.length);
eq('every idea survives', back?.trip.ideas.length, trip.ideas.length);
eq('people survive', back?.trip.people.length, 8);
eq('the trip name survives', back?.trip.name, trip.name);
eq('the base zone survives', back?.trip.baseTimezone, trip.baseTimezone);
ok('the focus points at the right person',
   !!back && back.trip.people[trip.people.findIndex((p) => p.id === tom.id)].id === back.focus,
   `${back?.focus}`);


// Structural equivalence: everything but the regenerated identifiers.
const strip = (t: typeof trip) => ({
  name: t.name, tz: t.baseTimezone,
  people: t.people.map((p) => ({ n: p.name, z: p.homeTimezone, c: p.color, i: p.interests, e: p.email ?? null })),
  places: t.places.map((p) => ({ n: p.name, k: p.kind, y: p.lat, x: p.lon, z: p.timezone, c: p.code ?? null })),
  groups: t.groups.map((g) => ({ n: g.name, k: g.kind, m: g.memberIds.length })),
  segments: t.segments.map((s) => ({
    t: s.title, k: s.kind, s: s.start, e: s.end, z: s.timezone,
    st: s.status, a: s.attendeeIds.length, ev: !!s.everyone,
    n: s.notes ?? null, tg: s.tags, fl: s.flight ?? null,
  })),
  ideas: t.ideas.map((i) => ({ t: i.title, d: i.durationMin, v: i.votes.length })),
});
eq('the whole trip round-trips structurally', strip(back!.trip), strip(trip));

const rawJson = JSON.stringify(trip);
ok('packing beats raw JSON by a wide margin', token.length < rawJson.length / 3,
   `${token.length} chars from ${rawJson.length} of JSON`);
ok('a nine-day, eight-person plan still fits in a chat message',
   token.length < 10_000, `${token.length} chars`);
eq('garbage decodes to null, it does not throw', decodeTrip('not-a-real-token'), null);
eq('an empty token decodes to null', decodeTrip(''), null);
ok('a v1 link from an older build still opens',
   !!decodeTrip(compressToEncodedURIComponent(JSON.stringify({ v: 1, mode: 'view', trip }))));

// A trip with nothing in it must survive the same path.
const blank = { ...trip, places: [], people: [], groups: [], segments: [], ideas: [] };
const blankBack = decodeTrip(encodeTrip(blank));
eq('an empty trip round-trips', blankBack?.trip.segments.length, 0);

/* ============ the reducer ============ */

let st = initialState(trip);
const first = trip.segments[0];
st = reducer(st, { type: 'segment/move', id: first.id, deltaMs: 30 * MIN, snapMin: 0 });
eq('an exact move applies the delta verbatim',
   st.present.segments[0].start - first.start, 30 * MIN);
eq('the duration is preserved',
   st.present.segments[0].end - st.present.segments[0].start, first.end - first.start);
st = reducer(st, { type: 'history/undo' });
eq('undo restores the original time', st.present.segments[0].start, first.start);
st = reducer(st, { type: 'history/redo' });
eq('redo reapplies it', st.present.segments[0].start - first.start, 30 * MIN);

st = reducer(initialState(trip), { type: 'segment/move', id: first.id, deltaMs: 7 * MIN, snapMin: 15 });
eq('a snapped move lands on the grid', toParts(st.present.segments[0].start, first.timezone).minute % 15, 0);

const everyoneSeg = trip.segments.find((s) => s.everyone)!;
st = reducer(initialState(trip), { type: 'segment/assign', id: everyoneSeg.id, personId: tom.id, on: false });
const after = st.present.segments.find((s) => s.id === everyoneSeg.id)!;
ok('removing one person from an everyone block materialises the list', !after.everyone);
eq('and leaves the other seven', after.attendeeIds.length, 7);
ok('and the right one is gone', !after.attendeeIds.includes(tom.id));

st = reducer(initialState(trip), { type: 'person/delete', id: tom.id });
ok('deleting a person scrubs them from every segment',
   st.present.segments.every((s) => !s.attendeeIds.includes(tom.id)));
ok('and from every group', st.present.groups.every((g) => !g.memberIds.includes(tom.id)));

/* ============ layout ============ */

const cols = packColumns([
  { ...first, id: 'a', start: 0, end: 100 },
  { ...first, id: 'b', start: 50, end: 150 },
  { ...first, id: 'c', start: 200, end: 300 },
]);
eq('overlapping blocks share a cluster width', cols.get('a')?.cols, 2);
ok('and take different columns', cols.get('a')?.col !== cols.get('b')?.col);
eq('a separate cluster gets full width', cols.get('c')?.cols, 1);

/* ============ geocoding ============ */

eq('a bare coordinate pair parses', parseMapLink('15.2993, 74.1240')?.lat, 15.2993);
eq('a Google /@ link parses', parseMapLink('https://www.google.com/maps/@12.9716,77.5946,15z')?.lon, 77.5946);
eq('a Google /place/ link keeps the name',
   parseMapLink('https://www.google.com/maps/place/Koshy%27s/@12.9746,77.6011,17z')?.name, "Koshy's");
eq('the !3d!4d form wins over the viewport centre',
   parseMapLink('https://www.google.com/maps/place/X/@12.0,77.0,17z/data=!3d13.5!4d78.5')?.lat, 13.5);
eq('an OpenStreetMap fragment parses',
   parseMapLink('https://www.openstreetmap.org/#map=15/15.2993/74.1240')?.lon, 74.124);
eq('a ?q= link parses', parseMapLink('https://maps.google.com/?q=19.0760,72.8777')?.lat, 19.076);
eq('a geo: URI parses', parseMapLink('geo:28.6139,77.2090')?.lon, 77.209);
ok('prose is not mistaken for a location', parseMapLink('let us meet at the beach') === null);
ok('an out-of-range latitude is refused', parseMapLink('120.0, 45.0') === null);
ok('a shortened link is recognised as one', isShortMapLink('https://maps.app.goo.gl/abc123'));
ok('and it does not silently parse to nothing useful', parseMapLink('https://maps.app.goo.gl/abc123') === null);

eq('India resolves to Kolkata time', guessZone(15.2993, 74.1240), 'Asia/Kolkata');
eq('London resolves to London time', guessZone(51.5074, -0.1278), 'Europe/London');
eq('Taipei resolves to Taipei time', guessZone(25.033, 121.5654), 'Asia/Taipei');
ok('the open ocean still yields a usable zone', isValidZone(guessZone(0, -140)));
ok('every built-in gazetteer entry has a real zone',
   searchBuiltin('a', 99).every((h) => isValidZone(h.timezone)));
ok('searching by IATA code finds the airport',
   searchBuiltin('BLR').some((h) => h.code === 'BLR'));
ok('a common misspelling still finds the city',
   searchBuiltin('bangalore').some((h) => h.name.includes('Bengaluru')));

/* ============ sub-trips ============ */

const beachPeople = [trip.people[0].id, trip.people[1].id];
const beachBranch = makeBranch('Beach group', beachPeople, '#14d4c4');
const withBranch: Trip = {
  ...trip,
  branches: [beachBranch],
  segments: trip.segments.map((s, i) =>
    i >= 2 && i <= 3 ? { ...s, branchId: beachBranch.id, everyone: false, attendeeIds: beachPeople } : s),
};

eq('the branch owns its segments', segmentsInBranch(withBranch, beachBranch.id).length, 2);
ok('the main line no longer counts them',
   mainSegments(withBranch).every((s) => s.branchId === undefined));
eq('members are the people on it', branchMembers(withBranch, beachBranch).length, 2);
const span = spanOf(withBranch, beachBranch);
ok('the span is derived from the segments, not stored',
   span.start === Math.min(...span.segments.map((s) => s.start)));
eq('a top-level branch has depth 0', branchDepth(withBranch, beachBranch.id), 0);

const nested = makeBranch('Diving pair', [beachPeople[0]], '#8b7cff', beachBranch.id);
const withNested: Trip = { ...withBranch, branches: [beachBranch, nested] };
eq('a nested branch is one deeper', branchDepth(withNested, nested.id), 1);
eq('and it is listed as a child', childBranches(withNested, beachBranch.id)[0]?.id, nested.id);

/* Sub-trips and availability windows have to survive the wire too, or a
   shared link quietly flattens the plan back into one undifferentiated group. */
const richTrip: Trip = {
  ...withNested,
  people: withNested.people.map((p, i) =>
    i === 0 ? { ...p, windowStart: parseLocal('2026-09-22', '14:00', IST), homeLat: 15.3, homeLon: 74.1 } : p),
};
const rich = decodeTrip(encodeTrip(richTrip, 'edit'))!.trip;
eq('branches survive the wire', rich.branches.length, 2);
eq('branch names survive', rich.branches[0].name, 'Beach group');
eq('branch nesting survives', rich.branches[1].parentId, rich.branches[0].id);
eq('branch membership survives', rich.branches[0].memberIds.length, 2);
ok('branch membership still points at real people',
   rich.branches.every((b) => b.memberIds.every((m) => rich.people.some((p) => p.id === m))));
eq('segments keep their branch',
   rich.segments.filter((x) => x.branchId === rich.branches[0].id).length,
   segmentsInBranch(withNested, beachBranch.id).length);
eq('an availability window survives to the minute',
   rich.people[0].windowStart, parseLocal('2026-09-22', '14:00', IST));
eq('home coordinates survive', rich.people[0].homeLat, 15.3);

/* Dissolving a parent re-parents its children rather than orphaning them. */
const dissolved = reducer(initialState(withNested), { type: 'branch/delete', id: beachBranch.id, keep: true });
eq('dissolving keeps the segments', dissolved.present.segments.length, withNested.segments.length);
ok('and puts them back on the main line',
   dissolved.present.segments.every((s) => s.branchId !== beachBranch.id));
eq('the child survives its parent', dissolved.present.branches.length, 1);
eq('re-parented to the top', dissolved.present.branches[0].parentId, undefined);

/* A side trip that spans a night must not black out the day between its
   blocks: only genuine overlaps are double-bookings. */
const spanning = (() => {
  const who = trip.people[2].id;
  const evening = {
    ...trip.segments[0], id: 'b1', kind: 'activity' as const, branchId: 'brx',
    attendeeIds: [who], everyone: undefined, placeId: undefined, toPlaceId: undefined, fromPlaceId: undefined,
    start: parseLocal('2026-09-25', '18:00', IST), end: parseLocal('2026-09-25', '21:00', IST),
  };
  const nextAfternoon = {
    ...evening, id: 'b2',
    start: parseLocal('2026-09-26', '15:00', IST), end: parseLocal('2026-09-26', '17:00', IST),
  };
  // On the main line, and squarely inside the branch's outer span — but it does
  // not overlap either branch block, so it is not a clash.
  const mainMorning = {
    ...evening, id: 'm1', branchId: undefined,
    start: parseLocal('2026-09-26', '09:00', IST), end: parseLocal('2026-09-26', '11:00', IST),
  };
  return {
    ...trip,
    branches: [{ id: 'brx', name: 'Overnight side trip', color: '#14d4c4', memberIds: [who] }],
    segments: [evening, nextAfternoon, mainMorning],
  } as Trip;
})();
ok('a gap inside a sub-trip span is not a double-booking',
   !analyse(spanning).some((i) => i.code === 'branch-clash'),
   analyse(spanning).filter((i) => i.code === 'branch-clash').map((i) => i.detail).join(' | '));

const reallyClashing = {
  ...spanning,
  segments: spanning.segments.map((s) =>
    s.id === 'm1'
      ? { ...s, start: parseLocal('2026-09-25', '19:00', IST), end: parseLocal('2026-09-25', '20:00', IST) }
      : s),
};
const clashes = analyse(reallyClashing).filter((i) => i.code === 'branch-clash');
eq('a real overlap is one clash, not one per block', clashes.length, 1);
eq('and it is blocking', clashes[0]?.severity, 'error');

/* Deleting a person scrubs them from branches as well as segments. */
const minusOne = reducer(initialState(withBranch), { type: 'person/delete', id: beachPeople[0] });
ok('a removed person leaves no trace in a branch',
   minusOne.present.branches.every((b) => !b.memberIds.includes(beachPeople[0])));

/* ============ canvas geometry ============ */

const canvasZone = IST;
const canvasDays = eachDay(
  Math.min(...trip.segments.map((s) => s.start)),
  Math.max(...trip.segments.map((s) => s.end)),
  canvasZone,
);
const canvasOpts = { ...DEFAULT_CANVAS, zone: canvasZone, days: canvasDays };
const model = buildCanvas(withBranch, withBranch.segments, canvasOpts);

eq('one column per day', model.columns.length, canvasDays.length);
ok('columns never overlap',
   model.columns.every((c, i) => i === 0 || c.x >= model.columns[i - 1].x + model.columns[i - 1].width));
ok('a day the group splits carries an extra track',
   model.columns.some((c) => c.tracks.length > 1));
ok('every branch segment lands on its own branch track',
   model.nodes.filter((n) => n.branchId).every((n) => n.trackId === n.branchId));
ok('every node sits inside its column',
   model.nodes.every((n) => {
     const col = model.columns.find((c) => c.dayKey === n.dayKey)!;
     return n.x >= col.x - 0.5 && n.x + n.w <= col.x + col.width + 0.5;
   }));
ok('no node is drawn too small to read', model.nodes.every((n) => n.h >= 26));

/* y and time are inverses of one another, which is what makes dragging a card
   the same act as rescheduling it. */
const probeDay = dateKeyToEpoch(canvasDays[0], canvasZone);
const probeAt = probeDay + 14 * HOUR + 20 * MIN;
const probeY = yFor((probeAt - probeDay) / MIN, canvasOpts);
eq('a time maps to a height and back', Math.round(timeAt(probeY, probeDay, canvasOpts)), probeAt);

ok('edges only ever join two real nodes',
   model.edges.every((e) => model.nodeByKey.has(e.fromKey) && model.nodeByKey.has(e.toKey)));
ok('an edge carries at least one person', model.edges.every((e) => e.personIds.length > 0));
ok('people making the same hop share one edge',
   model.edges.length <= withBranch.people.length * withBranch.segments.length);
ok('some edge bundles more than one person', model.edges.some((e) => e.personIds.length > 1));
ok('an infeasible hop is marked as such',
   model.edges.filter((e) => !e.feasible).every((e) => e.needMin !== undefined && e.haveMin < e.needMin));

const presentDays = model.presence.filter((p) => p.present);
ok('presence is computed for someone', presentDays.length > 0);

/* An empty board still has to show a roster, or there is nothing to drag. */
const rosterOnly = buildCanvas(
  { ...trip, segments: [], branches: [] },
  [],
  { ...DEFAULT_CANVAS, zone: canvasZone, days: canvasDays.slice(0, 3) },
);
eq('everyone shows up on an empty board',
   rosterOnly.presence.filter((p) => p.present && p.dayKey === canvasDays[0]).length,
   trip.people.length);
ok('and none of them is shown as busy',
   rosterOnly.presence.every((p) => p.busyMin === 0));

/* Someone who has said when they can come is absent outside that window. */
const lateArrival = buildCanvas(
  {
    ...trip, segments: [], branches: [],
    people: trip.people.map((p, i) =>
      i === 0 ? { ...p, windowStart: dateKeyToEpoch(canvasDays[2], canvasZone) } : p),
  },
  [],
  { ...DEFAULT_CANVAS, zone: canvasZone, days: canvasDays.slice(0, 3) },
);
const latecomer = trip.people[0].id;
ok('a declared window keeps someone off the days before it',
   !lateArrival.presence.find((p) => p.personId === latecomer && p.dayKey === canvasDays[0])?.present);
ok('and puts them on the day it starts',
   !!lateArrival.presence.find((p) => p.personId === latecomer && p.dayKey === canvasDays[2])?.present);
ok('free windows never run backwards',
   model.presence.every((p) => p.free.every((f) => f.toMin > f.fromMin)));
ok('free windows sit inside the drawn day',
   model.presence.every((p) => p.free.every((f) => f.fromMin >= canvasOpts.hourStart * 60 && f.toMin <= canvasOpts.hourEnd * 60)));

/* Hit-testing is the inverse of column layout — a drop has to land where the
   card was drawn. */
const midCol = model.columns[1];
const hit = hitColumn(model, midCol.x + 4);
eq('a point inside a column finds it', hit?.column.dayKey, midCol.dayKey);
ok('a point past the last column finds nothing', hitColumn(model, model.width + 500) === null);

/* ============ the library ============ */

const twin = reidentify(trip);
ok('a duplicate gets a new trip id', twin.id !== trip.id);
ok('and new person ids', twin.people.every((p) => !trip.people.some((q) => q.id === p.id)));
eq('but the same number of people', twin.people.length, trip.people.length);
ok('attendee lists are rewritten to match',
   twin.segments.every((s) => s.attendeeIds.every((a) => twin.people.some((p) => p.id === a))));
ok('place references are rewritten too',
   twin.segments.every((s) => !s.placeId || twin.places.some((p) => p.id === s.placeId)));

const branchTwin = reidentify(withNested);
ok('branch parentage survives duplication',
   branchTwin.branches.every((b) => !b.parentId || branchTwin.branches.some((x) => x.id === b.parentId)));
ok('branch membership is rewritten',
   branchTwin.branches.every((b) => b.memberIds.every((m) => branchTwin.people.some((p) => p.id === m))));

const bare = migrate({ ...trip, branches: undefined as unknown as Trip['branches'] });
eq('a trip written before sub-trips existed still loads', bare.branches.length, 0);

/* ============ report ============ */

console.log(`\n  ${pass} passed, ${fails.length} failed\n`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('  all green\n');

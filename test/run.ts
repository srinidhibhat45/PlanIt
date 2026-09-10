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
import { openingDay, packColumns, tripDayKeys, tripSpan } from '../src/core/layout';
import { guessZone, isShortMapLink, isValidZone, parseMapLink, searchBuiltin } from '../src/core/geo';
import { branchDepth, branchMembers, childBranches, mainSegments, segmentsInBranch, spanOf } from '../src/core/branch';
import {
  CARD_H, CARD_W, cardRect, cardsIn, connector, contentBounds, fitTo, frameAt, isScheduled,
  layoutFromSchedule, normalise, peopleFlows, sidesFor, toScreen, toWorld, zoomAt,
} from '../src/core/board';
import { DEFAULT_RESOLVE, boardColumns, resolveBoard, topoOrder } from '../src/core/resolve';
import {
  compactDuration, describeGap, gapTone, setDuration, setTimeOfDay, shiftBy, stackGaps,
  summariseDay,
} from '../src/core/timelayer';
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

/* ============ board geometry ============ */

/* Screen and world are inverses of one another; every drop position depends on
   it, so it is asserted at an awkward zoom rather than at 1. */
const vp = { x: -120, y: 240, zoom: 0.63 };
const roundTrip = toScreen(vp, toWorld(vp, 317, 209));
ok('screen → world → screen is the identity',
   Math.abs(roundTrip.x - 317) < 0.001 && Math.abs(roundTrip.y - 209) < 0.001,
   JSON.stringify(roundTrip));

/* Zooming about a point must leave that point where it was, or the board
   crawls away from the cursor as you scroll. */
const zoomed = zoomAt(vp, 400, 300, 1.4);
const anchorBefore = toWorld(vp, 400, 300);
const anchorAfter = toWorld(zoomed, 400, 300);
ok('zooming holds the point under the cursor',
   Math.abs(anchorBefore.x - anchorAfter.x) < 0.001 && Math.abs(anchorBefore.y - anchorAfter.y) < 0.001);
ok('and it actually zoomed', zoomed.zoom > vp.zoom);
ok('zoom is clamped at the top', zoomAt(vp, 0, 0, 10_000).zoom <= 3);
ok('and at the bottom', zoomAt(vp, 0, 0, 0.00001).zoom >= 0.12);

const fitted = fitTo({ x: 100, y: 100, w: 800, h: 400 }, 1000, 700);
const fitCentre = toWorld(fitted, 500, 350);
ok('fitting centres the content', Math.abs(fitCentre.x - 500) < 1 && Math.abs(fitCentre.y - 300) < 1,
   JSON.stringify(fitCentre));

eq('a drag rectangle drawn backwards still normalises',
   normalise({ x: 90, y: 80 }, { x: 10, y: 20 }), { x: 10, y: 20, w: 80, h: 60 });

/* Connectors leave the side that faces the other card. */
const left = { x: 0, y: 0, w: CARD_W, h: CARD_H };
eq('a card to the right is joined side to side',
   sidesFor(left, { x: 600, y: 10, w: CARD_W, h: CARD_H }), { from: 'right', to: 'left' });
eq('a card below is joined top to bottom',
   sidesFor(left, { x: 10, y: 600, w: CARD_W, h: CARD_H }), { from: 'bottom', to: 'top' });
eq('and a card above, the other way round',
   sidesFor(left, { x: 10, y: -600, w: CARD_W, h: CARD_H }), { from: 'top', to: 'bottom' });
const wire = connector(left, { x: 600, y: 0, w: CARD_W, h: CARD_H });
ok('a connector is a single cubic', /^M [\d.-]+ [\d.-]+ C /.test(wire.path));
ok('it starts on the right edge of the first card', Math.abs(wire.start.x - CARD_W) < 0.01);
ok('and ends on the left edge of the second', Math.abs(wire.end.x - 600) < 0.01);
ok('its label sits between the two', wire.mid.x > CARD_W && wire.mid.x < 600);

/* ============ laying the schedule out on the board ============ */

const laid = layoutFromSchedule(trip, IST);
eq('every live card gets a position',
   laid.positions.size, trip.segments.filter((s) => s.status !== 'cancelled').length);
ok('a frame is made for every day', laid.frames.length > 0);
ok('every frame is a day frame', laid.frames.every((f) => !!f.dayKey));
ok('day frames do not overlap horizontally',
   laid.frames.every((f, i) => i === 0 || f.rect.x >= laid.frames[i - 1].rect.x + laid.frames[i - 1].rect.w));

const boarded: Trip = {
  ...trip,
  frames: laid.frames,
  segments: trip.segments.map((s) => ({ ...s, at: laid.positions.get(s.id) ?? s.at })),
};
ok('every card lands inside the frame for its own day',
   boarded.segments
     .filter((s) => s.status !== 'cancelled' && s.at)
     .every((s) => {
       const day = dateKey(s.start, IST);
       const f = boarded.frames.find((x) => x.dayKey === day);
       return !!f && s.at!.x >= f.rect.x && s.at!.x <= f.rect.x + f.rect.w;
     }));
eq('and the frame it reports being in agrees',
   frameAt(boarded, { x: boarded.segments[0].at!.x + 1, y: boarded.segments[0].at!.y + 1 })?.dayKey,
   dateKey(boarded.segments[0].start, IST));

/* Stacking, not clock arithmetic: two cards in one lane must never overlap,
   whatever their times. Rounding a y from the hour used to collide them. */
const laneOverlap = (() => {
  const byLane = new Map<string, { y: number; h: number }[]>();
  for (const seg of boarded.segments) {
    if (!seg.at || seg.status === 'cancelled') continue;
    const key = `${Math.round(seg.at.x)}`;
    byLane.set(key, [...(byLane.get(key) ?? []), { y: seg.at.y, h: CARD_H }]);
  }
  for (const list of byLane.values()) {
    const sorted = [...list].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].y < sorted[i - 1].y + sorted[i - 1].h) return true;
    }
  }
  return false;
})();
ok('no two cards in a lane are laid out on top of each other', !laneOverlap);

const bounds = contentBounds(boarded);
ok('content bounds cover every card',
   boarded.segments.filter((s) => s.at).every((s) => {
     const r = cardRect(s);
     return r.x >= bounds.x && r.x + r.w <= bounds.x + bounds.w;
   }));

const marquee = cardsIn(boarded, { x: bounds.x, y: bounds.y, w: 1, h: 1 });
ok('a one-pixel marquee catches almost nothing', marquee.length <= 2);
ok('a marquee over everything catches everything',
   cardsIn(boarded, bounds).length === boarded.segments.filter((s) => s.at).length);

const flowRects = new Map(boarded.segments.filter((s) => s.at).map((s) => [s.id, cardRect(s)]));
const boardFlows = peopleFlows(boarded, flowRects);
ok('people flows are derived on the board too', boardFlows.length > 0);
ok('and they still bundle', boardFlows.some((f) => f.personIds.length > 1));

/* ============ resolving the board to a timeline ============ */

const cyc = topoOrder(
  ['a', 'b', 'c'],
  {
    incoming: new Map([['b', [{ id: 'l1', fromId: 'a', toId: 'b', kind: 'then' as const }]],
                       ['a', [{ id: 'l2', fromId: 'b', toId: 'a', kind: 'then' as const }]]]),
    outgoing: new Map([['a', [{ id: 'l1', fromId: 'a', toId: 'b', kind: 'then' as const }]],
                       ['b', [{ id: 'l2', fromId: 'b', toId: 'a', kind: 'then' as const }]]]),
  },
  () => 0,
);
eq('a two-node loop is caught', cyc.cycle.sort(), ['a', 'b']);
eq('and the node outside it still resolves', cyc.order, ['c']);

/** A tiny hand-built board: three cards, one frame, one connector. */
function boardFixture(over: Partial<Trip> = {}): Trip {
  const base = trip.segments[0];
  const card = (id: string, at: { x: number; y: number }, start: string, mins: number): Segment => ({
    ...base, id, title: id, kind: 'activity', at, pinned: undefined,
    placeId: undefined, fromPlaceId: undefined, toPlaceId: undefined,
    everyone: undefined, attendeeIds: [],
    start: parseLocal('2026-09-23', start, IST),
    end: parseLocal('2026-09-23', start, IST) + mins * MIN,
  });
  return {
    ...trip,
    links: [],
    stickies: [],
    frames: [{ id: 'f1', title: 'Day 1', rect: { x: 0, y: 0, w: 600, h: 900 }, color: '#fff', dayKey: '2026-09-25' }],
    segments: [
      card('top', { x: 40, y: 40 }, '09:00', 60),
      card('middle', { x: 40, y: 300 }, '08:00', 90),
      card('outside', { x: 2000, y: 40 }, '07:00', 60),
    ],
    ...over,
  };
}

const framed = resolveBoard(boardFixture());
eq('only the framed cards are scheduled', framed.considered, 2);
const topMove = framed.moves.find((m) => m.id === 'top');
const midMove = framed.moves.find((m) => m.id === 'middle');
ok('a framed card moves to the frame’s day',
   !!topMove && dateKey(topMove.to, IST) === '2026-09-25');
ok('a card outside every frame is left alone',
   !framed.moves.some((m) => m.id === 'outside'));

/* The two cards in the fixture are stacked in one column but their times run
   the other way, so resolving deals the same two times back out in the order
   they now sit. Nothing is invented; they simply swap. */
eq('the card on top takes the earlier of the two times', toParts(topMove!.to, IST).hour, 8);
eq('and the one below takes the later', toParts(midMove!.to, IST).hour, 9);
ok('which puts them in the order the board shows', topMove!.to < midMove!.to);

/* The frame sets the date and nothing else: 14:20 stays 14:20. */
const timeKept = resolveBoard(boardFixture({
  segments: boardFixture().segments.map((s) =>
    s.id === 'top'
      ? { ...s, at: { x: 40, y: 40 }, start: parseLocal('2026-09-23', '14:20', IST), end: parseLocal('2026-09-23', '15:20', IST) }
      : { ...s, at: { x: 900, y: 40 } }),
}));
const kept = timeKept.moves.find((m) => m.id === 'top')!;
eq('moving a card to another day keeps its time of day', fmtTime(kept.to, { zone: IST }), '14:20');
eq('and only the date changes', dateKey(kept.to, IST), '2026-09-25');

/* Side by side means at the same time, so nothing is sequenced between them. */
const parallel = resolveBoard(boardFixture({
  segments: boardFixture().segments.map((s) =>
    s.id === 'middle' ? { ...s, at: { x: 320, y: 40 } } : s),
}));
const pTop = parallel.moves.find((m) => m.id === 'top')!;
const pMid = parallel.moves.find((m) => m.id === 'middle')!;
eq('a card beside another keeps its own hour', toParts(pTop.to, IST).hour, 9);
eq('and so does the one next to it', toParts(pMid.to, IST).hour, 8);

/* Resolving a board that already agrees with itself must do nothing at all —
   this is what stops it from flattening a plan somebody timed by hand. */
const settled = {
  ...boardFixture(),
  frames: [{ id: 'f1', title: 'Day 1', rect: { x: 0, y: 0, w: 600, h: 900 }, color: '#fff', dayKey: '2026-09-23' }],
  segments: boardFixture().segments.map((s) =>
    s.id === 'top' ? { ...s, start: parseLocal('2026-09-23', '08:00', IST), end: parseLocal('2026-09-23', '09:00', IST) }
      : s.id === 'middle' ? { ...s, start: parseLocal('2026-09-23', '11:00', IST), end: parseLocal('2026-09-23', '12:30', IST) }
        : s),
} as Trip;
eq('a board that already agrees with itself resolves to no change',
   resolveBoard(settled).moves.length, 0);

/* And a real double-booking in a column is pushed apart, not left overlapping. */
const overlapping = {
  ...settled,
  segments: settled.segments.map((s) =>
    s.id === 'middle'
      ? { ...s, start: parseLocal('2026-09-23', '08:30', IST), end: parseLocal('2026-09-23', '09:30', IST) }
      : s),
} as Trip;
const pushed = resolveBoard(overlapping).moves.find((m) => m.id === 'middle');
ok('a card stacked under another is pushed clear of it',
   !!pushed && pushed.to >= parseLocal('2026-09-23', '09:00', IST));

/* A connector is a hard "after", and a travel connector costs the journey. */
const linkedBoard = boardFixture({
  links: [{ id: 'l1', fromId: 'middle', toId: 'outside', kind: 'then', bufferMin: 45 }],
});
const chained = resolveBoard(linkedBoard);
const mid2 = chained.moves.find((m) => m.id === 'middle');
const out2 = chained.moves.find((m) => m.id === 'outside');
ok('a linked card is scheduled even with no frame', !!out2);
ok('and it lands after its predecessor finishes, plus the buffer',
   !!out2 && !!mid2 && out2.to >= mid2.to + 90 * MIN + 45 * MIN);

/* A pin outranks everything, and says so when its own inputs disagree. */
const pinnedBoard = boardFixture({
  links: [{ id: 'l1', fromId: 'middle', toId: 'outside', kind: 'then' }],
  segments: boardFixture().segments.map((s) =>
    s.id === 'outside' ? { ...s, pinned: true } : s),
});
const withPin = resolveBoard(pinnedBoard);
ok('a pinned card is never moved', !withPin.moves.some((m) => m.id === 'outside'));
ok('and a pin its own inputs contradict is reported',
   withPin.issues.some((i) => i.code === 'link-backwards'),
   withPin.issues.map((i) => i.code).join(','));

/* A board nobody has framed or wired schedules nothing at all — resolving must
   never scramble a plan somebody already timed by hand. */
const loose = resolveBoard({ ...boardFixture(), frames: [] });
eq('a loose board resolves nothing', loose.considered, 0);
eq('and moves nothing', loose.moves.length, 0);

ok('isScheduled agrees with what resolve would touch',
   boardFixture().segments.filter((s) => isScheduled(boardFixture(), s)).length === 2);

ok('every journey gets some slack by default', DEFAULT_RESOLVE.bufferMin > 0);


/* ============ where a view opens ============ */

/* A trip's own dates are the floor for every date-bearing view. Deriving the
   span from the segments alone opened a fresh trip on *this week*, with the
   trip itself off the right-hand edge — and, worse, put new blocks there. */
const emptyTrip: Trip = {
  ...trip, segments: [], startDate: '2026-10-20', endDate: '2026-10-24',
};
const emptySpan = tripSpan(emptyTrip, IST, Date.UTC(2026, 8, 10));
eq('an empty trip spans its own dates', dateKey(emptySpan.start, IST), '2026-10-20');
eq('through the end of the last day', dateKey(emptySpan.end - 1, IST), '2026-10-24');
eq('and the day picker offers exactly those days',
   tripDayKeys(emptyTrip, IST, Date.UTC(2026, 8, 10)).length, 5);

/* Something scheduled outside the trip's dates widens the span rather than
   being cropped out of every view. */
const strays: Trip = {
  ...emptyTrip,
  segments: [{
    ...trip.segments[0],
    start: parseLocal('2026-10-18', '09:00', IST),
    end: parseLocal('2026-10-18', '10:00', IST),
  }],
};
eq('a block before the trip widens the span, not the other way round',
   dateKey(tripSpan(strays, IST).start, IST), '2026-10-18');
eq('and the trip still ends where it ends',
   dateKey(tripSpan(strays, IST).end - 1, IST), '2026-10-24');

/* But it must not decide where the view *opens*: one stray block a fortnight
   early should not drag a whole trip's planning back with it. */
eq('a view opens on the day the trip starts', openingDay(strays, IST, Date.UTC(2026, 8, 10)), '2026-10-20');
eq('unless the trip is happening now, when today wins',
   openingDay(strays, IST, parseLocal('2026-10-22', '09:00', IST)), '2026-10-22');
eq('a day before the trip is not today enough',
   openingDay(strays, IST, parseLocal('2026-10-19', '09:00', IST)), '2026-10-20');
eq('nor is a day after it',
   openingDay(strays, IST, parseLocal('2026-11-02', '09:00', IST)), '2026-10-20');

/* A trip with no usable dates at all still has to answer. */
const dateless = { ...emptyTrip, startDate: '', endDate: '' } as Trip;
eq('a trip with no dates falls back to today',
   openingDay(dateless, IST, parseLocal('2026-10-19', '09:00', IST)), '2026-10-19');
eq('and spans the week from it',
   tripDayKeys(dateless, IST, parseLocal('2026-10-19', '09:00', IST)).length, 7);

/* The worked example is the real case: it must open on its first day. */
eq('the example trip opens on its own first day',
   openingDay(trip, IST, Date.UTC(2026, 8, 10)), trip.startDate);
ok('and its span covers every one of its blocks', trip.segments.every((s) => {
  const span = tripSpan(trip, IST);
  return s.start >= span.start && s.end <= span.end;
}));

/* ============ the time layer ============ */

/* The board never says what o'clock it is, so the time layer has to read the
   clock off the cards and hand it back — see `timelayer.ts`. */

eq('a compact duration keeps both halves', compactDuration(3 * HOUR + 55 * MIN), '3h55');
eq('and pads the minutes so it stays scannable', compactDuration(HOUR + 5 * MIN), '1h05');
eq('a whole number of hours drops the minutes', compactDuration(2 * HOUR), '2h');
eq('under an hour is minutes alone', compactDuration(40 * MIN), '40m');

/* The columns the stacking grammar makes are shared between the resolver and
   the time layer, which is the whole point of `boardColumns`. */
const columnBoard = boardFixture();
const stacks = boardColumns(columnBoard, columnBoard.segments);
eq('a day frame yields one column for a stack of two', stacks.length, 1);
eq('read top of the board first', stacks[0].members, ['top', 'middle']);
eq('and the column knows which day it is on', stacks[0].dayKey, '2026-09-25');
eq('cards outside every day frame are in no column',
   boardColumns({ ...columnBoard, frames: [] }, columnBoard.segments).length, 0);
const sideBySide = boardFixture({
  segments: boardFixture().segments.map((s) => (s.id === 'middle' ? { ...s, at: { x: 320, y: 40 } } : s)),
});
eq('two cards side by side are two columns, not one',
   boardColumns(sideBySide, sideBySide.segments).length, 2);

/* The gap in the gutter is the thing a date cannot tell you. */
const gapBoard = boardFixture({
  frames: [{ id: 'f1', title: 'Day 1', rect: { x: 0, y: 0, w: 600, h: 900 }, color: '#fff', dayKey: '2026-09-23' }],
  segments: boardFixture().segments.map((s) =>
    s.id === 'top'
      ? { ...s, start: parseLocal('2026-09-23', '09:00', IST), end: parseLocal('2026-09-23', '10:00', IST) }
      : s.id === 'middle'
        ? { ...s, start: parseLocal('2026-09-23', '11:30', IST), end: parseLocal('2026-09-23', '12:30', IST) }
        : s),
});
const seams = stackGaps(gapBoard, IST);
eq('one seam for one stack of two', seams.length, 1);
eq('and it measures the real gap between them', seams[0].ms, 90 * MIN);
eq('which reads as a duration', describeGap(seams[0]), '1h30');
eq('the seam sits between the two cards',
   seams[0].at.y, gapBoard.segments[0].at!.y + CARD_H + (300 - 40 - CARD_H) / 2);
eq('and it knows how much room it has', seams[0].gutter, 300 - 40 - CARD_H);

const tightSeam = stackGaps(boardFixture({
  frames: gapBoard.frames,
  segments: gapBoard.segments.map((s) =>
    s.id === 'middle'
      ? { ...s, start: parseLocal('2026-09-23', '10:00', IST), end: parseLocal('2026-09-23', '11:00', IST) }
      : s),
}), IST)[0];
eq('back-to-back says so in words', describeGap(tightSeam), 'no gap');
eq('and is flagged as having no slack', gapTone(tightSeam), 'tight');

const clashSeam = stackGaps(boardFixture({
  frames: gapBoard.frames,
  segments: gapBoard.segments.map((s) =>
    s.id === 'middle'
      ? { ...s, start: parseLocal('2026-09-23', '09:30', IST), end: parseLocal('2026-09-23', '10:30', IST) }
      : s),
}), IST)[0];
eq('an overlap is named as one', describeGap(clashSeam), 'overlaps 30m');
eq('and flagged loudly', gapTone(clashSeam), 'clash');

const backwardsSeam = stackGaps(boardFixture({
  frames: gapBoard.frames,
  segments: gapBoard.segments.map((s) =>
    s.id === 'middle'
      ? { ...s, start: parseLocal('2026-09-23', '07:00', IST), end: parseLocal('2026-09-23', '08:00', IST) }
      : s),
}), IST)[0];
ok('a stack whose clock runs backwards is spotted', backwardsSeam.reversed);
eq('and named for what it is', describeGap(backwardsSeam), 'out of order');
eq('rather than reported as a five-hour overlap', gapTone(backwardsSeam), 'clash');

const wiredSeam = stackGaps({
  ...gapBoard,
  links: [{ id: 'l1', fromId: 'top', toId: 'middle', kind: 'then' as const }],
}, IST)[0];
ok('a seam a connector already labels knows to stay quiet', wiredSeam.linked);

const hiddenGap = stackGaps(gapBoard, IST, new Set(['top']));
eq('a column closes over a card the filters hid', hiddenGap.length, 0);

/* The ribbon under a day frame. */
const dayCards = gapBoard.segments.filter((s) => s.id !== 'outside');
const summary = summariseDay(gapBoard, dayCards, '2026-09-23', IST);
eq('the ribbon counts the cards in the frame', summary.count, 2);
eq('it knows when the day starts', fmtTime(summary.first!, { zone: IST }), '09:00');
eq('and when it ends', fmtTime(summary.last!, { zone: IST }), '12:30');
eq('busy time is the sum of the cards', summary.busyMs, 2 * HOUR);
eq('the hole between them is the free stretch', summary.gapFrom, dayCards[0].end);
eq('nothing is double-booked', summary.clashes, 0);
eq('and nothing is on the wrong date', summary.offDay, 0);

/* A block sits where its own clock puts it in the 24 hours — 09:00 is 37.5%
   of the way through the day — and never where the card sits on the board. */
ok('a block is placed by the clock, not by the layout',
   Math.abs(summary.blocks[0].from - 9 / 24) < 1e-9,
   String(summary.blocks[0].from));
ok('and it is at least wide enough to see',
   summary.blocks.every((b) => b.to > b.from));

/* Two things at once is only a clash if it is the same person twice over.
   Parallel tracks are the normal shape of a conference day. */
const sharedPerson = gapBoard.people[0].id;
const clashDay = summariseDay(
  gapBoard,
  [
    { ...dayCards[0], attendeeIds: [sharedPerson], everyone: false },
    { ...dayCards[1], start: dayCards[0].start, end: dayCards[0].end, attendeeIds: [sharedPerson], everyone: false },
  ],
  '2026-09-23', IST,
);
eq('somebody in two places at once is a clash', clashDay.clashes, 2);
eq('and the overlap is only counted once as busy time', clashDay.busyMs, HOUR);

const parallelDay = summariseDay(
  gapBoard,
  [
    { ...dayCards[0], attendeeIds: [gapBoard.people[0].id], everyone: false },
    { ...dayCards[1], start: dayCards[0].start, end: dayCards[0].end, attendeeIds: [gapBoard.people[1].id], everyone: false },
  ],
  '2026-09-23', IST,
);
eq('two people doing two things at once is not a clash', parallelDay.clashes, 0);

/* A card sitting in one day's frame while timed for another is exactly what
   resolving is for, so the ribbon says how many there are. */
const strayDay = summariseDay(gapBoard, dayCards, '2026-09-25', IST);
eq('cards timed for another date are counted', strayDay.offDay, 2);

eq('an empty frame summarises to nothing', summariseDay(gapBoard, [], '2026-09-23', IST).count, 0);

/* Typing a time in is an edit to the card: same date, same length, new hour. */
const retimed = setTimeOfDay(dayCards[0], '14:45', IST);
eq('a typed time lands on the same date', dateKey(retimed.start, IST), '2026-09-23');
eq('at the hour that was typed', fmtTime(retimed.start, { zone: IST }), '14:45');
eq('and the card keeps its length', retimed.end - retimed.start, dayCards[0].end - dayCards[0].start);

/* A time typed while looking at somebody else's clock means that clock. */
const inLondon = setTimeOfDay(dayCards[0], '09:00', LON);
eq('a time typed in another zone is read in that zone',
   fmtTime(inLondon.start, { zone: LON }), '09:00');

const stretched = setDuration(dayCards[0], 25);
eq('a new length moves only the end', stretched.start, dayCards[0].start);
eq('and it is the length that was asked for', stretched.end - stretched.start, 25 * MIN);
ok('a length can never be zero', setDuration(dayCards[0], 0).end > setDuration(dayCards[0], 0).start);

const nudged = shiftBy(dayCards[0], -15);
eq('a nudge moves the whole card', nudged.start, dayCards[0].start - 15 * MIN);
eq('keeping its length', nudged.end - nudged.start, dayCards[0].end - dayCards[0].start);

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

/** UX India — Itinerary. Eight people, five origins, three time zones,
 *  Bengaluru, 20–30 September 2026.
 *
 *  This is a transcription of a FigJam board, not an invention. Where the board
 *  states something — a flight number, a check-in time, a room booking — it is
 *  recorded as `confirmed`. Where the board is blank, contradicts itself or
 *  carries a question mark, the segment is `tentative` and its note says what
 *  the board actually said, so nobody has to guess later which parts were real.
 *
 *  Two known conflicts, resolved here and flagged in the notes:
 *    · The travel table and the schedule board disagree about whether a time is
 *      a departure or a landing. Where both give the same number (Priya) it is
 *      read as the landing, because the check-in that follows it only works
 *      that way; where they differ (Faizan) the table is the departure and the
 *      board is the landing.
 *    · Shri's fly-out is 6E 6583 at 10:40 in the table but "8:00 am" on the
 *      board. 8:00 is read as the run to the airport, 10:40 as the flight. */

import type { Group, Idea, Person, Place, Segment, Sticky, Trip } from '../core/types';
import { MIN, parseLocal } from '../core/time';
import { uid } from '../core/store';

const IST = 'Asia/Kolkata';

const place = (
  id: string, name: string, kind: Place['kind'], lat: number, lon: number,
  timezone: string, extra: Partial<Place> = {},
): Place => ({ id, name, kind, lat, lon, timezone, ...extra });

/* ---------- places ----------
 * Coordinates are good enough to drive the map and the travel estimates, and
 * no better. The three marked "check the branch" are chains with more than one
 * Bengaluru outlet and the board never said which. */

export const PLACES: Place[] = [
  // Bengaluru — the working set
  place('blr', 'Kempegowda International Airport', 'airport', 13.1986, 77.7066, IST, { code: 'BLR', address: 'Devanahalli, Bengaluru', dwellMin: 45, notes: 'Terminal 2 for the Virgin Atlantic and Singapore Airlines departures.' }),
  place('leela', 'The Leela Bhartiya City', 'hotel', 13.0787, 77.6396, IST, { address: 'Bhartiya City, Thanisandra Main Rd', notes: 'Everyone stays here. The board also lists it as a venue, so the 23–27 sessions are placed here — see the sticky: Srishti Manipal is the other candidate and it was never settled.' }),
  place('goldfinch', 'Goldfinch Bangalore', 'hotel', 13.0270, 77.6370, IST, { notes: 'Shri only, nights of 22–24 Sep. Exact property not recorded on the board — confirm which Goldfinch before booking a cab to it.' }),
  place('wework', 'WeWork Manyata Redwood', 'office', 13.0435, 77.6202, IST, { address: 'Embassy Manyata Business Park, Nagavara', url: 'https://wework.co.in', notes: 'Meeting Room 9A, booked and paid for 28 and 29 Sep, 10:30–15:30 IST. Confirmed by Vaisnavi Virakthamath (Associate, Community).' }),
  place('srishti', 'Srishti Manipal Institute of Art, Design and Technology', 'venue', 13.1007, 77.5963, IST, { address: 'Yelahanka New Town', notes: 'Listed as a venue on the board. Nothing was ever scheduled against it.' }),

  // Evenings and outings the board actually named
  place('iskcon', 'ISKCON Temple Bangalore', 'temple', 13.0098, 77.5510, IST, { address: 'Hare Krishna Hill, Rajajinagar', url: 'https://www.iskconbangalore.org/', dwellMin: 120, notes: 'On the board as "temple visit for Marky", then scheduled into the workshop evening.' }),
  place('bigbrewsky', 'Big Brewsky', 'bar', 13.0480, 77.6420, IST, { address: 'Hennur', dwellMin: 150, notes: 'Check the branch — Hennur is the one near the hotel; the other is Sarjapur Road, an hour further out.' }),
  place('rameshwaram', 'Rameshwaram Cafe', 'restaurant', 13.0560, 77.5910, IST, { address: 'Sahakar Nagar', dwellMin: 75, notes: 'Check the branch. Starred on the board as the food to have.' }),
  place('beansbrew', 'Beans & Brew', 'restaurant', 13.0450, 77.6210, IST, { dwellMin: 90, notes: 'Named on the board as a dinner candidate. No address recorded.' }),
  place('gopicklers', 'Go Picklers', 'other', 13.1050, 77.5930, IST, { address: 'Yelahanka, near Northstar', url: 'https://maps.app.goo.gl/YKBpwVHVQzby7wTY6', dwellMin: 120, notes: '600/- per hour before 18:00, 700/- after. Basic training included. Contact 9880077388.' }),
  place('snoopypaws', 'Snoopy Paws Cafe', 'restaurant', 13.0100, 77.6400, IST, { url: 'https://maps.app.goo.gl/omhitFyy5kR5p8Gw7', dwellMin: 90, notes: 'Dog cafe. Location approximate — the board only left a Maps link.' }),
  place('palace', 'Bangalore Palace', 'landmark', 12.9987, 77.5921, IST, { url: 'https://karnatakatourism.org/en/attractions/bangalore-palace/', dwellMin: 90 }),

  // The drive-time list from the board, kept with its own numbers
  place('shivoham', 'Shivoham Shiva Temple', 'temple', 12.9585, 77.6410, IST, { dwellMin: 60, notes: '~15–17 km, ~30–40 min drive.' }),
  place('ragigudda', 'Ragigudda Sri Prasanna Anjaneya Swamy Temple', 'temple', 12.9128, 77.5935, IST, { dwellMin: 60, notes: '~22–25 km, ~45–60 min drive.' }),
  place('mapmuseum', 'MAP — Museum of Art & Photography', 'landmark', 12.9718, 77.5960, IST, { dwellMin: 120, notes: '~15–17 km, ~35–45 min drive.' }),
  place('vitm', 'Visvesvaraya Industrial & Technological Museum', 'landmark', 12.9757, 77.5963, IST, { dwellMin: 90, notes: '~14–16 km, ~30–40 min drive.' }),
  place('tipu', "Tipu Sultan's Summer Palace", 'landmark', 12.9591, 77.5738, IST, { dwellMin: 60, notes: '~17–19 km, ~35–45 min drive.' }),
  place('lalbagh', 'Lalbagh Botanical Garden', 'landmark', 12.9507, 77.5848, IST, { dwellMin: 90, notes: '~17–19 km, ~35–45 min drive.' }),

  // Ruled out on the board, kept so the decision is legible
  place('lepakshi', 'Lepakshi Temple + Adiyogi Statue', 'temple', 13.8053, 77.6072, IST, { dwellMin: 600, notes: 'Ten-hour day trip out of state, pickup included. Voted down on the board.' }),
  place('bannerghatta', 'Bannerghatta Biological Park', 'landmark', 12.8000, 77.5770, IST, { url: 'https://bannerughattabiopark.org/', dwellMin: 300, notes: 'With the butterfly park and jungle safari. Voted down on the board.' }),

  // Origin and connecting airports
  place('lhr', 'London — Heathrow', 'airport', 51.4700, -0.4543, 'Europe/London', { code: 'LHR' }),
  place('tpe', 'Taipei — Taoyuan', 'airport', 25.0777, 121.2328, 'Asia/Taipei', { code: 'TPE' }),
  place('del', 'Delhi — Indira Gandhi Intl', 'airport', 28.5562, 77.1000, IST, { code: 'DEL' }),
  place('mnl', 'Manila — Ninoy Aquino', 'airport', 14.5086, 121.0194, 'Asia/Manila', { code: 'MNL' }),
  place('sin', 'Singapore — Changi', 'airport', 1.3644, 103.9915, 'Asia/Singapore', { code: 'SIN' }),
  place('gox', 'Goa — Manohar Intl (Mopa)', 'airport', 15.7430, 73.8630, IST, { code: 'GOX' }),
];

/* ---------- people ---------- */

export const PEOPLE: Person[] = [
  { id: 'p-tim',     name: 'Tim Moore',      homeCity: 'United Kingdom', homeTimezone: 'Europe/London', homeLat: 51.5074, homeLon: -0.1278,  color: '#ff9f1c', groupIds: ['g-lead', 'g-leela'], interests: ['leadership'], notes: 'Director, UX. Board records the country but not the city — Heathrow assumed for the flights.' },
  { id: 'p-james',   name: 'James Smith',    homeCity: 'London',         homeTimezone: 'Europe/London', homeLat: 51.5074, homeLon: -0.1278,  color: '#4cc9f0', groupIds: ['g-lead', 'g-leela'], interests: ['street food', 'research'], notes: 'Lead UX Researcher. Left the starred food list on the board.' },
  { id: 'p-chi',     name: 'Kuang Shih-Chi', homeCity: 'Taipei',         homeTimezone: 'Asia/Taipei',   homeLat: 25.0330, homeLon: 121.5654, color: '#b388ff', groupIds: ['g-lead', 'g-leela'], interests: ['design'], notes: 'Sr. UX Designer. Appears on the board as "Chi".' },
  { id: 'p-priya',   name: 'Priya Singh',    homeCity: 'New Delhi',      homeTimezone: IST,             homeLat: 28.6139, homeLon: 77.2090,  color: '#ff5c8a', groupIds: ['g-lead', 'g-leela'], interests: ['temples', 'sightseeing', 'pickleball'], notes: 'Sr. UX Designer, and the author of most of the board.' },
  { id: 'p-marky',   name: 'Mark Palmares',  homeCity: 'Manila',         homeTimezone: 'Asia/Manila',   homeLat: 14.5995, homeLon: 120.9842, color: '#ffd166', groupIds: ['g-rise', 'g-leela'], interests: ['temples'], notes: 'UX Researcher. Asked for the temple visit. On the board as "Marky".' },
  { id: 'p-francis', name: 'Francis Alba',   homeCity: 'Manila',         homeTimezone: 'Asia/Manila',   homeLat: 14.5995, homeLon: 120.9842, color: '#00d68f', groupIds: ['g-rise', 'g-leela'], interests: ['research'], notes: 'UX Researcher.' },
  { id: 'p-faizan',  name: 'Faizan Ali',     homeCity: 'New Delhi',      homeTimezone: IST,             homeLat: 28.6139, homeLon: 77.2090,  color: '#14d4c4', groupIds: ['g-rise', 'g-leela'], interests: ['design'], notes: 'UX Designer.' },
  { id: 'p-shri',    name: 'Srinidhi Bhat',  homeCity: 'Panaji, Goa',    homeTimezone: IST,             homeLat: 15.4909, homeLon: 73.8278,  color: '#f77f00', groupIds: ['g-rise', 'g-leela', 'g-goldfinch'], interests: ['temples', 'design'], notes: 'UX Designer. On the board as "Shri" and "Sri". Only person who changes hotel mid-trip.' },
];

const LEAD = ['p-tim', 'p-chi', 'p-james', 'p-priya'];
const RISE = ['p-marky', 'p-francis', 'p-faizan', 'p-shri'];

export const GROUPS: Group[] = [
  { id: 'g-lead', name: 'Leadership Summit · 23–25 Sep', kind: 'track', color: '#ff5c8a', memberIds: LEAD, description: 'Named on the board: Tim, Chi, James and Priya.' },
  { id: 'g-rise', name: 'Rising Leaders · 26–27 Sep', kind: 'track', color: '#4cc9f0', memberIds: RISE, description: 'The board says "Rising Leaders (Rest)" — everyone not on the Leadership Summit.' },
  { id: 'g-leela', name: 'Hotel · The Leela Bhartiya City', kind: 'hotel', color: '#b388ff', memberIds: [...LEAD, ...RISE], placeId: 'leela' },
  { id: 'g-goldfinch', name: 'Hotel · Goldfinch Bangalore', kind: 'hotel', color: '#ffd166', memberIds: ['p-shri'], placeId: 'goldfinch', description: 'Shri only, 22–24 Sep, before moving to The Leela.' },
];

/* ---------- segment builder ---------- */

let n = 0;
const sid = () => `seg_ux_${(n++).toString(36).padStart(3, '0')}`;

interface Sp {
  title: string; kind: Segment['kind']; date: string; from: string; to: string; zone?: string;
  place?: string; fromPlace?: string; toPlace?: string; who?: string[]; groups?: string[]; everyone?: boolean;
  notes?: string; tags?: string[]; status?: Segment['status']; flight?: Segment['flight'];
  travelMode?: NonNullable<Segment['travel']>['mode']; endDate?: string; endZone?: string; url?: string;
}

function seg(s: Sp): Segment {
  const zone = s.zone ?? IST;
  const start = parseLocal(s.date, s.from, zone);
  const end = parseLocal(s.endDate ?? s.date, s.to, s.endZone ?? zone);
  return {
    id: sid(),
    title: s.title,
    kind: s.kind,
    start,
    end: end > start ? end : end + 24 * 60 * MIN,
    timezone: zone,
    placeId: s.place,
    fromPlaceId: s.fromPlace,
    toPlaceId: s.toPlace,
    attendeeIds: s.who ?? [],
    groupIds: s.groups ?? [],
    everyone: s.everyone,
    status: s.status ?? 'confirmed',
    notes: s.notes,
    url: s.url,
    tags: s.tags ?? [],
    flight: s.flight,
    travel: s.travelMode ? { mode: s.travelMode, distanceKm: 0, baseMin: 0, trafficFactor: 1, source: 'estimate' } : undefined,
  };
}

/** One full conference day. The board draws these as a single "Full Day" block
 *  with a lunch icon on it; they are split three ways here so the break is
 *  somewhere a dinner or a cab can be hung off. */
function fullDay(date: string, label: string, who: string[], group: string, place: string): Segment[] {
  return [
    seg({ title: `${label} · morning`, kind: 'session', date, from: '09:00', to: '12:30', place, who, groups: [group], tags: ['conference'] }),
    seg({ title: 'Lunch', kind: 'meal', date, from: '12:30', to: '13:30', place, who, tags: ['conference'] }),
    seg({ title: `${label} · afternoon`, kind: 'session', date, from: '13:30', to: '17:00', place, who, groups: [group], tags: ['conference'] }),
  ];
}

/* ---------- the plan ---------- */

export const SEGMENTS: Segment[] = [
  /* ===== 19–20 Sep · Tim and Chi land first =====
   * The schedule board hangs Tim and Chi off the 20th with no times at all;
   * the calendar sketch puts the pair at about 08:00. Both legs below are
   * reconstructed backwards from that and are tentative until booked. */
  seg({ title: 'London → Bengaluru', kind: 'flight', date: '2026-09-19', from: '17:45', endDate: '2026-09-20', to: '08:00',
        zone: 'Europe/London', endZone: IST, fromPlace: 'lhr', toPlace: 'blr', who: ['p-tim'], status: 'tentative',
        tags: ['inbound'], notes: 'Board records only that Tim lands on the 20th. Carrier, number and departure time still to be filled in — the 08:00 landing is from the calendar sketch.' }),
  seg({ title: 'Taipei → Bengaluru', kind: 'flight', date: '2026-09-19', from: '23:00', endDate: '2026-09-20', to: '08:00',
        zone: 'Asia/Taipei', endZone: IST, fromPlace: 'tpe', toPlace: 'blr', who: ['p-chi'], status: 'tentative',
        tags: ['inbound'], notes: 'Same as Tim: only the 20th is recorded. Shown as one leg, but Taipei to Bengaluru will be a connection — replace this with the real routing once it is booked.' }),
  seg({ title: 'Airport transfer → The Leela', kind: 'transfer', date: '2026-09-20', from: '08:45', to: '09:30',
        fromPlace: 'blr', toPlace: 'leela', who: ['p-tim', 'p-chi'], travelMode: 'taxi', status: 'tentative', tags: ['transfer'] }),
  seg({ title: 'Check in · The Leela Bhartiya City', kind: 'checkin', date: '2026-09-20', from: '09:30', to: '10:15',
        place: 'leela', who: ['p-tim', 'p-chi'], status: 'tentative', tags: ['hotel'],
        notes: 'A morning landing means an early check-in. Confirm it with the hotel or they sit in the lobby until 14:00.' }),

  /* ===== 22 Sep · James, Priya and Shri ===== */
  seg({ title: 'London → Bengaluru', kind: 'flight', date: '2026-09-21', from: '22:00', endDate: '2026-09-22', to: '12:55',
        zone: 'Europe/London', endZone: IST, fromPlace: 'lhr', toPlace: 'blr', who: ['p-james'], status: 'tentative',
        tags: ['inbound'], notes: 'The 12:55 landing is from the board. The departure is reconstructed — no carrier or number was recorded for the inbound leg.' }),
  seg({ title: 'Airport transfer → The Leela', kind: 'transfer', date: '2026-09-22', from: '13:40', to: '14:25',
        fromPlace: 'blr', toPlace: 'leela', who: ['p-james'], travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'Check in · The Leela Bhartiya City', kind: 'checkin', date: '2026-09-22', from: '14:25', to: '15:05',
        place: 'leela', who: ['p-james'], tags: ['hotel'] }),

  seg({ title: 'Air India · Delhi → Bengaluru', kind: 'flight', date: '2026-09-22', from: '16:00', to: '18:45',
        fromPlace: 'del', toPlace: 'blr', who: ['p-priya'],
        flight: { carrier: 'Air India', number: 'TBC', fromCode: 'DEL', toCode: 'BLR' }, tags: ['inbound'],
        notes: 'Board gives 18:45 against the Air India fly-in and 21:00 for check-in, so 18:45 is read as the landing and the Delhi departure is worked back from it. Flight number still to be added.' }),
  seg({ title: 'Airport transfer → The Leela', kind: 'transfer', date: '2026-09-22', from: '19:30', to: '20:30',
        fromPlace: 'blr', toPlace: 'leela', who: ['p-priya'], travelMode: 'taxi', tags: ['transfer'],
        notes: 'Lands into the evening peak — allow the extra time.' }),
  seg({ title: 'Check in · The Leela Bhartiya City', kind: 'checkin', date: '2026-09-22', from: '21:00', to: '21:40',
        place: 'leela', who: ['p-priya'], tags: ['hotel'] }),

  seg({ title: 'Goa → Bengaluru', kind: 'flight', date: '2026-09-22', from: '18:30', to: '19:40',
        fromPlace: 'gox', toPlace: 'blr', who: ['p-shri'], status: 'tentative', tags: ['inbound'],
        notes: 'Board records 19:40 on the 22nd and nothing else. The fly-out is IndiGo from Mopa, so an IndiGo inbound from the same airport is the likely pair — confirm.' }),
  seg({ title: 'Airport transfer → Goldfinch', kind: 'transfer', date: '2026-09-22', from: '20:25', to: '22:00',
        fromPlace: 'blr', toPlace: 'goldfinch', who: ['p-shri'], travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'Check in · Goldfinch Bangalore', kind: 'checkin', date: '2026-09-22', from: '22:00', to: '22:40',
        place: 'goldfinch', who: ['p-shri'], tags: ['hotel'], notes: 'Board says "22nd night, about 10pm". Three nights here, then The Leela from the 25th.' }),

  /* ===== 23–25 Sep · Leadership Summit ===== */
  ...fullDay('2026-09-23', 'Leadership Summit', LEAD, 'g-lead', 'leela'),
  ...fullDay('2026-09-24', 'Leadership Summit', LEAD, 'g-lead', 'leela'),
  ...fullDay('2026-09-25', 'Leadership Summit', LEAD, 'g-lead', 'leela'),
  seg({ title: 'Open day — nothing scheduled', kind: 'free', date: '2026-09-23', from: '10:00', to: '18:00',
        who: ['p-shri'], status: 'tentative', tags: ['free'],
        notes: 'Shri is in Bengaluru from the 22nd but his track does not start until the 26th. The board leaves the 23rd and 24th blank for him.' }),

  /* ===== 24 Sep · Marky and Francis ===== */
  seg({ title: 'Singapore Airlines · Manila → Singapore', kind: 'flight', date: '2026-09-24', from: '14:00', to: '17:45',
        zone: 'Asia/Manila', endZone: 'Asia/Singapore', fromPlace: 'mnl', toPlace: 'sin', who: ['p-francis', 'p-marky'],
        flight: { carrier: 'Singapore Airlines', number: 'TBC', fromCode: 'MNL', toCode: 'SIN' }, tags: ['inbound'],
        notes: 'Francis is recorded as Singapore Airlines departing 14:00 on the 24th. Marky has no booking on the board but lands at the same 21:50, so he is shown on the same routing — confirm his ticket.' }),
  seg({ title: 'Singapore Airlines · Singapore → Bengaluru', kind: 'flight', date: '2026-09-24', from: '19:50', to: '21:50',
        zone: 'Asia/Singapore', endZone: IST, fromPlace: 'sin', toPlace: 'blr', who: ['p-francis', 'p-marky'],
        flight: { carrier: 'Singapore Airlines', number: 'TBC', fromCode: 'SIN', toCode: 'BLR' }, tags: ['inbound'],
        notes: 'Two-hour connection at Changi. The 21:50 landing is the board figure for both of them.' }),
  seg({ title: 'Airport transfer → The Leela', kind: 'transfer', date: '2026-09-24', from: '22:30', to: '23:00',
        fromPlace: 'blr', toPlace: 'leela', who: ['p-francis', 'p-marky'], travelMode: 'taxi', tags: ['transfer'],
        notes: 'Late enough that the roads are clear.' }),
  seg({ title: 'Check in · The Leela Bhartiya City', kind: 'checkin', date: '2026-09-24', from: '23:00', to: '23:40',
        place: 'leela', who: ['p-francis', 'p-marky'], tags: ['hotel'], notes: 'Francis is recorded at 23:00 on the 24th; Marky follows him in.' }),

  /* ===== 25 Sep · Faizan lands, Shri changes hotel ===== */
  seg({ title: 'Check out · Goldfinch Bangalore', kind: 'checkout', date: '2026-09-25', from: '11:00', to: '11:30',
        place: 'goldfinch', who: ['p-shri'], tags: ['hotel'] }),
  seg({ title: 'Goldfinch → The Leela', kind: 'transfer', date: '2026-09-25', from: '11:30', to: '12:20',
        fromPlace: 'goldfinch', toPlace: 'leela', who: ['p-shri'], travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'Check in · The Leela Bhartiya City', kind: 'checkin', date: '2026-09-25', from: '14:00', to: '14:40',
        place: 'leela', who: ['p-shri'], tags: ['hotel'],
        notes: 'Standard check-in is 14:00, so there is an hour and a half to fill after the Goldfinch checkout. Bags can go to the desk.' }),
  seg({ title: 'Air India · Delhi → Bengaluru', kind: 'flight', date: '2026-09-25', from: '15:00', to: '18:00',
        fromPlace: 'del', toPlace: 'blr', who: ['p-faizan'],
        flight: { carrier: 'Air India', number: 'TBC', fromCode: 'DEL', toCode: 'BLR' }, tags: ['inbound'],
        notes: 'Table gives the 15:00 Delhi departure, the schedule board gives the 18:00 landing — the two agree.' }),
  seg({ title: 'Airport transfer → The Leela', kind: 'transfer', date: '2026-09-25', from: '18:45', to: '19:45',
        fromPlace: 'blr', toPlace: 'leela', who: ['p-faizan'], travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'Check in · The Leela Bhartiya City', kind: 'checkin', date: '2026-09-25', from: '19:45', to: '20:25',
        place: 'leela', who: ['p-faizan'], tags: ['hotel'] }),

  /* ===== 26–27 Sep · Rising Leaders ===== */
  ...fullDay('2026-09-26', 'Rising Leaders', RISE, 'g-rise', 'leela'),
  ...fullDay('2026-09-27', 'Rising Leaders', RISE, 'g-rise', 'leela'),
  seg({ title: 'Open day — no track', kind: 'free', date: '2026-09-26', from: '10:00', to: '18:00',
        who: LEAD, status: 'tentative', tags: ['free'],
        notes: 'The Leadership Summit four have nothing on the board for the 26th and 27th. The backlog is where to look: Bangalore Palace, pickleball, the museums, the temple list.' }),
  seg({ title: 'Open day — no track', kind: 'free', date: '2026-09-27', from: '10:00', to: '18:00',
        who: LEAD, status: 'tentative', tags: ['free'] }),
  seg({ title: 'Common UX team dinner', kind: 'meal', date: '2026-09-26', from: '19:30', to: '22:00',
        everyone: true, status: 'tentative', tags: ['social'],
        notes: 'First evening all eight are in the city. The board pins the dinner but never a place — its own shortlist was Big Brewsky, Beans & Brew and Rameshwaram Cafe.' }),

  /* ===== 28 Sep · workshop day 1, WeWork Manyata Redwood ===== */
  seg({ title: 'The Leela → WeWork Manyata', kind: 'transfer', date: '2026-09-28', from: '09:45', to: '10:25',
        fromPlace: 'leela', toPlace: 'wework', everyone: true, travelMode: 'taxi', tags: ['transfer'],
        notes: 'Morning peak across Thanisandra to Nagavara. Room 9A is held from 10:30.' }),
  seg({ title: 'Company goals & values · Tim and Chi', kind: 'workshop', date: '2026-09-28', from: '10:30', to: '12:30',
        place: 'wework', everyone: true, tags: ['workshop'], notes: 'Two hours, as written on the board. Tim and Chi presenting.' }),
  seg({ title: 'Lunch', kind: 'meal', date: '2026-09-28', from: '12:30', to: '13:30', everyone: true, status: 'tentative', tags: ['workshop'],
        notes: 'Place still open — the board says "Lunch Place:?". Walkable from Room 9A: Nasi and Mee, Yoichi, Bombay Brasserie, Lola’s All Day, Toscano and Sriracha in Manyata Tech Park; Nagavara SOCIAL, Bombay Curry House, Biryani Zest, Neo Kitchen by Hilton, The Food Fusion Cafe and F5 in Embassy Manyata.' }),
  seg({ title: 'Fun activities · ice breaker', kind: 'activity', date: '2026-09-28', from: '13:30', to: '14:30',
        place: 'wework', everyone: true, tags: ['workshop'] }),
  seg({ title: 'Tea & snacks · on venue', kind: 'meal', date: '2026-09-28', from: '14:30', to: '14:45',
        place: 'wework', everyone: true, tags: ['workshop'] }),
  seg({ title: 'Team building discussion', kind: 'workshop', date: '2026-09-28', from: '14:45', to: '15:30',
        place: 'wework', everyone: true, tags: ['workshop'], notes: 'Room 9A is booked until 15:30.' }),
  seg({ title: 'WeWork → ISKCON Temple', kind: 'transfer', date: '2026-09-28', from: '15:45', to: '16:30',
        fromPlace: 'wework', toPlace: 'iskcon', everyone: true, travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'ISKCON Temple', kind: 'activity', date: '2026-09-28', from: '16:30', to: '19:00',
        place: 'iskcon', everyone: true, tags: ['temple'], url: 'https://www.iskconbangalore.org/',
        notes: 'Marky asked for this one and the workshop itinerary places it here. Shoes and phones go into the lockers at the entrance.' }),
  seg({ title: 'ISKCON → Big Brewsky', kind: 'transfer', date: '2026-09-28', from: '19:00', to: '20:45',
        fromPlace: 'iskcon', toPlace: 'bigbrewsky', everyone: true, travelMode: 'taxi', tags: ['transfer'],
        notes: 'Rajajinagar back across to Hennur in the evening peak — this is the long one of the trip.' }),
  seg({ title: 'Team dinner · Big Brewsky', kind: 'meal', date: '2026-09-28', from: '21:00', to: '23:30',
        place: 'bigbrewsky', everyone: true, tags: ['social'], notes: 'No reservation recorded on the board. Eight people on a Monday night — worth calling ahead.' }),

  /* ===== 29 Sep · workshop day 2 ===== */
  seg({ title: 'The Leela → WeWork Manyata', kind: 'transfer', date: '2026-09-29', from: '09:45', to: '10:25',
        fromPlace: 'leela', toPlace: 'wework', everyone: true, travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'Hack day · research and design integration', kind: 'workshop', date: '2026-09-29', from: '10:30', to: '12:30',
        place: 'wework', everyone: true, tags: ['workshop'],
        notes: 'Purpose on the board is "research and design integration". The topic itself is still a question mark.' }),
  seg({ title: 'Lunch', kind: 'meal', date: '2026-09-29', from: '12:30', to: '13:30', everyone: true, status: 'tentative', tags: ['workshop'],
        notes: 'Same open question as day one, same shortlist around Manyata.' }),
  seg({ title: 'Hack day · continued', kind: 'workshop', date: '2026-09-29', from: '13:30', to: '14:30',
        place: 'wework', everyone: true, tags: ['workshop'] }),
  seg({ title: 'Tea & snacks · on venue', kind: 'meal', date: '2026-09-29', from: '14:30', to: '14:45',
        place: 'wework', everyone: true, tags: ['workshop'] }),
  seg({ title: 'Fun activities · ice breaker', kind: 'activity', date: '2026-09-29', from: '14:45', to: '15:30',
        place: 'wework', everyone: true, tags: ['workshop'] }),
  seg({ title: 'WeWork → Rameshwaram Cafe', kind: 'transfer', date: '2026-09-29', from: '15:45', to: '16:15',
        fromPlace: 'wework', toPlace: 'rameshwaram', everyone: true, travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'Rameshwaram Cafe · snacks and window shopping', kind: 'activity', date: '2026-09-29', from: '16:15', to: '18:00',
        place: 'rameshwaram', everyone: true, tags: ['food'], notes: 'Straight off the calendar sketch. Standing room only at peak — it moves fast.' }),
  seg({ title: 'Team dinner · place to confirm', kind: 'meal', date: '2026-09-29', from: '20:00', to: '22:30',
        everyone: true, status: 'tentative', tags: ['social'],
        notes: 'The board draws this one as an outline rather than a filled note, and the workshop itinerary says only "Dinner: Together?". Last night for everyone.' }),

  /* ===== 30 Sep · check out, and eight people go six ways ===== */
  seg({ title: 'Check out · The Leela Bhartiya City', kind: 'checkout', date: '2026-09-30', from: '04:00', to: '04:15',
        place: 'leela', who: ['p-james'], tags: ['hotel'], notes: 'Board says "30th, about 4am" — an early start for the 08:00 flight.' }),
  seg({ title: 'The Leela → BLR Terminal 2', kind: 'transfer', date: '2026-09-30', from: '04:15', to: '05:00',
        fromPlace: 'leela', toPlace: 'blr', who: ['p-james'], travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'Virgin Atlantic · Bengaluru → London', kind: 'flight', date: '2026-09-30', from: '08:00', to: '13:15',
        zone: IST, endZone: 'Europe/London', fromPlace: 'blr', toPlace: 'lhr', who: ['p-james'],
        flight: { carrier: 'Virgin Atlantic', number: 'TBC', fromCode: 'BLR', toCode: 'LHR', terminal: 'T2' }, tags: ['outbound'],
        notes: 'Board records Virgin Atlantic from Terminal 2 at 08:00 and separately asks "08:00 AM/PM?". The 4am checkout settles it as morning. Flight number still to be added.' }),

  seg({ title: 'Check out · The Leela Bhartiya City', kind: 'checkout', date: '2026-09-30', from: '07:00', to: '07:20',
        place: 'leela', who: ['p-priya', 'p-shri'], tags: ['hotel'], notes: 'Both recorded at about 07:00.' }),
  seg({ title: 'The Leela → BLR airport', kind: 'transfer', date: '2026-09-30', from: '08:00', to: '08:50',
        fromPlace: 'leela', toPlace: 'blr', who: ['p-priya', 'p-shri'], travelMode: 'taxi', tags: ['transfer'],
        notes: 'The board’s "Sri: 8:00 am" read as the run to the airport rather than a flight. Priya is on the same hour, so one cab does both.' }),
  seg({ title: 'Air India · Bengaluru → Delhi', kind: 'flight', date: '2026-09-30', from: '10:00', to: '12:50',
        fromPlace: 'blr', toPlace: 'del', who: ['p-priya'],
        flight: { carrier: 'Air India', number: 'TBC', fromCode: 'BLR', toCode: 'DEL' }, tags: ['outbound'],
        notes: 'Seventy minutes between the cab arriving and the gate — fine for domestic, but it is the tightest connection on the trip.' }),
  seg({ title: '6E 6583 · Bengaluru → Goa (Mopa)', kind: 'flight', date: '2026-09-30', from: '10:40', to: '11:45',
        fromPlace: 'blr', toPlace: 'gox', who: ['p-shri'],
        flight: { carrier: 'IndiGo', number: '6E 6583', fromCode: 'BLR', toCode: 'GOX' }, tags: ['outbound'],
        notes: 'The one fully booked flight on the board, number and all.' }),

  seg({ title: 'Check out · The Leela Bhartiya City', kind: 'checkout', date: '2026-09-30', from: '10:00', to: '10:20',
        place: 'leela', who: ['p-tim'], status: 'tentative', tags: ['hotel'],
        notes: 'Board says only "Check-out ALL". Set back from the 13:00 flight.' }),
  seg({ title: 'The Leela → BLR airport', kind: 'transfer', date: '2026-09-30', from: '10:20', to: '11:20',
        fromPlace: 'leela', toPlace: 'blr', who: ['p-tim'], travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'Bengaluru → London', kind: 'flight', date: '2026-09-30', from: '13:00', to: '18:15',
        zone: IST, endZone: 'Europe/London', fromPlace: 'blr', toPlace: 'lhr', who: ['p-tim'], status: 'tentative',
        tags: ['outbound'], notes: 'Board gives 13:00 and no airline.' }),

  seg({ title: 'Check out · The Leela Bhartiya City', kind: 'checkout', date: '2026-09-30', from: '11:00', to: '11:20',
        place: 'leela', who: ['p-chi', 'p-faizan'], status: 'tentative', tags: ['hotel'],
        notes: 'Neither has a departure time on the board, so this is set at the hotel’s usual checkout.' }),
  seg({ title: 'Chi · departure not recorded', kind: 'note', date: '2026-09-30', from: '12:00', to: '13:00',
        who: ['p-chi'], status: 'tentative', tags: ['gap'],
        notes: 'The board leaves Chi’s fly-out blank — hotel and booking status only. Needs a carrier, a number and a time before this itinerary is finished.' }),
  seg({ title: 'Faizan · IndiGo home, time not recorded', kind: 'note', date: '2026-09-30', from: '12:00', to: '13:00',
        who: ['p-faizan'], status: 'tentative', tags: ['gap'],
        notes: 'Table says IndiGo and nothing else. Delhi is the destination, the time is missing.' }),

  seg({ title: 'Check out · The Leela Bhartiya City', kind: 'checkout', date: '2026-09-30', from: '12:00', to: '12:20',
        place: 'leela', who: ['p-francis', 'p-marky'], tags: ['hotel'], notes: 'Francis is recorded at 12:00; Marky is on the same flight out.' }),
  seg({ title: 'Eleven hours between checkout and the flight', kind: 'free', date: '2026-09-30', from: '12:20', to: '20:00',
        who: ['p-francis', 'p-marky'], status: 'tentative', tags: ['gap'],
        notes: 'Noon checkout against a 23:05 departure. Either a day room at The Leela or bags at the desk and somewhere to be — this is the biggest hole in the plan.' }),
  seg({ title: 'The Leela → BLR Terminal 2', kind: 'transfer', date: '2026-09-30', from: '20:00', to: '21:15',
        fromPlace: 'leela', toPlace: 'blr', who: ['p-francis', 'p-marky'], travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'Singapore Airlines · Bengaluru → Singapore', kind: 'flight', date: '2026-09-30', from: '23:05', endDate: '2026-10-01', to: '06:10',
        zone: IST, endZone: 'Asia/Singapore', fromPlace: 'blr', toPlace: 'sin', who: ['p-francis', 'p-marky'],
        flight: { carrier: 'Singapore Airlines', number: 'TBC', fromCode: 'BLR', toCode: 'SIN' }, tags: ['outbound'],
        notes: 'Board records 23:05 for both. The onward Singapore to Manila leg was never written down.' }),
];

/* ---------- the backlog ----------
 * Everything the "Things to do in Bangalore" board collected, including the
 * two the group voted down. Those are kept deliberately: a backlog that only
 * holds the survivors makes people re-propose the same day trip in March. */

export const IDEAS: Idea[] = [
  { id: uid('idea'), title: 'Bangalore Palace', kind: 'activity', durationMin: 90, placeId: 'palace', attendeeIds: [], tags: ['sightseeing'], votes: ['p-priya'], notes: 'karnatakatourism.org/en/attractions/bangalore-palace — about 31 minutes from the hotel on the board’s own route.' },
  { id: uid('idea'), title: 'Pickleball at Go Picklers', kind: 'activity', durationMin: 120, placeId: 'gopicklers', attendeeIds: [], tags: ['sport'], votes: ['p-priya'], notes: '600/- per hour to 18:00, 700/- after. Basic training included. Contact 9880077388.' },
  { id: uid('idea'), title: 'Rameshwaram Cafe, vada pav, chaat, fire paan, chole bhature', kind: 'meal', durationMin: 120, placeId: 'rameshwaram', attendeeIds: [], tags: ['food'], votes: ['p-james'], notes: 'James’s list, starred on the board as the food to actually get. The Rameshwaram stop on the 29th covers part of it.' },
  { id: uid('idea'), title: 'Snoopy Paws Cafe — fun with dogs', kind: 'activity', durationMin: 90, placeId: 'snoopypaws', attendeeIds: [], tags: ['social'], votes: [], notes: 'Left on the board as a Maps link with no owner.' },
  { id: uid('idea'), title: 'Chai stop', kind: 'meal', durationMin: 45, attendeeIds: [], tags: ['food'], votes: ['p-priya'], notes: 'A note with one word on it. Fits in any gap.' },
  { id: uid('idea'), title: 'Trek', kind: 'activity', durationMin: 300, attendeeIds: [], tags: ['outdoors'], votes: ['p-priya'], notes: 'A pink note near the 24th–25th with nothing under it. Needs a hill, a day and a driver before it is real.' },
  { id: uid('idea'), title: 'UXR team session', kind: 'session', durationMin: 120, attendeeIds: ['p-james', 'p-francis', 'p-marky'], tags: ['work'], votes: [], notes: 'The board asks "UXR team?" beside the 24th–25th. Never answered — the three researchers are not all in the city until the evening of the 24th.' },
  { id: uid('idea'), title: 'Shivoham Shiva Temple', kind: 'activity', durationMin: 60, placeId: 'shivoham', attendeeIds: [], tags: ['temple'], votes: [], notes: '~15–17 km, ~30–40 min each way.' },
  { id: uid('idea'), title: 'Ragigudda Sri Prasanna Anjaneya Swamy Temple', kind: 'activity', durationMin: 60, placeId: 'ragigudda', attendeeIds: [], tags: ['temple'], votes: [], notes: '~22–25 km, ~45–60 min each way — the furthest on the list.' },
  { id: uid('idea'), title: 'MAP — Museum of Art & Photography', kind: 'activity', durationMin: 120, placeId: 'mapmuseum', attendeeIds: [], tags: ['culture'], votes: [], notes: '~15–17 km, ~35–45 min each way.' },
  { id: uid('idea'), title: 'Visvesvaraya Industrial & Technological Museum', kind: 'activity', durationMin: 90, placeId: 'vitm', attendeeIds: [], tags: ['culture'], votes: [], notes: '~14–16 km, ~30–40 min each way.' },
  { id: uid('idea'), title: "Tipu Sultan's Summer Palace", kind: 'activity', durationMin: 60, placeId: 'tipu', attendeeIds: [], tags: ['sightseeing'], votes: [], notes: '~17–19 km, ~35–45 min each way. Pairs with Lalbagh.' },
  { id: uid('idea'), title: 'Lalbagh Botanical Garden', kind: 'activity', durationMin: 90, placeId: 'lalbagh', attendeeIds: [], tags: ['garden'], votes: [], notes: '~17–19 km, ~35–45 min each way.' },
  { id: uid('idea'), title: 'Lepakshi Temple + Adiyogi statue day trip', kind: 'activity', durationMin: 600, placeId: 'lepakshi', attendeeIds: [], tags: ['excursion', 'ruled-out'], votes: [], notes: 'Ruled out on the board. Ten hours door to door: 2.5 h out, two hours at Lepakshi, 70 min across to the Adiyogi statue at Chikkaballapur, two hours there, then back. Pickup included.' },
  { id: uid('idea'), title: 'Bannerghatta bio park, butterfly park and jungle safari', kind: 'activity', durationMin: 300, placeId: 'bannerghatta', attendeeIds: [], tags: ['excursion', 'ruled-out'], votes: [], notes: 'Ruled out on the board. Wrong side of the city from everywhere else the group is.' },
];

/* ---------- what the board never settled ----------
 * Parked above the day frames rather than buried in a note on one card, because
 * every one of these blocks somebody else's decision. */

const note = (i: number, text: string, authorId?: string): Sticky => ({
  id: uid('sticky'),
  text,
  at: { x: i * 192, y: -220 },
  color: ['#ffb020', '#14d4c4', '#8b7cff', '#ff6b9d', '#a3e635'][i % 5],
  authorId,
});

export const STICKIES: Sticky[] = [
  note(0, 'Venue for 23–27 Sep is not settled. The Leela and Srishti Manipal are both listed; the sessions sit at The Leela here because that is where everyone sleeps.', 'p-priya'),
  note(1, 'Lunch place for both workshop days — still "?" on the board. Twelve options within walking distance of Room 9A are on the lunch cards.', 'p-priya'),
  note(2, 'Hack day topic, 29 Sep — still "?". Purpose is research and design integration.', 'p-priya'),
  note(3, 'Chi and Faizan have no fly-out times. Tim has a time but no airline. Four of the eight inbound legs have no carrier or number.', 'p-shri'),
  note(4, 'Sanjeev was removed from the trip on the board. Lucas only ever appears on the earlier Phase-2 plan and is not in the roster — neither is included here.', 'p-shri'),
  note(5, 'Francis and Marky check out at noon on the 30th and fly at 23:05. Day room, or bags at the desk and a plan for the afternoon.', 'p-priya'),
];

export function uxIndiaTrip(): Trip {
  return {
    id: 'trip-ux-india-2026',
    name: 'UX India — Itinerary',
    subtitle: '8 people · 5 origins · 3 time zones · Bengaluru, 20–30 Sep 2026',
    startDate: '2026-09-19',
    endDate: '2026-10-01',
    baseTimezone: IST,
    currency: 'INR',
    places: PLACES,
    people: PEOPLE,
    groups: GROUPS,
    segments: SEGMENTS,
    branches: [],
    links: [],
    stickies: STICKIES,
    frames: [],
    ideas: IDEAS,
    updatedAt: Date.now(),
    schemaVersion: 1,
  };
}

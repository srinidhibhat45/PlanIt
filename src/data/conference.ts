/** A worked example: an 8-person conference in Bengaluru, Sept 2026.
 *
 *  Everything here is ordinary trip data — people, places, segments — so it
 *  demonstrates the model rather than special-casing it. Swap the host city,
 *  the dates and the roster and the same machinery runs a 40-person tour.
 *
 *  Two deliberate faults are baked in so the analyser has something to catch:
 *  Tom lands 15 minutes before a session he is expected at, and Diego arrives
 *  on a 05:20 red-eye with a full day in front of him. */

import type { Group, Idea, Person, Place, Segment, Trip } from '../core/types';
import { MIN, parseLocal } from '../core/time';
import { uid } from '../core/store';

const IST = 'Asia/Kolkata';

const place = (
  id: string, name: string, kind: Place['kind'], lat: number, lon: number,
  timezone: string, extra: Partial<Place> = {},
): Place => ({ id, name, kind, lat, lon, timezone, ...extra });

export const PLACES: Place[] = [
  // Host city
  place('blr', 'Kempegowda International Airport', 'airport', 13.1986, 77.7066, IST, { code: 'BLR', address: 'Devanahalli, Bengaluru', dwellMin: 45 }),
  place('venue', 'Bangalore International Centre', 'venue', 12.9606, 77.6387, IST, { address: '7 4th Main Rd, Domlur II Stage', notes: 'Main auditorium + two breakout rooms.' }),
  place('hotel-mg', 'The Oberoi', 'hotel', 12.9719, 77.6186, IST, { address: '37–39 MG Road', notes: 'Hotel A — central, walkable to bars.' }),
  place('hotel-west', 'Taj West End', 'hotel', 12.9853, 77.5854, IST, { address: 'Race Course Road', notes: 'Hotel B — garden campus, quieter.' }),

  // Evening options
  place('iskcon', 'ISKCON Temple', 'temple', 13.0098, 77.5510, IST, { address: 'Hare Krishna Hill, Rajajinagar', dwellMin: 75 }),
  place('bull-temple', 'Bull Temple (Dodda Basavana Gudi)', 'temple', 12.9426, 77.5675, IST, { address: 'Bugle Rock Rd, Basavanagudi', dwellMin: 45 }),
  place('someshwara', 'Halasuru Someshwara Temple', 'temple', 12.9800, 77.6270, IST, { address: 'Halasuru', dwellMin: 45 }),
  place('lalbagh', 'Lalbagh Botanical Garden', 'landmark', 12.9507, 77.5848, IST, { address: 'Mavalli', dwellMin: 90 }),
  place('cubbon', 'Cubbon Park', 'landmark', 12.9763, 77.5929, IST, { dwellMin: 60 }),
  place('palace', 'Bangalore Palace', 'landmark', 12.9987, 77.5921, IST, { dwellMin: 75 }),
  place('toit', 'Toit Brewpub', 'bar', 12.9784, 77.6408, IST, { address: '298 100 Feet Rd, Indiranagar', dwellMin: 150 }),
  place('arbor', 'Arbor Brewing Company', 'bar', 12.9689, 77.6088, IST, { address: '8 Magrath Rd', dwellMin: 150 }),
  place('vvpuram', 'VV Puram Food Street', 'restaurant', 12.9450, 77.5750, IST, { dwellMin: 90 }),
  place('mtr', 'Mavalli Tiffin Rooms', 'restaurant', 12.9459, 77.5847, IST, { address: 'Lalbagh Rd', dwellMin: 60 }),
  place('koshys', "Koshy's", 'restaurant', 12.9744, 77.5966, IST, { address: 'St Marks Rd', dwellMin: 75 }),
  place('commercial', 'Commercial Street', 'landmark', 12.9829, 77.6094, IST, { dwellMin: 90 }),
  place('nandi', 'Nandi Hills', 'landmark', 13.3702, 77.6835, IST, { notes: 'Sunrise trip — 60 km, leave by 04:30.', dwellMin: 120 }),

  // Origin airports
  place('goi', 'Goa — Dabolim', 'airport', 15.3808, 73.8314, IST, { code: 'GOI' }),
  place('del', 'Delhi — Indira Gandhi Intl', 'airport', 28.5562, 77.1000, IST, { code: 'DEL' }),
  place('tpe', 'Taipei — Taoyuan', 'airport', 25.0777, 121.2328, 'Asia/Taipei', { code: 'TPE' }),
  place('mnl', 'Manila — Ninoy Aquino', 'airport', 14.5086, 121.0194, 'Asia/Manila', { code: 'MNL' }),
  place('lhr', 'London — Heathrow', 'airport', 51.4700, -0.4543, 'Europe/London', { code: 'LHR' }),
  place('man', 'Manchester', 'airport', 53.3537, -2.2750, 'Europe/London', { code: 'MAN' }),
  place('sin', 'Singapore — Changi', 'airport', 1.3644, 103.9915, 'Asia/Singapore', { code: 'SIN' }),
  place('dxb', 'Dubai Intl', 'airport', 25.2532, 55.3657, 'Asia/Dubai', { code: 'DXB' }),
];

export const PEOPLE: Person[] = [
  { id: 'p-aarti',    name: 'Aarti Naik',      homeCity: 'Panaji, Goa',   homeTimezone: IST,               color: '#ff9f1c', groupIds: ['g-track-a', 'g-hotel-west'], interests: ['temples', 'food', 'photography'], email: 'aarti@example.com' },
  { id: 'p-rohan',    name: 'Rohan Mehra',     homeCity: 'New Delhi',     homeTimezone: IST,               color: '#4cc9f0', groupIds: ['g-track-a', 'g-hotel-mg'],   interests: ['pubs', 'live music'], email: 'rohan@example.com' },
  { id: 'p-yuchen',   name: 'Yu-Chen Lin',     homeCity: 'Taipei',        homeTimezone: 'Asia/Taipei',     color: '#b388ff', groupIds: ['g-track-a', 'g-hotel-west'], interests: ['temples', 'architecture', 'coffee'], email: 'yuchen@example.com' },
  { id: 'p-eleanor',  name: 'Eleanor Whitfield', homeCity: 'London',      homeTimezone: 'Europe/London',   color: '#00d68f', groupIds: ['g-track-a', 'g-hotel-mg'],   interests: ['pubs', 'gardens', 'markets'], email: 'eleanor@example.com' },
  { id: 'p-priya',    name: 'Priya Sethi',     homeCity: 'New Delhi',     homeTimezone: IST,               color: '#ff5c8a', groupIds: ['g-track-b', 'g-hotel-west'], interests: ['temples', 'art', 'shopping'], email: 'priya@example.com' },
  { id: 'p-mariel',   name: 'Mariel Santos',   homeCity: 'Manila',        homeTimezone: 'Asia/Manila',     color: '#ffd166', groupIds: ['g-track-b', 'g-hotel-mg'],   interests: ['pubs', 'food markets'], email: 'mariel@example.com', dietary: 'No pork' },
  { id: 'p-diego',    name: 'Diego Ramos',     homeCity: 'Manila',        homeTimezone: 'Asia/Manila',     color: '#7bd389', groupIds: ['g-track-b', 'g-hotel-mg'],   interests: ['history', 'temples'], email: 'diego@example.com' },
  { id: 'p-tom',      name: 'Tom Bradshaw',    homeCity: 'Manchester',    homeTimezone: 'Europe/London',   color: '#f77f00', groupIds: ['g-track-b', 'g-hotel-west'], interests: ['pubs', 'cricket', 'street food'], email: 'tom@example.com', dietary: 'Vegetarian' },
];

export const GROUPS: Group[] = [
  { id: 'g-track-a', name: 'Track A · 23–25 Sep', kind: 'track', color: '#4cc9f0', memberIds: ['p-aarti', 'p-rohan', 'p-yuchen', 'p-eleanor'], description: 'First half of the conference.' },
  { id: 'g-track-b', name: 'Track B · 26–27 Sep', kind: 'track', color: '#ff5c8a', memberIds: ['p-priya', 'p-mariel', 'p-diego', 'p-tom'], description: 'Second half of the conference.' },
  { id: 'g-hotel-mg', name: 'Hotel A · The Oberoi', kind: 'hotel', color: '#ffd166', memberIds: ['p-rohan', 'p-eleanor', 'p-mariel', 'p-diego'], placeId: 'hotel-mg' },
  { id: 'g-hotel-west', name: 'Hotel B · Taj West End', kind: 'hotel', color: '#b388ff', memberIds: ['p-aarti', 'p-yuchen', 'p-priya', 'p-tom'], placeId: 'hotel-west' },
];

/* ---------- segment builders ---------- */

let n = 0;
const sid = () => `seg_seed_${(n++).toString(36).padStart(3, '0')}`;

interface Sp { title: string; kind: Segment['kind']; date: string; from: string; to: string; zone?: string;
  place?: string; fromPlace?: string; toPlace?: string; who?: string[]; groups?: string[]; everyone?: boolean;
  notes?: string; tags?: string[]; status?: Segment['status']; flight?: Segment['flight'];
  travelMode?: NonNullable<Segment['travel']>['mode']; endDate?: string; endZone?: string }

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
    tags: s.tags ?? [],
    flight: s.flight,
    travel: s.travelMode ? { mode: s.travelMode, distanceKm: 0, baseMin: 0, trafficFactor: 1, source: 'estimate' } : undefined,
  };
}

const A = ['p-aarti', 'p-rohan', 'p-yuchen', 'p-eleanor'];
const B = ['p-priya', 'p-mariel', 'p-diego', 'p-tom'];

export const SEGMENTS: Segment[] = [
  /* ===== inbound travel ===== */
  seg({ title: 'BA 119 · London → Bengaluru', kind: 'flight', date: '2026-09-21', from: '21:20', endDate: '2026-09-22', to: '11:15',
        zone: 'Europe/London', endZone: IST, fromPlace: 'lhr', toPlace: 'blr', who: ['p-eleanor'],
        flight: { carrier: 'BA', number: '119', fromCode: 'LHR', toCode: 'BLR', terminal: '5', confirmation: 'QK7T2M' },
        tags: ['inbound'], notes: 'Overnight. Lands 11:15 IST — 6 h 45 m ahead of departure clock.' }),
  seg({ title: 'CI 751 · Taipei → Singapore', kind: 'flight', date: '2026-09-22', from: '07:20', to: '12:05',
        zone: 'Asia/Taipei', endZone: 'Asia/Singapore', fromPlace: 'tpe', toPlace: 'sin', who: ['p-yuchen'],
        flight: { carrier: 'CI', number: '751', fromCode: 'TPE', toCode: 'SIN', terminal: '1' }, tags: ['inbound'] }),
  seg({ title: 'SQ 508 · Singapore → Bengaluru', kind: 'flight', date: '2026-09-22', from: '15:30', to: '17:20',
        zone: 'Asia/Singapore', endZone: IST, fromPlace: 'sin', toPlace: 'blr', who: ['p-yuchen'],
        flight: { carrier: 'SQ', number: '508', fromCode: 'SIN', toCode: 'BLR', terminal: '3' },
        tags: ['inbound'], notes: '3 h 25 m connection at Changi.' }),
  seg({ title: 'AI 803 · Delhi → Bengaluru', kind: 'flight', date: '2026-09-22', from: '08:00', to: '10:45',
        fromPlace: 'del', toPlace: 'blr', who: ['p-rohan'],
        flight: { carrier: 'AI', number: '803', fromCode: 'DEL', toCode: 'BLR', terminal: '3' }, tags: ['inbound'] }),
  seg({ title: '6E 246 · Goa → Bengaluru', kind: 'flight', date: '2026-09-22', from: '10:15', to: '11:30',
        fromPlace: 'goi', toPlace: 'blr', who: ['p-aarti'],
        flight: { carrier: '6E', number: '246', fromCode: 'GOI', toCode: 'BLR' }, tags: ['inbound'] }),

  seg({ title: '6E 2011 · Delhi → Bengaluru', kind: 'flight', date: '2026-09-25', from: '14:30', to: '17:20',
        fromPlace: 'del', toPlace: 'blr', who: ['p-priya'],
        flight: { carrier: '6E', number: '2011', fromCode: 'DEL', toCode: 'BLR' }, tags: ['inbound'] }),
  seg({ title: 'SQ 915 · Manila → Singapore', kind: 'flight', date: '2026-09-25', from: '06:45', to: '10:35',
        zone: 'Asia/Manila', endZone: 'Asia/Singapore', fromPlace: 'mnl', toPlace: 'sin', who: ['p-mariel'],
        flight: { carrier: 'SQ', number: '915', fromCode: 'MNL', toCode: 'SIN' }, tags: ['inbound'] }),
  seg({ title: 'SQ 502 · Singapore → Bengaluru', kind: 'flight', date: '2026-09-25', from: '13:20', to: '15:10',
        zone: 'Asia/Singapore', endZone: IST, fromPlace: 'sin', toPlace: 'blr', who: ['p-mariel'],
        flight: { carrier: 'SQ', number: '502', fromCode: 'SIN', toCode: 'BLR' }, tags: ['inbound'] }),
  seg({ title: 'PR 507 · Manila → Singapore', kind: 'flight', date: '2026-09-25', from: '22:00', endDate: '2026-09-26', to: '02:00',
        zone: 'Asia/Manila', endZone: 'Asia/Singapore', fromPlace: 'mnl', toPlace: 'sin', who: ['p-diego'],
        flight: { carrier: 'PR', number: '507', fromCode: 'MNL', toCode: 'SIN' }, tags: ['inbound', 'red-eye'] }),
  seg({ title: 'SQ 516 · Singapore → Bengaluru', kind: 'flight', date: '2026-09-26', from: '03:30', to: '05:20',
        zone: 'Asia/Singapore', endZone: IST, fromPlace: 'sin', toPlace: 'blr', who: ['p-diego'],
        flight: { carrier: 'SQ', number: '516', fromCode: 'SIN', toCode: 'BLR' },
        tags: ['inbound', 'red-eye'], notes: 'Lands 05:20 with a full conference day ahead.' }),
  seg({ title: 'EK 22 · Manchester → Dubai', kind: 'flight', date: '2026-09-25', from: '13:45', endDate: '2026-09-26', to: '00:05',
        zone: 'Europe/London', endZone: 'Asia/Dubai', fromPlace: 'man', toPlace: 'dxb', who: ['p-tom'],
        flight: { carrier: 'EK', number: '22', fromCode: 'MAN', toCode: 'DXB' }, tags: ['inbound'] }),
  seg({ title: 'EK 568 · Dubai → Bengaluru', kind: 'flight', date: '2026-09-26', from: '03:50', to: '09:15',
        zone: 'Asia/Dubai', endZone: IST, fromPlace: 'dxb', toPlace: 'blr', who: ['p-tom'],
        flight: { carrier: 'EK', number: '568', fromCode: 'DXB', toCode: 'BLR' },
        tags: ['inbound'], notes: 'Lands 09:15 IST — Track B opens at 09:30.' }),

  /* ===== airport transfers + check-in, 22 Sep ===== */
  seg({ title: 'Airport transfer → Taj West End', kind: 'transfer', date: '2026-09-22', from: '11:45', to: '13:15',
        fromPlace: 'blr', toPlace: 'hotel-west', who: ['p-aarti'], travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'Airport transfer → The Oberoi', kind: 'transfer', date: '2026-09-22', from: '11:05', to: '12:35',
        fromPlace: 'blr', toPlace: 'hotel-mg', who: ['p-rohan'], travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'Airport transfer → The Oberoi', kind: 'transfer', date: '2026-09-22', from: '11:50', to: '13:20',
        fromPlace: 'blr', toPlace: 'hotel-mg', who: ['p-eleanor'], travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'Airport transfer → Taj West End', kind: 'transfer', date: '2026-09-22', from: '17:55', to: '19:40',
        fromPlace: 'blr', toPlace: 'hotel-west', who: ['p-yuchen'], travelMode: 'taxi',
        tags: ['transfer'], notes: 'Arrives into the evening peak — allow the extra 25 min.' }),
  seg({ title: 'Check in · Taj West End', kind: 'checkin', date: '2026-09-22', from: '13:15', to: '14:00',
        place: 'hotel-west', who: ['p-aarti'], tags: ['hotel'] }),
  seg({ title: 'Check in · The Oberoi', kind: 'checkin', date: '2026-09-22', from: '12:35', to: '13:15',
        place: 'hotel-mg', who: ['p-rohan'], tags: ['hotel'] }),
  seg({ title: 'Check in · The Oberoi', kind: 'checkin', date: '2026-09-22', from: '13:20', to: '14:00',
        place: 'hotel-mg', who: ['p-eleanor'], tags: ['hotel'] }),
  seg({ title: 'Check in · Taj West End', kind: 'checkin', date: '2026-09-22', from: '19:40', to: '20:15',
        place: 'hotel-west', who: ['p-yuchen'], tags: ['hotel'] }),
  seg({ title: 'Welcome dinner · Koshy’s', kind: 'meal', date: '2026-09-22', from: '20:30', to: '22:30',
        place: 'koshys', who: A, tags: ['social'], notes: 'Track A only — informal, no dress code.' }),

  /* ===== Track A conference, 23–25 Sep ===== */
  ...trackDays('2026-09-23', 'Track A'), 
  ...trackDays('2026-09-24', 'Track A'),
  ...trackDays('2026-09-25', 'Track A'),

  /* ===== Track A evenings ===== */
  seg({ title: 'ISKCON Temple at aarti hour', kind: 'activity', date: '2026-09-23', from: '18:15', to: '20:00',
        place: 'iskcon', who: ['p-aarti', 'p-yuchen'], tags: ['temple'], status: 'confirmed',
        notes: 'Evening aarti is around 19:15. Shoes and phones go in the locker.' }),
  seg({ title: 'Toit Brewpub', kind: 'activity', date: '2026-09-23', from: '19:30', to: '22:30',
        place: 'toit', who: ['p-rohan', 'p-eleanor'], tags: ['pub'], notes: 'No reservations after 19:00 — go early or expect a wait.' }),
  seg({ title: 'Lalbagh evening walk', kind: 'activity', date: '2026-09-24', from: '17:45', to: '19:15',
        place: 'lalbagh', who: ['p-eleanor', 'p-yuchen', 'p-aarti'], tags: ['garden'], status: 'tentative' }),
  seg({ title: 'VV Puram Food Street', kind: 'meal', date: '2026-09-24', from: '19:45', to: '21:30',
        place: 'vvpuram', who: A, tags: ['food'], notes: 'Cash helps. Start at the dosa end and work down.' }),
  seg({ title: 'Bull Temple + Basavanagudi walk', kind: 'activity', date: '2026-09-25', from: '17:30', to: '19:00',
        place: 'bull-temple', who: ['p-aarti', 'p-yuchen'], tags: ['temple'], status: 'tentative' }),
  seg({ title: 'Arbor Brewing Company', kind: 'activity', date: '2026-09-25', from: '19:30', to: '22:00',
        place: 'arbor', who: ['p-rohan', 'p-eleanor'], tags: ['pub'] }),

  /* ===== 26 Sep: Track B arrives, transfers ===== */
  seg({ title: 'Airport transfer → Taj West End', kind: 'transfer', date: '2026-09-25', from: '17:50', to: '19:30',
        fromPlace: 'blr', toPlace: 'hotel-west', who: ['p-priya'], travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'Airport transfer → The Oberoi', kind: 'transfer', date: '2026-09-25', from: '15:45', to: '17:05',
        fromPlace: 'blr', toPlace: 'hotel-mg', who: ['p-mariel'], travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'Airport transfer → The Oberoi', kind: 'transfer', date: '2026-09-26', from: '05:50', to: '06:50',
        fromPlace: 'blr', toPlace: 'hotel-mg', who: ['p-diego'], travelMode: 'taxi',
        tags: ['transfer'], notes: 'Pre-dawn run — roads are empty, about 55 min.' }),
  seg({ title: 'Check in · Taj West End', kind: 'checkin', date: '2026-09-25', from: '19:30', to: '20:10',
        place: 'hotel-west', who: ['p-priya'], tags: ['hotel'] }),
  seg({ title: 'Check in · The Oberoi', kind: 'checkin', date: '2026-09-25', from: '17:05', to: '17:45',
        place: 'hotel-mg', who: ['p-mariel'], tags: ['hotel'] }),
  seg({ title: 'Early check in · The Oberoi', kind: 'checkin', date: '2026-09-26', from: '06:50', to: '07:30',
        place: 'hotel-mg', who: ['p-diego'], tags: ['hotel'], status: 'tentative',
        notes: 'Early check-in requested — confirm with the hotel or he waits in the lobby.' }),
  seg({ title: 'Nap before sessions', kind: 'rest', date: '2026-09-26', from: '07:30', to: '09:00',
        place: 'hotel-mg', who: ['p-diego'], tags: ['rest'] }),

  seg({ title: 'Transfer → Taj West End', kind: 'transfer', date: '2026-09-26', from: '17:00', to: '18:20',
        fromPlace: 'venue', toPlace: 'hotel-west', who: ['p-tom'], travelMode: 'taxi',
        tags: ['transfer'], notes: 'First chance to drop bags — he came straight from the airport.' }),
  seg({ title: 'Check in · Taj West End', kind: 'checkin', date: '2026-09-26', from: '18:20', to: '19:00',
        place: 'hotel-west', who: ['p-tom'], tags: ['hotel'] }),

  /* ===== Track B conference, 26–27 Sep ===== */
  ...trackDays('2026-09-26', 'Track B'),
  ...trackDays('2026-09-27', 'Track B'),

  /* ===== Track A free days, 26–27 ===== */
  seg({ title: 'Nandi Hills sunrise run', kind: 'activity', date: '2026-09-26', from: '04:30', to: '10:30',
        place: 'nandi', who: ['p-aarti', 'p-yuchen', 'p-eleanor'], tags: ['excursion'], status: 'tentative',
        notes: '60 km each way. Leave by 04:30 to beat both the sunrise and the traffic back.' }),
  seg({ title: 'Bangalore Palace + Commercial Street', kind: 'activity', date: '2026-09-26', from: '15:00', to: '18:30',
        place: 'palace', who: ['p-rohan', 'p-eleanor'], tags: ['sightseeing'], status: 'tentative' }),
  seg({ title: 'Halasuru Someshwara Temple', kind: 'activity', date: '2026-09-27', from: '08:00', to: '09:30',
        place: 'someshwara', who: ['p-aarti', 'p-yuchen'], tags: ['temple'] }),
  seg({ title: 'MTR breakfast', kind: 'meal', date: '2026-09-27', from: '10:00', to: '11:00',
        place: 'mtr', who: ['p-aarti', 'p-yuchen', 'p-rohan'], tags: ['food'], notes: 'Queue before 09:30 or after 11:00.' }),

  /* ===== joint workshop, 28–29 Sep ===== */
  seg({ title: 'Joint workshop · opening plenary', kind: 'workshop', date: '2026-09-28', from: '09:30', to: '11:00',
        place: 'venue', everyone: true, tags: ['workshop'], notes: 'Everyone together for the first time.' }),
  seg({ title: 'Workshop · breakout round 1', kind: 'workshop', date: '2026-09-28', from: '11:30', to: '13:00',
        place: 'venue', everyone: true, tags: ['workshop'] }),
  seg({ title: 'Lunch', kind: 'meal', date: '2026-09-28', from: '13:00', to: '14:00', place: 'venue', everyone: true, tags: ['catered'] }),
  seg({ title: 'Workshop · breakout round 2', kind: 'workshop', date: '2026-09-28', from: '14:00', to: '16:30',
        place: 'venue', everyone: true, tags: ['workshop'] }),
  seg({ title: 'Group photo · Cubbon Park', kind: 'activity', date: '2026-09-28', from: '17:15', to: '18:00',
        place: 'cubbon', everyone: true, tags: ['social'], notes: 'Golden hour is about 17:45.' }),
  seg({ title: 'Group dinner · Toit', kind: 'meal', date: '2026-09-28', from: '19:00', to: '22:00',
        place: 'toit', everyone: true, tags: ['social'], notes: 'Long table booked for 8 under “Bhat”.' }),

  seg({ title: 'Workshop · synthesis', kind: 'workshop', date: '2026-09-29', from: '09:30', to: '12:30',
        place: 'venue', everyone: true, tags: ['workshop'] }),
  seg({ title: 'Lunch', kind: 'meal', date: '2026-09-29', from: '12:30', to: '13:30', place: 'venue', everyone: true, tags: ['catered'] }),
  seg({ title: 'Workshop · closing + next steps', kind: 'workshop', date: '2026-09-29', from: '13:30', to: '16:00',
        place: 'venue', everyone: true, tags: ['workshop'] }),
  seg({ title: 'Farewell drinks · Arbor', kind: 'activity', date: '2026-09-29', from: '18:30', to: '21:30',
        place: 'arbor', who: ['p-rohan', 'p-eleanor', 'p-mariel', 'p-tom', 'p-priya', 'p-diego'], tags: ['social'] }),

  /* ===== outbound ===== */
  seg({ title: 'Transfer → BLR airport', kind: 'transfer', date: '2026-09-29', from: '17:00', to: '19:00',
        fromPlace: 'hotel-west', toPlace: 'blr', who: ['p-aarti'], travelMode: 'taxi',
        tags: ['transfer'], notes: 'Leaves before farewell drinks — evening peak, allow 2 h.' }),
  seg({ title: '6E 247 · Bengaluru → Goa', kind: 'flight', date: '2026-09-29', from: '21:30', to: '22:45',
        fromPlace: 'blr', toPlace: 'goi', who: ['p-aarti'],
        flight: { carrier: '6E', number: '247', fromCode: 'BLR', toCode: 'GOI' }, tags: ['outbound', 'early-departure'] }),

  seg({ title: 'Transfer → BLR airport', kind: 'transfer', date: '2026-09-30', from: '06:00', to: '07:15',
        fromPlace: 'hotel-mg', toPlace: 'blr', who: ['p-eleanor'], travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'BA 118 · Bengaluru → London', kind: 'flight', date: '2026-09-30', from: '09:40', to: '15:05',
        zone: IST, endZone: 'Europe/London', fromPlace: 'blr', toPlace: 'lhr', who: ['p-eleanor'],
        flight: { carrier: 'BA', number: '118', fromCode: 'BLR', toCode: 'LHR', terminal: '5' }, tags: ['outbound'] }),
  seg({ title: 'Transfer → BLR airport', kind: 'transfer', date: '2026-09-30', from: '07:30', to: '09:00',
        fromPlace: 'hotel-mg', toPlace: 'blr', who: ['p-rohan'], travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'AI 804 · Bengaluru → Delhi', kind: 'flight', date: '2026-09-30', from: '11:00', to: '13:50',
        fromPlace: 'blr', toPlace: 'del', who: ['p-rohan'],
        flight: { carrier: 'AI', number: '804', fromCode: 'BLR', toCode: 'DEL' }, tags: ['outbound'] }),
  seg({ title: 'Transfer → BLR airport', kind: 'transfer', date: '2026-09-30', from: '10:45', to: '12:15',
        fromPlace: 'hotel-west', toPlace: 'blr', who: ['p-priya'], travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: '6E 2012 · Bengaluru → Delhi', kind: 'flight', date: '2026-09-30', from: '14:00', to: '16:55',
        fromPlace: 'blr', toPlace: 'del', who: ['p-priya'],
        flight: { carrier: '6E', number: '2012', fromCode: 'BLR', toCode: 'DEL' }, tags: ['outbound'] }),
  seg({ title: 'Transfer → BLR airport', kind: 'transfer', date: '2026-09-30', from: '17:00', to: '19:00',
        fromPlace: 'hotel-mg', toPlace: 'blr', who: ['p-mariel', 'p-diego'], travelMode: 'taxi',
        tags: ['transfer'], notes: 'Shared cab — peak-hour run to Devanahalli.' }),
  seg({ title: 'SQ 517 · Bengaluru → Singapore', kind: 'flight', date: '2026-09-30', from: '20:30', endDate: '2026-10-01', to: '03:40',
        zone: IST, endZone: 'Asia/Singapore', fromPlace: 'blr', toPlace: 'sin', who: ['p-mariel', 'p-diego'],
        flight: { carrier: 'SQ', number: '517', fromCode: 'BLR', toCode: 'SIN' }, tags: ['outbound'] }),

  seg({ title: 'Late checkout + Cubbon morning', kind: 'activity', date: '2026-09-30', from: '09:00', to: '12:00',
        place: 'cubbon', who: ['p-yuchen', 'p-tom'], tags: ['sightseeing'], status: 'tentative',
        notes: 'Both fly out on 1 Oct — a spare day in Bengaluru.' }),
  seg({ title: 'Transfer → BLR airport', kind: 'transfer', date: '2026-10-01', from: '02:30', to: '03:30',
        fromPlace: 'hotel-west', toPlace: 'blr', who: ['p-yuchen', 'p-tom'], travelMode: 'taxi', tags: ['transfer'] }),
  seg({ title: 'SQ 509 · Bengaluru → Singapore', kind: 'flight', date: '2026-10-01', from: '06:10', to: '13:20',
        zone: IST, endZone: 'Asia/Singapore', fromPlace: 'blr', toPlace: 'sin', who: ['p-yuchen'],
        flight: { carrier: 'SQ', number: '509', fromCode: 'BLR', toCode: 'SIN' }, tags: ['outbound', 'late-departure'] }),
  seg({ title: 'EK 569 · Bengaluru → Dubai', kind: 'flight', date: '2026-10-01', from: '04:20', to: '07:05',
        zone: IST, endZone: 'Asia/Dubai', fromPlace: 'blr', toPlace: 'dxb', who: ['p-tom'],
        flight: { carrier: 'EK', number: '569', fromCode: 'BLR', toCode: 'DXB' }, tags: ['outbound', 'late-departure'] }),
];

/** One conference day for a track. */
function trackDays(date: string, track: 'Track A' | 'Track B'): Segment[] {
  const who = track === 'Track A' ? A : B;
  const g = track === 'Track A' ? 'g-track-a' : 'g-track-b';
  return [
    seg({ title: `${track} · morning sessions`, kind: 'session', date, from: '09:30', to: '12:30', place: 'venue', who, groups: [g], tags: ['conference'] }),
    seg({ title: 'Lunch', kind: 'meal', date, from: '12:30', to: '13:30', place: 'venue', who, tags: ['catered'] }),
    seg({ title: `${track} · afternoon sessions`, kind: 'session', date, from: '13:30', to: '16:30', place: 'venue', who, groups: [g], tags: ['conference'] }),
  ];
}

export const IDEAS: Idea[] = [
  { id: uid('idea'), title: 'Vidhana Soudha at night', kind: 'activity', durationMin: 60, placeId: 'palace', attendeeIds: [], tags: ['sightseeing'], votes: ['p-priya', 'p-diego'], notes: 'Lit up on Sundays and public holidays.' },
  { id: uid('idea'), title: 'Cricket at Chinnaswamy', kind: 'activity', durationMin: 240, attendeeIds: [], tags: ['sport'], votes: ['p-tom', 'p-rohan'], notes: 'Only if a fixture lands in the window.' },
  { id: uid('idea'), title: 'Filter coffee crawl', kind: 'activity', durationMin: 150, placeId: 'mtr', attendeeIds: [], tags: ['food'], votes: ['p-yuchen', 'p-aarti', 'p-mariel'] },
  { id: uid('idea'), title: 'Commercial Street shopping', kind: 'activity', durationMin: 120, placeId: 'commercial', attendeeIds: [], tags: ['shopping'], votes: ['p-priya', 'p-mariel'] },
  { id: uid('idea'), title: 'Live music night', kind: 'activity', durationMin: 180, placeId: 'toit', attendeeIds: [], tags: ['pub', 'music'], votes: ['p-rohan', 'p-eleanor', 'p-tom'] },
];

export function conferenceTrip(): Trip {
  return {
    id: 'trip-blr-2026',
    name: 'Bengaluru Conference & Workshop',
    subtitle: '8 people · 6 origins · 3 time zones · 23 Sep – 1 Oct 2026',
    startDate: '2026-09-21',
    endDate: '2026-10-01',
    baseTimezone: IST,
    currency: 'INR',
    places: PLACES,
    people: PEOPLE,
    groups: GROUPS,
    segments: SEGMENTS,
    branches: [],
    ideas: IDEAS,
    updatedAt: Date.now(),
    schemaVersion: 1,
  };
}

/** A blank trip for someone starting from scratch. */
export function emptyTrip(name = 'New trip'): Trip {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const later = new Date(today.getTime() + 6 * 864e5);
  return {
    id: uid('trip'),
    name,
    subtitle: '',
    startDate: iso(today),
    endDate: iso(later),
    baseTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    currency: 'USD',
    places: [], people: [], groups: [], segments: [], branches: [], ideas: [],
    updatedAt: Date.now(),
    schemaVersion: 1,
  };
}

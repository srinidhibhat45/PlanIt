/** RFC 5545 calendar export.
 *  Times are emitted as UTC (`...Z`) which is unambiguous everywhere and
 *  sidesteps hand-rolling VTIMEZONE blocks; every client renders them in the
 *  reader's own zone, which is what a traveller actually wants. */

import type { Epoch, ID, Segment, Trip } from './types';
import { attendeesOf, segmentsFor } from './schedule';
import { fmtDuration } from './time';
import { travelMinutes, trafficLabel } from './travel';

const CRLF = '\r\n';

function stamp(e: Epoch): string {
  return new Date(e).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Escape per RFC 5545 §3.3.11. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold to 75 octets, continuation lines start with a single space. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let len = 0;
  for (const ch of line) {
    const size = new TextEncoder().encode(ch).length;
    if (len + size > (out.length === 0 ? 75 : 74)) { out.push(cur); cur = ''; len = 0; }
    cur += ch; len += size;
  }
  if (cur) out.push(cur);
  return out.join(`${CRLF} `);
}

function describe(seg: Segment, trip: Trip): string {
  const bits: string[] = [];
  if (seg.notes) bits.push(seg.notes);
  if (seg.flight) {
    bits.push(`Flight ${seg.flight.carrier}${seg.flight.number} · ${seg.flight.fromCode} → ${seg.flight.toCode}`);
    if (seg.flight.terminal) bits.push(`Terminal ${seg.flight.terminal}`);
    if (seg.flight.confirmation) bits.push(`Ref ${seg.flight.confirmation}`);
  }
  if (seg.travel) {
    const t = trafficLabel(seg.travel.trafficFactor);
    bits.push(
      `${seg.travel.mode} · ${seg.travel.distanceKm} km · ~${travelMinutes(seg.travel)} min ` +
      `(${t.text}, ×${seg.travel.trafficFactor})`,
    );
  }
  const att = attendeesOf(seg, trip)
    .map((id) => trip.people.find((p) => p.id === id)?.name)
    .filter(Boolean);
  if (att.length) bits.push(`With: ${att.join(', ')}`);
  bits.push(`Duration ${fmtDuration(seg.end - seg.start)} · local zone ${seg.timezone}`);
  if (seg.url) bits.push(seg.url);
  return bits.join('\n');
}

export interface IcsOptions {
  /** Only this person's segments. Omit for the whole trip. */
  personId?: ID;
  /** Minutes before each event to fire an alarm. 0 disables alarms. */
  alarmMin?: number;
  /** Include travel/transfer segments. */
  includeTravel?: boolean;
}

export function buildIcs(trip: Trip, opts: IcsOptions = {}): string {
  const { personId, alarmMin = 30, includeTravel = true } = opts;
  const segs = (personId ? segmentsFor(personId, trip) : trip.segments)
    .filter((s) => (includeTravel ? true : s.kind !== 'transfer'))
    .filter((s) => s.status !== 'cancelled')
    .sort((a, b) => a.start - b.start);

  const who = personId ? trip.people.find((p) => p.id === personId) : undefined;
  const calName = who ? `${trip.name} — ${who.name}` : trip.name;

  const L: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PlanIt//Itinerary Planner//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(calName)}`,
    `X-WR-TIMEZONE:${trip.baseTimezone}`,
    `X-WR-CALDESC:${esc(trip.subtitle ?? 'Itinerary exported from PlanIt')}`,
  ];

  for (const s of segs) {
    const place = trip.places.find((p) => p.id === (s.placeId ?? s.fromPlaceId ?? s.toPlaceId));
    L.push('BEGIN:VEVENT');
    L.push(`UID:${s.id}@planit`);
    L.push(`DTSTAMP:${stamp(trip.updatedAt)}`);
    L.push(`DTSTART:${stamp(s.start)}`);
    L.push(`DTEND:${stamp(s.end)}`);
    L.push(`SUMMARY:${esc(iconFor(s) + ' ' + s.title)}`);
    L.push(`DESCRIPTION:${esc(describe(s, trip))}`);
    if (place) {
      L.push(`LOCATION:${esc(place.address ? `${place.name}, ${place.address}` : place.name)}`);
      L.push(`GEO:${place.lat};${place.lon}`);
    }
    if (s.url) L.push(`URL:${s.url}`);
    L.push(`CATEGORIES:${esc([s.kind, ...s.tags].join(','))}`);
    L.push(`STATUS:${s.status === 'tentative' ? 'TENTATIVE' : 'CONFIRMED'}`);
    L.push(`TRANSP:${s.kind === 'free' ? 'TRANSPARENT' : 'OPAQUE'}`);
    for (const id of attendeesOf(s, trip)) {
      const p = trip.people.find((x) => x.id === id);
      if (!p) continue;
      L.push(`ATTENDEE;CN=${esc(p.name)};ROLE=REQ-PARTICIPANT${p.email ? `:mailto:${p.email}` : ':MAILTO:noreply@planit.local'}`);
    }
    if (alarmMin > 0 && s.kind !== 'free' && s.kind !== 'rest') {
      L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER:-PT${alarmMin}M`, `DESCRIPTION:${esc(s.title)}`, 'END:VALARM');
    }
    L.push('END:VEVENT');
  }

  L.push('END:VCALENDAR');
  return L.map(fold).join(CRLF) + CRLF;
}

export function iconFor(s: Segment): string {
  switch (s.kind) {
    case 'flight': return '\u2708';
    case 'transfer': return '\u{1F696}';
    case 'checkin': return '\u{1F511}';
    case 'checkout': return '\u{1F6AA}';
    case 'session': return '\u{1F3A4}';
    case 'workshop': return '\u{1F9E9}';
    case 'meal': return '\u{1F374}';
    case 'activity': return '\u{1F5FA}';
    case 'rest': return '\u{1F634}';
    case 'free': return '\u2728';
    case 'buffer': return '\u23F3';
    default: return '\u{1F4CC}';
  }
}

/** Google Calendar single-event deep link. */
export function googleCalendarUrl(seg: Segment, trip: Trip): string {
  const place = trip.places.find((p) => p.id === (seg.placeId ?? seg.fromPlaceId));
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: seg.title,
    dates: `${stamp(seg.start)}/${stamp(seg.end)}`,
    details: describe(seg, trip),
    location: place ? `${place.name}${place.address ? `, ${place.address}` : ''}` : '',
    ctz: seg.timezone,
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

/** Outlook web deep link. */
export function outlookUrl(seg: Segment, trip: Trip): string {
  const place = trip.places.find((p) => p.id === (seg.placeId ?? seg.fromPlaceId));
  const q = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: seg.title,
    startdt: new Date(seg.start).toISOString(),
    enddt: new Date(seg.end).toISOString(),
    body: describe(seg, trip),
    location: place?.name ?? '',
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${q}`;
}

export function downloadIcs(trip: Trip, opts: IcsOptions = {}) {
  const who = opts.personId ? trip.people.find((p) => p.id === opts.personId) : undefined;
  const slug = (who ? `${trip.name}-${who.name}` : trip.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  download(`${slug}.ics`, buildIcs(trip, opts), 'text/calendar;charset=utf-8');
}

export function download(filename: string, contents: string, mime: string) {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

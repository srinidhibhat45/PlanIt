/** Derivations over a Trip: who is where, when, and what is wrong with it. */

import type { ID, Issue, Place, Segment, Trip, Epoch, Filters } from './types';
import { DAY, HOUR, MIN, dateKey, fmtTime, fmtDate, overlaps, toParts } from './time';
import { estimateTravel, overheadMinutes, travelMinutes } from './travel';

export function byId<T extends { id: ID }>(list: T[]): Map<ID, T> {
  return new Map(list.map((x) => [x.id, x]));
}

/** Every person a segment actually involves, expanding `everyone` and groups. */
export function attendeesOf(seg: Segment, trip: Trip): ID[] {
  if (seg.everyone) return trip.people.map((p) => p.id);
  const set = new Set(seg.attendeeIds);
  for (const gid of seg.groupIds) {
    const g = trip.groups.find((x) => x.id === gid);
    g?.memberIds.forEach((m) => set.add(m));
  }
  return [...set];
}

export function segmentsFor(personId: ID, trip: Trip): Segment[] {
  return trip.segments
    .filter((s) => s.status !== 'cancelled' && attendeesOf(s, trip).includes(personId))
    .sort((a, b) => a.start - b.start);
}

/** The person's arrival and departure flights, if any. */
export function bookendsFor(personId: ID, trip: Trip): { arrival?: Segment; departure?: Segment } {
  const flights = segmentsFor(personId, trip).filter((s) => s.kind === 'flight');
  const inbound = flights.find((f) => f.toPlaceId && placeKind(f.toPlaceId, trip) === 'airport' && isInbound(f, trip));
  const outbound = [...flights].reverse().find((f) => !isInbound(f, trip));
  return { arrival: inbound ?? flights[0], departure: outbound ?? flights[flights.length - 1] };
}

function isInbound(f: Segment, trip: Trip): boolean {
  // Inbound = lands at an airport inside the trip's base zone cluster.
  const to = trip.places.find((p) => p.id === f.toPlaceId);
  return !!to && to.timezone === trip.baseTimezone;
}

function placeKind(id: ID, trip: Trip) {
  return trip.places.find((p) => p.id === id)?.kind;
}

/** Where a person is at a given instant (best effort). */
export function locationAt(personId: ID, at: Epoch, trip: Trip): Place | undefined {
  const segs = segmentsFor(personId, trip);
  const active = segs.find((s) => s.start <= at && at < s.end);
  const target = active ?? [...segs].reverse().find((s) => s.end <= at);
  if (!target) return undefined;
  const pid = target.toPlaceId ?? target.placeId;
  return trip.places.find((p) => p.id === pid);
}

/* ---------- filtering ---------- */

export function applyFilters(trip: Trip, f: Filters): Segment[] {
  const q = f.query.trim().toLowerCase();
  return trip.segments.filter((s) => {
    if (f.hideCancelled && s.status === 'cancelled') return false;
    if (f.kinds.length && !f.kinds.includes(s.kind)) return false;
    if (f.tags.length && !f.tags.some((t) => s.tags.includes(t))) return false;
    if (f.personIds.length) {
      const att = attendeesOf(s, trip);
      if (!f.personIds.some((p) => att.includes(p))) return false;
    }
    if (f.groupIds.length) {
      const att = attendeesOf(s, trip);
      const inGroup = trip.groups
        .filter((g) => f.groupIds.includes(g.id))
        .some((g) => g.memberIds.some((m) => att.includes(m)));
      if (!inGroup && !s.groupIds.some((g) => f.groupIds.includes(g))) return false;
    }
    if (q) {
      const place = trip.places.find((p) => p.id === (s.placeId ?? s.toPlaceId));
      const hay = `${s.title} ${s.notes ?? ''} ${s.tags.join(' ')} ${place?.name ?? ''} ${s.kind}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* ---------- the analyser ---------- */

export interface AnalyseOptions {
  /** Minimum slack, in minutes, on top of modelled travel time. */
  bufferMin: number;
  /** Flag evenings where a person has nothing after this local hour. */
  eveningFrom: number;
  /** A day this long with no meal earns a warning. */
  mealGapHours: number;
  /** Journeys shorter than this are not worth arranging a car for. */
  transferWorthBookingMin: number;
}

export const DEFAULT_ANALYSE: AnalyseOptions = {
  bufferMin: 15, eveningFrom: 18, mealGapHours: 7, transferWorthBookingMin: 25,
};

export function analyse(trip: Trip, opts: AnalyseOptions = DEFAULT_ANALYSE): Issue[] {
  const issues: Issue[] = [];
  const places = byId(trip.places);
  const people = byId(trip.people);
  const live = trip.segments.filter((s) => s.status !== 'cancelled');

  // --- segment-level checks
  for (const s of live) {
    if (!s.everyone && attendeesOf(s, trip).length === 0) {
      issues.push({
        id: `no-att:${s.id}`, code: 'no-attendees', severity: 'warning',
        title: 'Nobody is assigned',
        detail: `“${s.title}” has no attendees, so it will not appear on anyone's personal itinerary.`,
        segmentIds: [s.id], personIds: [],
      });
    }
    if (s.end <= s.start) {
      issues.push({
        id: `neg:${s.id}`, code: 'overlap', severity: 'error',
        title: 'Ends before it starts',
        detail: `“${s.title}” has a non-positive duration.`,
        segmentIds: [s.id], personIds: [],
      });
    }
  }

  // --- per-person timeline checks
  for (const person of trip.people) {
    const segs = segmentsFor(person.id, trip);
    const { arrival, departure } = bookendsFor(person.id, trip);
    const unbooked: { day: string; from: string; to: string; need: number; segmentIds: ID[] }[] = [];
    const freeEvenings: { day: string; label: string }[] = [];

    for (let i = 0; i < segs.length; i++) {
      const a = segs[i];

      // outside the person's trip window
      if (arrival && a.id !== arrival.id && a.kind !== 'flight' && a.end <= arrival.end) {
        issues.push({
          id: `pre:${person.id}:${a.id}`, code: 'before-arrival', severity: 'error',
          title: `${person.name} has not landed yet`,
          detail: `“${a.title}” finishes at ${fmtTime(a.end, { zone: a.timezone })} but ${person.name}'s flight lands at ${fmtTime(arrival.end, { zone: arrival.timezone })}.`,
          segmentIds: [a.id, arrival.id], personIds: [person.id],
        });
      }
      if (departure && a.id !== departure.id && a.kind !== 'flight' && a.start >= departure.start) {
        issues.push({
          id: `post:${person.id}:${a.id}`, code: 'after-departure', severity: 'error',
          title: `${person.name} has already left`,
          detail: `“${a.title}” starts after their ${fmtDate(departure.start, departure.timezone, 'short')} departure.`,
          segmentIds: [a.id, departure.id], personIds: [person.id],
        });
      }

      for (let j = i + 1; j < segs.length; j++) {
        const b = segs[j];
        if (b.start >= a.end) break;
        if (!overlaps(a.start, a.end, b.start, b.end)) continue;
        if (a.kind === 'free' || b.kind === 'free') continue;
        issues.push({
          id: `ov:${person.id}:${a.id}:${b.id}`, code: 'overlap', severity: 'error',
          title: `${person.name} is double-booked`,
          detail: `“${a.title}” and “${b.title}” overlap on ${fmtDate(a.start, a.timezone, 'medium')}.`,
          segmentIds: [a.id, b.id], personIds: [person.id],
        });
      }

      // travel feasibility between consecutive commitments
      const next = segs[i + 1];
      if (!next) continue;
      const fromPlace = places.get(a.toPlaceId ?? a.placeId ?? '');
      const toPlace = places.get(next.fromPlaceId ?? next.placeId ?? '');
      if (!fromPlace || !toPlace || fromPlace.id === toPlace.id) continue;
      if (a.kind === 'transfer' || next.kind === 'transfer') continue;

      const est = estimateTravel({ from: fromPlace, to: toPlace, mode: 'taxi', departAt: a.end });

      // Two airports far apart means a missing flight, not a long cab ride.
      if (fromPlace.kind === 'airport' && toPlace.kind === 'airport' && est.distanceKm > 300) {
        issues.push({
          id: `unreach:${person.id}:${a.id}:${next.id}`, code: 'unreachable', severity: 'error',
          title: `${person.name} has no way to get there`,
          detail:
            `${fromPlace.name} → ${toPlace.name} is ${Math.round(est.distanceKm)} km apart with no flight ` +
            'between them on the plan.',
          segmentIds: [a.id, next.id], personIds: [person.id],
        });
        continue;
      }

      const mode = 'taxi' as const;
      const need = travelMinutes(est) + overheadMinutes(mode, fromPlace.kind, toPlace.kind);
      const have = (next.start - a.end) / MIN;

      if (have < need) {
        const short = Math.round(need - have);
        issues.push({
          id: `gap:${person.id}:${a.id}:${next.id}`,
          code: next.kind === 'flight' ? 'tight-connection' : 'travel-gap',
          severity: have < need * 0.6 ? 'error' : 'warning',
          title: `${person.name} cannot make it in time`,
          detail:
            `${fromPlace.name} → ${toPlace.name} needs about ${need} min ` +
            `(${est.distanceKm} km, ×${est.trafficFactor} traffic${toPlace.kind === 'airport' ? ', incl. airport check-in' : ''}) ` +
            `but only ${Math.round(have)} min is free. Short by ${short} min.`,
          segmentIds: [a.id, next.id], personIds: [person.id],
        });
      } else if (
        need >= opts.transferWorthBookingMin &&
        !segs.some((t) => t.kind === 'transfer' && t.start >= a.end && t.end <= next.start
          && attendeesOf(t, trip).includes(person.id))
      ) {
        // Collected rather than raised: one line per journey buries the real
        // problems under dozens of hints. They are rolled up per day below.
        unbooked.push({
          day: dateKey(a.end, a.timezone),
          from: fromPlace.name, to: toPlace.name, need,
          segmentIds: [a.id, next.id],
        });
      }
    }

    // free evenings with nothing on
    const dayMap = new Map<string, Segment[]>();
    for (const s of segs) {
      const k = dateKey(s.start, s.timezone);
      dayMap.set(k, [...(dayMap.get(k) ?? []), s]);
    }
    for (const [key, daySegs] of dayMap) {
      const inWindow =
        (!arrival || daySegs[0].start >= arrival.end - HOUR) &&
        (!departure || daySegs[0].start <= departure.start);
      if (!inWindow) continue;

      const zone = daySegs[0].timezone;
      const evening = daySegs.filter((s) => {
        const h = toParts(s.start, zone).hour;
        return h >= opts.eveningFrom && s.kind !== 'rest' && s.kind !== 'free';
      });
      if (evening.length === 0 && daySegs.length > 0) {
        freeEvenings.push({ day: key, label: fmtDate(daySegs[0].start, zone, 'medium') });
      }

      // a long day with no meal
      const meals = daySegs.filter((s) => s.kind === 'meal');
      const span = daySegs[daySegs.length - 1].end - daySegs[0].start;
      if (meals.length === 0 && span > opts.mealGapHours * HOUR) {
        issues.push({
          id: `meal:${person.id}:${key}`, code: 'no-meal', severity: 'info',
          title: 'No meal break',
          detail: `${person.name} has a ${Math.round(span / HOUR)}-hour day on ${fmtDate(daySegs[0].start, zone, 'medium')} with no meal scheduled.`,
          segmentIds: [], personIds: [person.id],
        });
      }

      // late night followed by an early start
      const last = daySegs[daySegs.length - 1];
      const nextDay = [...dayMap.entries()].find(([k]) => k > key)?.[1];
      if (nextDay && last.end % DAY >= 0) {
        const restHrs = (nextDay[0].start - last.end) / HOUR;
        if (restHrs < 7 && restHrs > 0) {
          issues.push({
            id: `late:${person.id}:${key}`, code: 'late-night', severity: 'warning',
            title: 'Short night',
            detail: `${person.name} finishes at ${fmtTime(last.end, { zone })} and restarts at ${fmtTime(nextDay[0].start, { zone: nextDay[0].timezone })} — only ${restHrs.toFixed(1)} h between commitments.`,
            segmentIds: [last.id, nextDay[0].id], personIds: [person.id],
          });
        }
      }
    }

    /* --- roll-ups: one actionable line each, not one per occurrence --- */

    const byDay = new Map<string, typeof unbooked>();
    for (const u of unbooked) byDay.set(u.day, [...(byDay.get(u.day) ?? []), u]);
    for (const [day, hops] of byDay) {
      const total = hops.reduce((a, h) => a + h.need, 0);
      issues.push({
        id: `notr:${person.id}:${day}`, code: 'no-transfer', severity: 'info',
        title: `${person.name}: ${hops.length} unbooked ${hops.length === 1 ? 'journey' : 'journeys'}`,
        detail:
          `On ${day}, ${total} min of travel with nothing arranged — ` +
          hops.map((h) => `${h.from} → ${h.to} (${h.need} min)`).join('; ') + '.',
        segmentIds: [...new Set(hops.flatMap((h) => h.segmentIds))],
        personIds: [person.id],
      });
    }

    if (freeEvenings.length) {
      issues.push({
        id: `eve:${person.id}`, code: 'orphan-evening', severity: 'info',
        title: `${person.name} has ${freeEvenings.length} free ${freeEvenings.length === 1 ? 'evening' : 'evenings'}`,
        detail:
          `Nothing after ${String(opts.eveningFrom).padStart(2, '0')}:00 on ` +
          `${freeEvenings.map((e) => e.label).join(', ')}. ` +
          `Interests: ${person.interests.join(', ') || 'none recorded'}.`,
        segmentIds: [], personIds: [person.id],
      });
    }
  }

  const order = { error: 0, warning: 1, info: 2 } as const;
  return issues
    .filter((v, i, arr) => arr.findIndex((x) => x.id === v.id) === i)
    .sort((a, b) => order[a.severity] - order[b.severity] || a.title.localeCompare(b.title))
    .map((i) => ({ ...i, personIds: i.personIds.filter((p) => people.has(p)) }));
}

/** Roll-up counts for the header badge. */
export function issueSummary(issues: Issue[]) {
  return {
    error: issues.filter((i) => i.severity === 'error').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
    info: issues.filter((i) => i.severity === 'info').length,
    total: issues.length,
  };
}

/** Ordered stops for a person on a day — the input to the map route builder. */
export function itineraryPath(personId: ID, dayKey: string, trip: Trip): { seg: Segment; place: Place }[] {
  const out: { seg: Segment; place: Place }[] = [];
  for (const s of segmentsFor(personId, trip)) {
    if (dateKey(s.start, s.timezone) !== dayKey) continue;
    const p = trip.places.find((x) => x.id === (s.placeId ?? s.toPlaceId ?? s.fromPlaceId));
    if (p && out[out.length - 1]?.place.id !== p.id) out.push({ seg: s, place: p });
  }
  return out;
}

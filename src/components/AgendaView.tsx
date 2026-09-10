/** The plain-language itinerary: every day, hour by hour, with the journeys
 *  between stops spelled out. This is the view that prints, that a screen
 *  reader reads top to bottom, and that people paste into a group chat. */

import { useMemo } from 'react';
import type { ClockMode, ID, Issue, Segment, Trip } from '../core/types';
import { MIN, dateKey, dateKeyToEpoch, fmtDate, fmtDuration, fmtRange, fmtTime, zoneCity } from '../core/time';
import { attendeesOf } from '../core/schedule';
import { estimateTravel, overheadMinutes, trafficLabel, travelMinutes } from '../core/travel';
import { KIND_LABEL } from '../core/layout';
import { axisZone, resolveZone } from '../core/clock';
import { iconFor } from '../core/ics';
import { initials } from './SegmentChrome';

export function AgendaView({
  trip, segments, clock, selectedId, focusPersonId, issues, onSelect,
}: {
  trip: Trip; segments: Segment[]; clock: ClockMode; selectedId: ID | null;
  focusPersonId: ID | null; issues: Issue[]; onSelect: (id: ID) => void;
}) {
  const zone = axisZone(clock, trip);

  const days = useMemo(() => {
    const map = new Map<string, Segment[]>();
    for (const s of segments) {
      const k = dateKey(s.start, zone);
      map.set(k, [...(map.get(k) ?? []), s]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, segs]) => ({ key, segs: segs.sort((a, b) => a.start - b.start || a.end - b.end) }));
  }, [segments, zone]);

  const conflictIds = useMemo(() => {
    const s = new Set<ID>();
    for (const i of issues) if (i.severity === 'error') i.segmentIds.forEach((id) => s.add(id));
    return s;
  }, [issues]);

  if (days.length === 0) {
    return (
      <div className="empty">
        <p className="empty__title">Nothing scheduled yet</p>
        <p className="empty__body">
          Add a block from the timeline, or drag an idea off the board onto a day.
        </p>
      </div>
    );
  }

  return (
    <div className="agenda">
      {days.map(({ key, segs }) => {
        const dayEpoch = dateKeyToEpoch(key, zone);
        const totalMin = segs.reduce((a, s) => a + (s.end - s.start) / MIN, 0);
        const peopleOn = new Set(segs.flatMap((s) => attendeesOf(s, trip))).size;
        return (
          <section className="agenda__day" key={key} aria-labelledby={`day-${key}`}>
            <header className="agenda__dayhead">
              <h2 className="agenda__dayname" id={`day-${key}`}>{fmtDate(dayEpoch, zone, 'long')}</h2>
              <p className="agenda__daymeta">
                {segs.length} {segs.length === 1 ? 'item' : 'items'}
                {focusPersonId
                  ? ` · ${fmtDuration(totalMin * MIN)} scheduled`
                  : ` · ${peopleOn} ${peopleOn === 1 ? 'person' : 'people'} · ${fmtDuration(totalMin * MIN)} combined`}
              </p>
            </header>

            <ol className="agenda__list">
              {segs.map((seg, i) => {
                const next = segs[i + 1];
                const hop = next ? journey(seg, next, trip, focusPersonId) : null;
                const segZone = resolveZone(clock, seg, trip);
                const place = trip.places.find((p) => p.id === (seg.placeId ?? seg.toPlaceId));
                const fromPlace = trip.places.find((p) => p.id === seg.fromPlaceId);
                const people = attendeesOf(seg, trip);
                const crossZone = segZone !== zone;

                return (
                  <li key={seg.id}>
                    <button
                      type="button"
                      className="agenda__item"
                      data-kind={seg.kind}
                      aria-selected={selectedId === seg.id}
                      onClick={() => onSelect(seg.id)}
                    >
                      <span className="agenda__time">
                        <time dateTime={new Date(seg.start).toISOString()}>{fmtTime(seg.start, { zone })}</time>
                        <time dateTime={new Date(seg.end).toISOString()} style={{ color: 'var(--ink-3)' }}>
                          {fmtTime(seg.end, { zone })}
                        </time>
                        {crossZone && <small>{fmtRange(seg.start, seg.end, { zone: segZone })} {zoneCity(segZone)}</small>}
                      </span>

                      <span className="agenda__main">
                        <span className="agenda__title">
                          {seg.title}
                          {seg.status === 'tentative' && <span className="chip chip--warn">tentative</span>}
                          {seg.status === 'cancelled' && <span className="chip chip--danger">cancelled</span>}
                          {conflictIds.has(seg.id) && <span className="chip chip--danger">clash</span>}
                        </span>
                        <span className="agenda__sub">
                          <span>{iconFor(seg)} {KIND_LABEL[seg.kind] ?? seg.kind}</span>
                          <span>{fmtDuration(seg.end - seg.start)}</span>
                          {fromPlace && place ? <span>{fromPlace.name} → {place.name}</span> : place ? <span>{place.name}</span> : null}
                          {/* "T5" on its own is airline shorthand. Spelling it
                              out costs four characters and saves a guess. */}
                          {seg.flight && (
                            <span className="mono">
                              {seg.flight.carrier}{seg.flight.number}
                              {seg.flight.terminal ? ` · Terminal ${seg.flight.terminal}` : ''}
                            </span>
                          )}
                        </span>
                        {seg.notes && <span className="agenda__notes">{seg.notes}</span>}
                      </span>

                      <span className="agenda__who">
                        {seg.everyone ? (
                          <span className="chip chip--accent">Everyone</span>
                        ) : (
                          <span className="avatar-stack">
                            {people.slice(0, 4).map((id) => {
                              const p = trip.people.find((x) => x.id === id);
                              return p ? (
                                <span key={id} className="avatar" style={{ ['--c' as string]: p.color }} title={p.name}>
                                  {initials(p.name)}
                                </span>
                              ) : null;
                            })}
                            {people.length > 4 && (
                              <span className="avatar" style={{ ['--c' as string]: 'var(--ink-3)' }}>+{people.length - 4}</span>
                            )}
                          </span>
                        )}
                        <span className="sr-only">
                          {seg.everyone ? 'Everyone attending' : people.length
                            ? `With ${people.map((id) => trip.people.find((p) => p.id === id)?.name).filter(Boolean).join(', ')}`
                            : 'Nobody assigned'}
                        </span>
                      </span>
                    </button>

                    {hop && (
                      <p className="agenda__travel" data-short={hop.short}>
                        <span aria-hidden="true">↳</span>
                        <span>
                          {hop.who}{hop.fromName} → {hop.toName} · {hop.needMin} min by taxi · {hop.distanceKm} km · {hop.traffic}
                          {hop.short
                            ? ` · only ${hop.haveMin} min free — short by ${hop.needMin - hop.haveMin} min`
                            : ` · ${hop.haveMin} min available`}
                        </span>
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

/** A journey only exists for someone who is on both sides of it. Without this
 *  check the merged agenda would invent hops between two different people's
 *  unrelated blocks. */
function journey(a: Segment, b: Segment, trip: Trip, focusPersonId: ID | null) {
  const inA = attendeesOf(a, trip);
  const inB = attendeesOf(b, trip);
  const shared = focusPersonId
    ? (inA.includes(focusPersonId) && inB.includes(focusPersonId) ? [focusPersonId] : [])
    : inA.filter((id) => inB.includes(id));
  if (shared.length === 0) return null;

  const fromP = trip.places.find((p) => p.id === (a.toPlaceId ?? a.placeId));
  const toP = trip.places.find((p) => p.id === (b.fromPlaceId ?? b.placeId));
  if (!fromP || !toP || fromP.id === toP.id) return null;
  if (b.start <= a.end) return null;

  const est = estimateTravel({ from: fromP, to: toP, mode: 'taxi', departAt: a.end });
  const needMin = travelMinutes(est) + overheadMinutes('taxi', fromP.kind, toP.kind);
  const haveMin = Math.round((b.start - a.end) / MIN);
  const names = shared.map((id) => trip.people.find((p) => p.id === id)?.name.split(' ')[0]).filter(Boolean);
  return {
    fromName: fromP.name, toName: toP.name,
    needMin, haveMin, distanceKm: est.distanceKm,
    traffic: `${trafficLabel(est.trafficFactor).text} (×${est.trafficFactor})`,
    short: haveMin < needMin,
    who: focusPersonId ? '' : `${names.length > 2 ? `${names.length} people` : names.join(' & ')}: `,
  };
}

/** Plain-text itinerary for the clipboard. */
export function agendaText(trip: Trip, segments: Segment[], zone: string, personId?: ID): string {
  const who = personId ? trip.people.find((p) => p.id === personId) : undefined;
  const lines: string[] = [
    trip.name,
    who ? `Itinerary for ${who.name}` : 'Full itinerary',
    `Times in ${zoneCity(zone)} (${zone})`,
    '',
  ];
  const byDay = new Map<string, Segment[]>();
  for (const s of segments) {
    const k = dateKey(s.start, zone);
    byDay.set(k, [...(byDay.get(k) ?? []), s]);
  }
  for (const [k, segs] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(fmtDate(dateKeyToEpoch(k, zone), zone, 'long').toUpperCase());
    for (const s of segs.sort((a, b) => a.start - b.start)) {
      const place = trip.places.find((p) => p.id === (s.placeId ?? s.toPlaceId));
      lines.push(
        `  ${fmtRange(s.start, s.end, { zone })}  ${s.title}` +
        (place ? `  —  ${place.name}` : '') +
        (s.status !== 'confirmed' ? `  [${s.status}]` : ''),
      );
      if (s.notes) lines.push(`               ${s.notes}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

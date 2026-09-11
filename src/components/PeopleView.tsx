/** Roster: who is coming, when they land, where they sleep, what they like.
 *
 *  Each card is one person's whole involvement in the trip — their own
 *  itinerary, their own clock, their own free evenings — because that is the
 *  unit people actually think in when they ask "what am I doing on Thursday". */

import { useMemo } from 'react';
import type { ClockMode, ID, Issue, Trip } from '../core/types';
import { DAY, MIN, dateKey, eachDay, fmtDate, fmtDuration, fmtTime, zoneAbbr, zoneCity } from '../core/time';
import { bookendsFor, segmentsFor } from '../core/schedule';
import { axisZone } from '../core/clock';
import { branchMembers } from '../core/branch';
import { initials } from './SegmentChrome';
import { IconPlus, IconShare, IconWarn } from './Icons';
import { Tip } from './Tooltip';

export function PeopleView({
  trip, clock, onFocusPerson, onExport, onOpenPerson, focusPersonId, issues,
  onAddPerson, onAddBlockFor, onEditPerson, onSharePerson,
}: {
  trip: Trip; clock: ClockMode; focusPersonId: ID | null; issues: Issue[];
  onFocusPerson: (id: ID | null) => void;
  onExport: (id: ID) => void;
  onOpenPerson: (id: ID) => void;
  onAddPerson: () => void;
  /** Put something in the plan for one person without leaving their card. */
  onAddBlockFor: (id: ID) => void;
  onEditPerson: (id: ID) => void;
  onSharePerson: (id: ID) => void;
}) {
  const zone = axisZone(clock, trip);

  const days = useMemo(() => {
    if (!trip.segments.length) return [];
    const lo = Math.min(...trip.segments.map((s) => s.start));
    const hi = Math.max(...trip.segments.map((s) => s.end));
    return eachDay(lo, hi, zone);
  }, [trip.segments, zone]);

  const issuesByPerson = useMemo(() => {
    const map = new Map<ID, Issue[]>();
    for (const i of issues) for (const pid of i.personIds) map.set(pid, [...(map.get(pid) ?? []), i]);
    return map;
  }, [issues]);

  return (
    <div className="people">
      <div className="people__bar">
        <p className="people__count">
          {trip.people.length === 0
            ? 'Nobody on the trip yet'
            : `${trip.people.length} ${trip.people.length === 1 ? 'person' : 'people'}`}
        </p>
        <Tip
          label="Add someone to the trip"
          hint="Their home city, their clock and the dates they can be there — everything the clash checks need."
          side="left"
        >
          <button className="btn btn--sm btn--primary" onClick={onAddPerson}>
            <IconPlus size={14} /> Add someone
          </button>
        </Tip>
      </div>

      {trip.people.map((person) => {
        const segs = segmentsFor(person.id, trip);
        const { arrival, departure } = bookendsFor(person.id, trip);
        const hotel = trip.groups.find((g) => g.kind === 'hotel' && g.memberIds.includes(person.id));
        const track = trip.groups.find((g) => g.kind === 'track' && g.memberIds.includes(person.id));
        const hotelPlace = trip.places.find((p) => p.id === hotel?.placeId);
        const busyByDay = days.map((k) => {
          const mins = segs
            .filter((s) => dateKey(s.start, zone) === k && s.kind !== 'rest')
            .reduce((a, s) => a + Math.min(s.end, s.start + DAY) - s.start, 0) / MIN;
          return { key: k, mins };
        });
        const maxMins = Math.max(60, ...busyByDay.map((d) => d.mins));
        const offset = zoneAbbr(Date.now(), person.homeTimezone);
        const isFocused = focusPersonId === person.id;
        const mine = issuesByPerson.get(person.id) ?? [];
        const blocking = mine.filter((i) => i.severity === 'error').length;
        const theirBranches = trip.branches.filter((b) => branchMembers(trip, b).includes(person.id));
        const owned = segs.filter((s) => s.ownerId === person.id).length;

        return (
          <article className="panel pcard" key={person.id} aria-labelledby={`p-${person.id}`}>
            <header className="pcard__head">
              <span className="avatar avatar--lg" style={{ ['--c' as string]: person.color }} aria-hidden="true">
                {initials(person.name)}
              </span>
              <div className="grow">
                <h3 className="pcard__name" id={`p-${person.id}`}>{person.name}</h3>
                <p className="pcard__meta">
                  {person.homeCity} · {zoneCity(person.homeTimezone)} ({offset})
                </p>
              </div>
              <div className="row" style={{ gap: 4, alignItems: 'center' }}>
                {blocking > 0 && (
                  <span className="chip chip--danger" title={mine.filter((i) => i.severity === 'error').map((i) => i.title).join('; ')}>
                    <IconWarn size={11} /> {blocking}
                  </span>
                )}
                {track && <span className="chip" style={{ color: track.color, borderColor: track.color }}>{track.name.split(' · ')[0]}</span>}
              </div>
            </header>

            <dl className="pcard__grid">
              <dt>Arrives</dt>
              <dd>
                {arrival ? (
                  <>
                    <span className="mono">{fmtDate(arrival.end, zone, 'medium')} {fmtTime(arrival.end, { zone })}</span>
                    {' '}<span style={{ color: 'var(--ink-3)' }}>{arrival.flight ? `${arrival.flight.carrier}${arrival.flight.number}` : ''}</span>
                  </>
                ) : <span style={{ color: 'var(--ink-3)' }}>Not set</span>}
              </dd>

              <dt>Leaves</dt>
              <dd>
                {departure ? (
                  <>
                    <span className="mono">{fmtDate(departure.start, zone, 'medium')} {fmtTime(departure.start, { zone })}</span>
                    {' '}<span style={{ color: 'var(--ink-3)' }}>{departure.flight ? `${departure.flight.carrier}${departure.flight.number}` : ''}</span>
                  </>
                ) : <span style={{ color: 'var(--ink-3)' }}>Not set</span>}
              </dd>

              <dt>Available</dt>
              <dd>
                {person.windowStart === undefined && person.windowEnd === undefined
                  ? <span style={{ color: 'var(--ink-3)' }}>Whole trip</span>
                  : (
                    <span className="mono">
                      {person.windowStart !== undefined ? `${fmtDate(person.windowStart, zone, 'short')} ${fmtTime(person.windowStart, { zone })}` : 'trip start'}
                      {' → '}
                      {person.windowEnd !== undefined ? `${fmtDate(person.windowEnd, zone, 'short')} ${fmtTime(person.windowEnd, { zone })}` : 'trip end'}
                    </span>
                  )}
              </dd>

              <dt>Hotel</dt>
              <dd>{hotelPlace?.name ?? hotel?.name ?? '—'}</dd>

              {theirBranches.length > 0 && (
                <>
                  <dt>Sub-trips</dt>
                  <dd className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                    {theirBranches.map((b) => (
                      <span key={b.id} className="chip" style={{ color: b.color, borderColor: b.color }}>{b.name}</span>
                    ))}
                  </dd>
                </>
              )}

              <dt>Likes</dt>
              <dd>{person.interests.join(', ') || '—'}</dd>

              {person.dietary && (<><dt>Diet</dt><dd>{person.dietary}</dd></>)}
            </dl>

            <div>
              <p className="label" style={{ marginBottom: 4 }}>Daily load</p>
              <div className="pcard__bar" role="img"
                aria-label={busyByDay.map((d) => `${d.key}: ${Math.round(d.mins / 60)} hours`).join('; ')}>
                {busyByDay.map((d) => (
                  <span
                    key={d.key}
                    style={{
                      flex: 1,
                      background: d.mins === 0 ? 'transparent'
                        : `color-mix(in oklab, ${person.color} ${Math.round(30 + (d.mins / maxMins) * 70)}%, transparent)`,
                      borderRight: '1px solid var(--bg-1)',
                    }}
                    title={`${d.key}: ${fmtDuration(d.mins * MIN)}`}
                  />
                ))}
              </div>
              <p className="pcard__meta" style={{ marginTop: 4 }}>
                {segs.length} items · {fmtDuration(segs.reduce((a, s) => a + (s.end - s.start), 0))} total
                {owned > 0 && ` · ${owned} added by them`}
              </p>
            </div>

            <div className="row" style={{ flexWrap: 'wrap' }}>
              <Tip
                label={`Add a block for ${person.name.split(' ')[0]}`}
                hint="A new block with them already on it, on the day the rest of the app is showing. Its details open so you can say what it is."
              >
                <button
                  type="button" className="btn btn--sm btn--primary"
                  onClick={() => onAddBlockFor(person.id)}
                >
                  <IconPlus size={13} /> Add a block
                </button>
              </Tip>
              <Tip
                label={isFocused ? 'Show everybody again' : 'Show only them'}
                hint={isFocused
                  ? 'Put the rest of the trip back into every view.'
                  : `Narrows every view to what ${person.name.split(' ')[0]} actually does — and makes new blocks theirs.`}
              >
                <button
                  type="button"
                  className="btn btn--sm"
                  aria-pressed={isFocused}
                  onClick={() => onFocusPerson(isFocused ? null : person.id)}
                >
                  {isFocused ? 'Showing only them' : 'Focus on them'}
                </button>
              </Tip>
              <Tip label="Their itinerary" hint="Opens the board on their trip alone, so you can rearrange just their days.">
                <button type="button" className="btn btn--sm" onClick={() => onOpenPerson(person.id)}>
                  Their itinerary
                </button>
              </Tip>
              <Tip label="Edit their details" hint="Home city, the dates they are available, dietary and mobility notes — everything the checks use.">
                <button type="button" className="btn btn--sm" onClick={() => onEditPerson(person.id)}>
                  Edit details
                </button>
              </Tip>
              <Tip label="Give them a link" hint="A share link that opens on their own itinerary and nobody else’s.">
                <button type="button" className="btn btn--sm" onClick={() => onSharePerson(person.id)}>
                  <IconShare size={13} /> Give them a link
                </button>
              </Tip>
              <Tip label="Calendar file" hint="Downloads their itinerary as an .ics any calendar app can import.">
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => onExport(person.id)}>
                  Calendar file
                </button>
              </Tip>
            </div>
          </article>
        );
      })}

      {trip.people.length === 0 && (
        <div className="empty">
          <p className="empty__title">No one on the trip yet</p>
          <p className="empty__body">
            Add everyone coming, with where they are travelling from and when they can be there.
            The canvas then knows whose day it is drawing, and can tell you when a plan asks
            somebody to be in two places at once.
          </p>
          <button className="btn btn--primary" onClick={onAddPerson}>
            <IconPlus size={15} /> Add the first person
          </button>
        </div>
      )}
    </div>
  );
}

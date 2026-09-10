/** Idea backlog. Things people want to do that have no time yet — drag one
 *  onto a day to schedule it, or let the app find the first free evening. */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ClockMode, ID, Idea, Trip } from '../core/types';
import { HOUR, MIN, dateKey, dateKeyToEpoch, eachDay, fmtDate, fmtDuration, fromZoned, toParts } from '../core/time';
import { attendeesOf } from '../core/schedule';
import { axisZone } from '../core/clock';
import { initials } from './SegmentChrome';
import { IconPlus, IconSparkle, IconTrash } from './Icons';

export function BoardView({
  trip, clock, onPromote, onAddIdea, onDeleteIdea, onVote, onAnnounce,
}: {
  trip: Trip; clock: ClockMode;
  onPromote: (ideaId: ID, start: number, zone: string) => void;
  onAddIdea: (title: string) => void;
  onDeleteIdea: (id: ID) => void;
  onVote: (id: ID, personId: ID) => void;
  onAnnounce: (t: string) => void;
}) {
  const zone = axisZone(clock, trip);
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState<{ id: ID; overKey: string | null } | null>(null);
  const cellRefs = useRef(new Map<string, HTMLDivElement>());

  const days = useMemo(() => {
    if (!trip.segments.length) return [];
    const lo = Math.min(...trip.segments.map((s) => s.start));
    const hi = Math.max(...trip.segments.map((s) => s.end));
    return eachDay(lo, hi, zone);
  }, [trip.segments, zone]);

  /** First evening slot on a day that is free for everyone who voted. */
  const firstFreeEvening = useCallback((idea: Idea, dayKey: string): number => {
    const start = dateKeyToEpoch(dayKey, zone);
    const p = toParts(start, zone);
    const voters = idea.votes.length ? idea.votes : trip.people.map((x) => x.id);
    for (let hour = 18; hour <= 21; hour += 1) {
      const t = fromZoned(p.year, p.month, p.day, hour, 0, 0, zone);
      const end = t + idea.durationMin * MIN;
      const clash = trip.segments.some(
        (s) => s.status !== 'cancelled' && s.start < end && t < s.end &&
          attendeesOf(s, trip).some((a) => voters.includes(a)),
      );
      if (!clash) return t;
    }
    return fromZoned(p.year, p.month, p.day, 19, 0, 0, zone);
  }, [trip, zone]);

  const keyAt = useCallback((x: number, y: number) => {
    for (const [k, el] of cellRefs.current) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return k;
    }
    return null;
  }, []);

  const place = (idea: Idea, dayKey: string) => {
    const t = firstFreeEvening(idea, dayKey);
    onPromote(idea.id, t, zone);
    onAnnounce(`Scheduled “${idea.title}” on ${fmtDate(t, zone, 'long')} at ${new Date(t).toISOString().slice(11, 16)}.`);
  };

  return (
    <div className="board">
      <div className="board__col" style={{ width: '19rem' }}>
        <div className="board__colhead">
          <h2 className="eyebrow">Ideas · not yet scheduled</h2>
          <span className="chip">{trip.ideas.length}</span>
        </div>

        <form
          className="row"
          onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { onAddIdea(draft.trim()); setDraft(''); } }}
        >
          <input
            className="input"
            placeholder="Add an idea…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="New idea"
          />
          <button className="btn btn--icon" type="submit" title="Add this idea to the backlog" aria-label="Add idea">
            <IconPlus />
          </button>
        </form>

        <ul className="board__list">
          {trip.ideas.map((idea) => {
            const p = trip.places.find((x) => x.id === idea.placeId);
            return (
              <li key={idea.id}>
                <div
                  className="idea"
                  style={dragging?.id === idea.id ? { opacity: 0.45 } : undefined}
                  onPointerDown={(e) => {
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    setDragging({ id: idea.id, overKey: null });
                  }}
                  onPointerMove={(e) => {
                    if (dragging?.id !== idea.id) return;
                    const k = keyAt(e.clientX, e.clientY);
                    if (k !== dragging.overKey) setDragging({ id: idea.id, overKey: k });
                  }}
                  onPointerUp={() => {
                    if (dragging?.id === idea.id && dragging.overKey) place(idea, dragging.overKey);
                    setDragging(null);
                  }}
                  onPointerCancel={() => setDragging(null)}
                >
                  <span className="idea__title">{idea.title}</span>
                  <span className="idea__meta">
                    <span>{fmtDuration(idea.durationMin * MIN)}</span>
                    {p && <span className="truncate">· {p.name}</span>}
                  </span>
                  {/* Eight faces above a chip reading "2 interested" reads as a
                      contradiction. One labelled row, voters first, says the
                      same thing once: who is in, and that the rest are a tap
                      away from joining. */}
                  <div className="idea__votes">
                    <span className="idea__voteshead">
                      Who’s in?
                      <b>{idea.votes.length} of {trip.people.length}</b>
                    </span>
                    <div className="idea__faces">
                      {[...trip.people]
                        .sort((a, b) =>
                          Number(idea.votes.includes(b.id)) - Number(idea.votes.includes(a.id)))
                        .map((person) => {
                          const on = idea.votes.includes(person.id);
                          return (
                            <button
                              key={person.id}
                              type="button"
                              className="avatar avatar--sm idea__face"
                              data-on={on}
                              style={on ? { ['--c' as string]: person.color } : undefined}
                              aria-pressed={on}
                              aria-label={`${person.name}: ${on ? 'wants to go' : 'not interested yet'}. ${idea.title}`}
                              title={`${person.name} — ${on ? 'wants to go' : 'tap to add them'}`}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={() => onVote(idea.id, person.id)}
                            >
                              {initials(person.name)}
                            </button>
                          );
                        })}
                    </div>
                  </div>
                  <div className="row">
                    <button
                      type="button" className="btn btn--ghost btn--sm" style={{ marginLeft: 'auto' }}
                      aria-label={`Delete idea ${idea.title}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => onDeleteIdea(idea.id)}
                    ><IconTrash size={14} /></button>
                  </div>

                  <label className="sr-only" htmlFor={`sched-${idea.id}`}>Schedule {idea.title} on a day</label>
                  <select
                    id={`sched-${idea.id}`}
                    className="input"
                    value=""
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => { if (e.target.value) place(idea, e.target.value); }}
                  >
                    <option value="">Schedule on…</option>
                    {days.map((d) => (
                      <option key={d} value={d}>{fmtDate(dateKeyToEpoch(d, zone), zone, 'medium')}</option>
                    ))}
                  </select>
                </div>
              </li>
            );
          })}
          {trip.ideas.length === 0 && (
            <li style={{ color: 'var(--ink-3)', fontSize: 'var(--step--1)', padding: 'var(--s-3)' }}>
              Nothing parked here. Add what people mention but you have not placed yet.
            </li>
          )}
        </ul>
      </div>

      {days.map((k) => {
        const epoch = dateKeyToEpoch(k, zone);
        const count = trip.segments.filter((s) => dateKey(s.start, zone) === k).length;
        const eveningCount = trip.segments.filter(
          (s) => dateKey(s.start, zone) === k && toParts(s.start, zone).hour >= 18,
        ).length;
        return (
          <div
            key={k}
            className="board__col"
            ref={(el) => { if (el) cellRefs.current.set(k, el); else cellRefs.current.delete(k); }}
            data-droppable={dragging?.overKey === k ? 'over' : undefined}
          >
            <div className="board__colhead">
              <h2 className="eyebrow">{fmtDate(epoch, zone, 'medium')}</h2>
              <span className="chip">{count}</span>
            </div>
            <p style={{ fontSize: 'var(--step--2)', color: eveningCount ? 'var(--ink-3)' : 'var(--warn-ink)' }}>
              {eveningCount ? `${eveningCount} evening item${eveningCount > 1 ? 's' : ''}` : 'Evening is wide open'}
            </p>
            <p style={{ fontSize: 'var(--step--2)', color: 'var(--ink-3)', display: 'flex', gap: 4, alignItems: 'center' }}>
              <IconSparkle size={13} /> Drop an idea here
            </p>
          </div>
        );
      })}
    </div>
  );
}

export const BOARD_HOUR = HOUR;

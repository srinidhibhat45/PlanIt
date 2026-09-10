/** Week / whole-trip grid. Coarse planning: see the shape of the trip, drag a
 *  block from one day to another, spot the empty evenings. */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ClockMode, ID, Issue, Segment, Trip } from '../core/types';
import { DAY, dateKey, dateKeyToEpoch, eachDay, fmtDate, fmtTime, toParts } from '../core/time';
import { attendeesOf } from '../core/schedule';
import { axisZone } from '../core/clock';
import { iconFor } from '../core/ics';
import { describeSegment, initials } from './SegmentChrome';

/** How many blocks a day cell shows before it defers to the day view. */
const MAX_PILLS = 6;

export function WeekView({
  trip, segments, clock, selectedId, issues, now, onSelect, onShiftDays, onAnnounce, onOpenDay,
}: {
  trip: Trip; segments: Segment[]; clock: ClockMode; selectedId: ID | null; issues: Issue[]; now: number;
  onSelect: (id: ID) => void;
  onShiftDays: (id: ID, days: number) => void;
  onAnnounce: (t: string) => void;
  onOpenDay: (key: string) => void;
}) {
  const zone = axisZone(clock, trip);
  const cellRefs = useRef(new Map<string, HTMLDivElement>());
  const [dragging, setDragging] = useState<{ id: ID; fromKey: string; overKey: string } | null>(null);

  const days = useMemo(() => {
    if (!segments.length) return eachDay(Date.now(), Date.now() + 6 * DAY, zone);
    const lo = Math.min(...segments.map((s) => s.start));
    const hi = Math.max(...segments.map((s) => s.end));
    return eachDay(lo, hi, zone);
  }, [segments, zone]);

  const byDay = useMemo(() => {
    const m = new Map<string, Segment[]>();
    for (const s of segments) {
      const k = dateKey(s.start, zone);
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    for (const [, v] of m) v.sort((a, b) => a.start - b.start);
    return m;
  }, [segments, zone]);

  const errorIds = useMemo(() => {
    const s = new Set<ID>();
    for (const i of issues) if (i.severity === 'error') i.segmentIds.forEach((x) => s.add(x));
    return s;
  }, [issues]);

  const keyAt = useCallback((x: number, y: number): string | null => {
    for (const [k, el] of cellRefs.current) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return k;
    }
    return null;
  }, []);

  const todayKey = dateKey(now, zone);

  return (
    <div className="wk">
      <p className="sr-only" id="wk-help">
        Whole-trip grid. Each cell is one day. Select a block and press shift with left or right
        arrow to move it a day earlier or later.
      </p>
      <div className="wk__grid" style={{ ['--cols' as string]: Math.min(7, days.length) }} aria-describedby="wk-help">
        {days.map((key) => {
          const epoch = dateKeyToEpoch(key, zone);
          const p = toParts(epoch, zone);
          const items = byDay.get(key) ?? [];
          // A conference day can hold fourteen blocks. Rendering them all makes
          // one cell dictate the height of the whole row and pushes its text
          // past its own border, so the grid shows the shape of the day and
          // hands the detail to the day view.
          const shown = items.length > MAX_PILLS ? items.slice(0, MAX_PILLS - 1) : items;
          const hidden = items.length - shown.length;
          return (
            <div
              key={key}
              className="wk__cell"
              ref={(el) => { if (el) cellRefs.current.set(key, el); else cellRefs.current.delete(key); }}
              data-today={key === todayKey}
              data-droppable={dragging?.overKey === key && dragging.fromKey !== key ? 'over' : undefined}
            >
              <div className="wk__cellhead">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => onOpenDay(key)}
                  aria-label={`Open ${fmtDate(epoch, zone, 'long')} in the day view`}
                >
                  <span className="wk__date">{String(p.day).padStart(2, '0')}</span>
                  <span className="wk__dow">{fmtDate(epoch, zone, 'weekday')}</span>
                </button>
                {items.length > 0 && <span className="chip">{items.length}</span>}
              </div>

              <ul className="wk__list">
                {shown.map((seg) => (
                  <li key={seg.id}>
                    <button
                      type="button"
                      className="wk__pill"
                      data-kind={seg.kind}
                      aria-selected={selectedId === seg.id}
                      title={describeSegment(seg, trip, clock)}
                      aria-label={describeSegment(seg, trip, clock)}
                      style={dragging?.id === seg.id ? { opacity: 0.4 } : undefined}
                      onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        setDragging({ id: seg.id, fromKey: key, overKey: key });
                      }}
                      onPointerMove={(e) => {
                        if (!dragging || dragging.id !== seg.id) return;
                        const over = keyAt(e.clientX, e.clientY);
                        if (over && over !== dragging.overKey) setDragging({ ...dragging, overKey: over });
                      }}
                      onPointerUp={() => {
                        if (dragging?.id === seg.id && dragging.overKey !== dragging.fromKey) {
                          const delta =
                            Math.round((dateKeyToEpoch(dragging.overKey, zone) - dateKeyToEpoch(dragging.fromKey, zone)) / DAY);
                          onShiftDays(seg.id, delta);
                          onAnnounce(`${seg.title} moved to ${fmtDate(dateKeyToEpoch(dragging.overKey, zone), zone, 'long')}.`);
                        } else {
                          onSelect(seg.id);
                        }
                        setDragging(null);
                      }}
                      onPointerCancel={() => setDragging(null)}
                      onKeyDown={(e) => {
                        if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                          e.preventDefault();
                          const d = e.key === 'ArrowRight' ? 1 : -1;
                          onShiftDays(seg.id, d);
                          onAnnounce(`${seg.title} moved ${d > 0 ? 'one day later' : 'one day earlier'}.`);
                        }
                        if (e.key === 'Enter') { e.preventDefault(); onSelect(seg.id); }
                      }}
                    >
                      <time className="mono">{fmtTime(seg.start, { zone })}</time>
                      <span className="truncate">{iconFor(seg)} {seg.title}</span>
                      {errorIds.has(seg.id) && <span aria-hidden="true" style={{ color: 'var(--danger-ink)' }}>▲</span>}
                    </button>
                  </li>
                ))}
              </ul>

              {hidden > 0 && (
                <button type="button" className="wk__more" onClick={() => onOpenDay(key)}>
                  {hidden} more →
                </button>
              )}

              {items.length === 0 && (
                <p className="wk__empty">Nothing planned</p>
              )}

              <WhoStrip segments={items} trip={trip} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A thin band showing which people have something on that day. */
function WhoStrip({ segments, trip }: { segments: Segment[]; trip: Trip }) {
  const active = new Set<ID>();
  for (const s of segments) attendeesOf(s, trip).forEach((id) => active.add(id));
  if (active.size === 0) return null;
  return (
    <div className="row" style={{ marginTop: 'auto', paddingTop: 'var(--s-2)', flexWrap: 'wrap', gap: 2 }}>
      {trip.people.map((p) => (
        <span
          key={p.id}
          className="avatar avatar--sm"
          style={{ ['--c' as string]: active.has(p.id) ? p.color : 'transparent', opacity: active.has(p.id) ? 1 : 0.22 }}
          title={`${p.name}${active.has(p.id) ? '' : ' — nothing scheduled'}`}
        >
          {active.has(p.id) ? initials(p.name) : ''}
        </span>
      ))}
      <span className="sr-only">
        {active.size} of {trip.people.length} people have something scheduled.
      </span>
    </div>
  );
}

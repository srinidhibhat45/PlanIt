/** One day, hours down the side, a column per person or group.
 *  The view people reach for when they ask "where do I need to be, and when?" */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClockMode, ID, Issue, LaneMode, Segment, Trip } from '../core/types';
import { HOUR, MIN, dateKeyToEpoch, fmtRange, fmtTime, snap } from '../core/time';
import { buildLanes, clipToDay, makeVScale, packColumns, segmentsOnDay, snapStepFor } from '../core/layout';
import { axisZone } from '../core/clock';
import { useDrag } from '../hooks/useDrag';
import { SegmentChrome, describeSegment } from './SegmentChrome';
import { IconPlus } from './Icons';
import { Tip } from './Tooltip';

const HEAD_H = 52;

/** Quarter-hours: fine enough to draw a real block, coarse enough to land on
 *  a time somebody would write down. Zone-aware, so a +5:45 zone still snaps
 *  to its own quarter-hours rather than to UTC's. */
const DRAW_SNAP_MIN = 15;

export function DayView({
  trip, segments, dayKey, laneMode, clock, issues, selectedId, now, personFilter,
  hourHeight, onSelect, onMove, onResize, onReassign, onAnnounce, onCreateRange, onAddInLane,
}: {
  trip: Trip; segments: Segment[]; dayKey: string; laneMode: LaneMode; clock: ClockMode;
  issues: Issue[]; selectedId: ID | null; now: number; personFilter: ID[];
  hourHeight: number;
  onSelect: (id: ID | null) => void;
  onMove: (id: ID, deltaMs: number, snapMin: number) => void;
  onResize: (id: ID, edge: 'start' | 'end', deltaMs: number, snapMin: number) => void;
  onReassign: (id: ID, fromLane: string, toLane: string) => void;
  onAnnounce: (t: string) => void;
  /** Drag down an empty column to add something there — the same gesture the
   *  timeline uses, so the two views do not have to be learned separately. */
  onCreateRange: (start: number, end: number, laneId: string) => void;
  /** The "+" on a column head: a block in this column, on this day. */
  onAddInLane: (laneId: string) => void;
}) {
  const zone = axisZone(clock, trip);
  const dayStart = useMemo(() => dateKeyToEpoch(dayKey, zone), [dayKey, zone]);
  const vscale = useMemo(() => makeVScale(dayStart, hourHeight), [dayStart, hourHeight]);
  const snapMin = snapStepFor(hourHeight * 2);
  const colRefs = useRef<(HTMLDivElement | null)[]>([]);

  /* Drawing a new block, exactly as on the timeline but down instead of
     across. It replaces a double-click, which nothing in the UI could tell
     you about — the view hint had been claiming a single click worked. */
  const [draft, setDraft] = useState<{ lane: number; from: number; to: number } | null>(null);
  const draftRef = useRef<typeof draft>(null);
  draftRef.current = draft;

  const startDraft = (e: React.PointerEvent, laneIndex: number, laneId: string) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.seg')) return;

    const body = e.currentTarget as HTMLElement;
    const top = body.getBoundingClientRect().top;
    const at = (clientY: number) => snap(vscale.t(clientY - top), DRAW_SNAP_MIN, zone);
    body.setPointerCapture(e.pointerId);
    setDraft({ lane: laneIndex, from: at(e.clientY), to: at(e.clientY) });

    const move = (ev: PointerEvent) => setDraft((d) => (d ? { ...d, to: at(ev.clientY) } : d));
    const finish = () => {
      const d = draftRef.current;
      cleanup();
      setDraft(null);
      if (!d) return;
      const from = Math.min(d.from, d.to);
      const to = Math.max(d.from, d.to);
      onCreateRange(from, from + (to - from < 15 * MIN ? 60 * MIN : to - from), laneId);
    };
    const abort = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { cleanup(); setDraft(null); } };
    const cleanup = () => {
      body.releasePointerCapture?.(e.pointerId);
      body.removeEventListener('pointermove', move);
      body.removeEventListener('pointerup', finish);
      body.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', abort);
    };
    body.addEventListener('pointermove', move);
    body.addEventListener('pointerup', finish);
    body.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', abort);
  };

  const todays = useMemo(() => segmentsOnDay(segments, dayKey, zone), [segments, dayKey, zone]);
  const lanes = useMemo(() => {
    const built = buildLanes({
      trip, segments: todays,
      mode: laneMode === 'unified' ? 'unified' : laneMode,
      personIds: personFilter,
    });
    if (laneMode === 'unified') return built;
    // With no filter, empty person lanes are informative — they show who is
    // free. Once you have narrowed to specific people, they are just noise.
    const pruned = built.filter((l) => l.segments.length > 0);
    if (personFilter.length > 0) return pruned;
    return laneMode === 'person' ? built : pruned;
  }, [trip, todays, laneMode, personFilter]);

  const conflictIds = useMemo(() => {
    const s = new Set<ID>();
    for (const i of issues) if (i.severity === 'error') i.segmentIds.forEach((id) => s.add(id));
    return s;
  }, [issues]);

  const laneAt = useCallback((x: number, _y: number) => {
    for (let i = 0; i < colRefs.current.length; i++) {
      const r = colRefs.current[i]?.getBoundingClientRect();
      if (r && x >= r.left && x <= r.right) return i;
    }
    return -1;
  }, []);

  const drag = useDrag({
    axis: 'y',
    msPerPx: () => HOUR / hourHeight,
    laneAt: laneMode === 'person' ? laneAt : undefined,
    onCommit: ({ id, mode, deltaMs, laneIndex, originLane, viaKeyboard }) => {
      const seg = todays.find((s) => s.id === id);
      if (!seg) return;
      const step = viaKeyboard ? 0 : snapMin;
      if (mode === 'move') {
        if (Math.abs(deltaMs) >= MIN) onMove(id, deltaMs, step);
        if (laneMode === 'person' && laneIndex !== originLane && lanes[laneIndex] && lanes[originLane]) {
          onReassign(id, lanes[originLane].id, lanes[laneIndex].id);
        }
      } else {
        onResize(id, mode === 'resize-start' ? 'start' : 'end', deltaMs, step);
      }
      const shift = step > 0
        ? snap((mode === 'resize-end' ? seg.end : seg.start) + deltaMs, step, zone) - (mode === 'resize-end' ? seg.end : seg.start)
        : deltaMs;
      onAnnounce(
        `${seg.title} now ${fmtRange(
          seg.start + (mode !== 'resize-end' ? shift : 0),
          seg.end + (mode !== 'resize-start' ? shift : 0), { zone })}. Dropped.`,
      );
    },
    onPreview: (d) => {
      if (!d.viaKeyboard || (d.deltaMs === 0 && d.laneIndex === d.originLane)) return;
      const seg = todays.find((s) => s.id === d.id);
      if (!seg) return;
      const lane = lanes[d.laneIndex];
      onAnnounce(
        fmtRange(seg.start + (d.mode !== 'resize-end' ? d.deltaMs : 0),
                 seg.end + (d.mode !== 'resize-start' ? d.deltaMs : 0), { zone }) +
        (d.laneIndex !== d.originLane && lane ? `, ${lane.label}` : ''),
      );
    },
    onCancel: () => onAnnounce('Move cancelled.'),
  });

  const preview = (seg: Segment) => {
    const d = drag.state;
    if (!d || d.id !== seg.id) return { start: seg.start, end: seg.end, lane: null as number | null };
    const step = snapMin * MIN;
    const snapped = d.viaKeyboard ? d.deltaMs : Math.round(d.deltaMs / step) * step;
    if (d.mode === 'move') return { start: seg.start + snapped, end: seg.end + snapped, lane: d.laneIndex };
    if (d.mode === 'resize-start') return { start: Math.min(seg.start + snapped, seg.end - 5 * MIN), end: seg.end, lane: null };
    return { start: seg.start, end: Math.max(seg.end + snapped, seg.start + 5 * MIN), lane: null };
  };

  /* Open the day where the day actually starts, not at midnight. */
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = todays.length ? Math.min(...todays.map((s) => s.start)) : dayStart + 8 * HOUR;
    el.scrollTop = Math.max(0, vscale.y(first) - hourHeight);
  }, [dayKey, todays, vscale, hourHeight, dayStart]);

  const hours = Array.from({ length: 24 }, (_, i) => i);

  return (
    <div className="dg" ref={scrollRef} style={{ ['--hour-h' as string]: `${hourHeight}px`, ['--dg-head' as string]: `${HEAD_H}px` }}>
      <div className="dg__gutter">
        <div className="dg__gutter-head" />
        {hours.map((h) => (
          <div key={h} className="dg__hour">{String(h).padStart(2, '0')}:00</div>
        ))}
      </div>

      <div className="dg__cols" role="group" aria-label={`Schedule for ${dayKey}`}>
        {lanes.map((lane, li) => {
          const cols = packColumns(lane.segments);
          return (
            <div className="dg__col" key={lane.id} ref={(el) => { colRefs.current[li] = el; }}>
              <div className="dg__colhead">
                {lane.color && (
                  <span className="avatar avatar--sm" style={{ ['--c' as string]: lane.color }} aria-hidden="true">
                    {lane.label.split(' ').map((w) => w[0]).slice(0, 2).join('')}
                  </span>
                )}
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="dg__colname">{lane.label}</span>
                </span>
                <span className="chip">{lane.segments.length}</span>
                <Tip
                  label={`Add to ${lane.label}`}
                  hint="A new block in this column at ten in the morning. Or drag down the column to draw one at the time you want."
                >
                  <button
                    type="button" className="lane__add"
                    onClick={() => onAddInLane(lane.id)}
                    aria-label={`Add a block to ${lane.label}`}
                  >
                    <IconPlus size={13} />
                  </button>
                </Tip>
              </div>

              <div
                className="dg__body"
                style={{ height: vscale.height }}
                data-droppable={drag.state?.laneIndex === li && drag.state.originLane !== li ? 'over' : undefined}
                title={`Drag down an empty stretch to add something to ${lane.label}`}
                onPointerDown={(e) => startDraft(e, li, lane.id)}
              >
                {draft && draft.lane === li && (() => {
                  const from = Math.min(draft.from, draft.to);
                  const to = Math.max(draft.from, draft.to);
                  const y = vscale.y(from);
                  return (
                    <div className="dg__draft" style={{ top: y, height: Math.max(3, vscale.y(to) - y) }}>
                      <span className="dg__draftlabel mono">{fmtRange(from, to, { zone })}</span>
                    </div>
                  );
                })()}
                {lane.segments.map((seg) => {
                  const p = preview(seg);
                  const clip = clipToDay({ ...seg, start: p.start, end: p.end }, dayStart);
                  const top = vscale.y(clip.top);
                  const height = Math.max(18, vscale.y(clip.bottom) - top);
                  const c = cols.get(seg.id) ?? { col: 0, cols: 1 };
                  const widthPct = 100 / c.cols;
                  const hiddenElsewhere = p.lane !== null && p.lane !== li && drag.state?.id === seg.id;

                  return (
                    <div
                      key={seg.id}
                      data-seg-id={seg.id}
                      role="button"
                      tabIndex={0}
                      aria-selected={selectedId === seg.id}
                      aria-label={describeSegment(seg, trip, clock)}
                      className={`seg seg--vertical${drag.state?.id === seg.id && drag.state.engaged ? ' is-dragging' : ''}${hiddenElsewhere ? ' is-ghost' : ''}`}
                      data-kind={seg.kind}
                      data-status={seg.status}
                      data-conflict={conflictIds.has(seg.id)}
                      data-short={height < 46}
                      style={{
                        top, height,
                        left: `calc(${c.col * widthPct}% + 3px)`,
                        width: `calc(${widthPct}% - 6px)`,
                      }}
                      onPointerDown={(e) => {
                        if ((e.target as HTMLElement).dataset.grip) return;
                        drag.handlers.onPointerDown(e, seg.id, 'move', li);
                      }}
                      onPointerMove={drag.handlers.onPointerMove}
                      onPointerUp={() => {
                        const wasDrag = drag.state?.engaged;
                        drag.handlers.onPointerUp();
                        if (!wasDrag) onSelect(seg.id);
                      }}
                      onPointerCancel={drag.handlers.onPointerCancel}
                      onKeyDown={(e) => {
                        const grabbed = drag.state?.viaKeyboard && drag.state.id === seg.id;
                        const step = (e.shiftKey ? 5 : e.altKey ? 60 : snapMin) * MIN;
                        if (grabbed) {
                          if (e.key === 'ArrowUp') { e.preventDefault(); drag.nudge(-step, 0, lanes.length); }
                          if (e.key === 'ArrowDown') { e.preventDefault(); drag.nudge(step, 0, lanes.length); }
                          if (e.key === 'ArrowLeft') { e.preventDefault(); drag.nudge(0, -1, lanes.length); }
                          if (e.key === 'ArrowRight') { e.preventDefault(); drag.nudge(0, 1, lanes.length); }
                          return;
                        }
                        if (e.key === ' ') {
                          e.preventDefault(); drag.grab(seg.id, li);
                          onAnnounce(`Grabbed ${seg.title}. Up and down move by ${snapMin} minutes. Enter to drop, escape to cancel.`);
                        }
                        if (e.key === 'Enter') { e.preventDefault(); onSelect(seg.id); }
                      }}
                    >
                      <SegmentChrome
                        seg={seg} trip={trip} clock={clock} layout="block"
                        /* Each line needs about 17px, plus 8px of padding. Ask
                           for one more than fits and the lines paint over each
                           other and out of the box. */
                        lines={height < 22 ? 0 : height < 42 ? 1 : height < 74 ? 2 : 3}
                        showWho
                        conflicted={conflictIds.has(seg.id)}
                      />
                      {!seg.locked && height > 34 && (
                        <>
                          <span className="seg__grip seg__grip--start" data-grip="start" aria-hidden="true"
                            onPointerDown={(e) => { e.stopPropagation(); drag.handlers.onPointerDown(e, seg.id, 'resize-start', li); }}
                            onPointerMove={drag.handlers.onPointerMove} onPointerUp={() => drag.handlers.onPointerUp()} />
                          <span className="seg__grip seg__grip--end" data-grip="end" aria-hidden="true"
                            onPointerDown={(e) => { e.stopPropagation(); drag.handlers.onPointerDown(e, seg.id, 'resize-end', li); }}
                            onPointerMove={drag.handlers.onPointerMove} onPointerUp={() => drag.handlers.onPointerUp()} />
                        </>
                      )}
                    </div>
                  );
                })}

                {now >= dayStart && now < dayStart + 24 * HOUR && (
                  <div className="dg__now" style={{ top: vscale.y(now) }} aria-hidden="true">
                    <span className="sr-only">Now, {fmtTime(now, { zone })}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

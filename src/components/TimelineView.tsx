/** Horizontal timeline with swimlanes.
 *
 *  Interaction contract:
 *   - Pointer: drag a block to move it, drag its edges to resize, drag across
 *     lanes to reassign the person.
 *   - Keyboard: Tab into the grid once, then arrows move focus. Space grabs;
 *     while grabbed, arrows move the block (Shift = fine, Alt = coarse) and
 *     up/down change lane. Enter drops, Escape cancels.
 *   Every keyboard action is mirrored to a live region.  */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ClockMode, Density, ID, Issue, LaneMode, Segment, Trip } from '../core/types';
import { HOUR, MIN, clamp, dateKeyToEpoch, fmtDate, fmtRange, fmtDuration, snap } from '../core/time';
import {
  ZOOMS, buildLanes, dayBands, hourTicks, makeScale, nightBands, openingDay, snapStepFor,
  tripSpan, type Lane,
} from '../core/layout';
import { estimateTravel, overheadMinutes, trafficLabel, travelMinutes } from '../core/travel';
import { axisZone } from '../core/clock';
import { useDrag } from '../hooks/useDrag';
import { useMediaQuery } from '../hooks/useUi';
import { SegmentChrome, describeSegment } from './SegmentChrome';
import { IconPlus } from './Icons';
import { Tip } from './Tooltip';

const LANE_W = 208;
const LANE_W_SMALL = 128;

/** A press with no drag means "something here", not "something of no length",
 *  so it gets the same default hour the day grid gives a clicked slot. */
const DEFAULT_NEW_MIN = 60;

export interface TimelineProps {
  trip: Trip;
  segments: Segment[];
  laneMode: LaneMode;
  clock: ClockMode;
  density: Density;
  zoomIndex: number;
  issues: Issue[];
  selectedId: ID | null;
  now: number;
  personFilter: ID[];
  onSelect: (id: ID | null) => void;
  onMove: (id: ID, deltaMs: number, snapMin: number) => void;
  onResize: (id: ID, edge: 'start' | 'end', deltaMs: number, snapMin: number) => void;
  onReassign: (id: ID, fromLane: string, toLane: string) => void;
  onAnnounce: (text: string) => void;
  onZoom: (i: number) => void;
  /** Drag across an empty lane to add something to the plan there. `laneId` is
   *  the lane it was drawn in, so it lands on the right person. */
  onCreateRange: (start: number, end: number, laneId: string) => void;
  /** The "+" on a lane head: put a block in this lane on the current day,
   *  for anyone who has not discovered that you can draw one instead. */
  onAddInLane: (laneId: string) => void;
  /** Which day that "+" lands on, in words, so the tooltip can say so. */
  dayName: string;
  /** A lane per person means the way to get another lane is another person. */
  onAddPerson: () => void;
}

export function TimelineView(props: TimelineProps) {
  const {
    trip, segments, laneMode, clock, density, zoomIndex, issues, selectedId, now,
    personFilter, onSelect, onMove, onResize, onReassign, onAnnounce, onZoom, onCreateRange,
    onAddInLane, dayName, onAddPerson,
  } = props;

  const narrow = useMediaQuery('(max-width: 60rem)');
  const laneW = narrow ? LANE_W_SMALL : LANE_W;
  const rowH = density === 'compact' ? 32 : 44;
  const zone = axisZone(clock, trip);
  const pxPerHour = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, zoomIndex))];
  const snapMin = snapStepFor(pxPerHour);

  const scrollRef = useRef<HTMLDivElement>(null);
  const laneRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [focusedId, setFocusedId] = useState<ID | null>(null);

  /* The axis is the trip's span, not the visible segments' — filtering to one
     person must not rescale the plan under them, and an empty trip still opens
     on its own dates rather than on this week. */
  const range = useMemo(() => tripSpan(trip, zone, now), [trip, zone, now]);

  const scale = useMemo(
    () => makeScale(range.start, range.end, pxPerHour, zone),
    [range.start, range.end, pxPerHour, zone],
  );

  const lanes = useMemo(
    () => buildLanes({ trip, segments, mode: laneMode, personIds: personFilter }),
    [trip, segments, laneMode, personFilter],
  );

  const conflictIds = useMemo(() => {
    const s = new Set<ID>();
    for (const i of issues) if (i.severity === 'error') i.segmentIds.forEach((id) => s.add(id));
    return s;
  }, [issues]);

  /* ---------- drawing a new block on an empty lane ---------- */

  /* The plan has to get *into* the timeline somehow, and "open the details
     panel and type two timestamps" is not it. Drawing the block where it goes
     is: press on empty lane, drag out the hours, let go. A press with no drag
     makes the default hour, the way clicking an empty slot does in the day
     grid. */
  const [draft, setDraft] = useState<{ lane: number; from: number; to: number } | null>(null);
  const draftRef = useRef<typeof draft>(null);
  draftRef.current = draft;

  const startDraft = (e: React.PointerEvent, laneIndex: number) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    /* Blocks, their grips and the journey chips mean something else. The
       away shading does not: it covers most of an arrival day, and the day
       somebody arrives is exactly when you want to draw their airport run. */
    if (target.closest('.seg, .tl__gap')) return;

    const track = e.currentTarget as HTMLElement;
    const left = track.getBoundingClientRect().left;
    const at = snap(scale.t(e.clientX - left), snapMin, zone);
    track.setPointerCapture(e.pointerId);
    setDraft({ lane: laneIndex, from: at, to: at });

    const move = (ev: PointerEvent) => {
      setDraft((d) => (d ? { ...d, to: snap(scale.t(ev.clientX - left), snapMin, zone) } : d));
    };
    const finish = () => {
      const d = draftRef.current;
      cleanup();
      setDraft(null);
      if (!d) return;
      const from = Math.min(d.from, d.to);
      const to = Math.max(d.from, d.to);
      const span = to - from < 15 * MIN ? DEFAULT_NEW_MIN * MIN : to - from;
      const laneId = lanes[d.lane]?.id;
      if (!laneId) return;
      onCreateRange(from, from + span, laneId);
    };
    const abort = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { cleanup(); setDraft(null); } };
    const cleanup = () => {
      track.releasePointerCapture?.(e.pointerId);
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', finish);
      track.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', abort);
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', finish);
    track.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', abort);
  };

  /* ---------- dragging ---------- */

  const laneAt = useCallback((_x: number, y: number) => {
    for (let i = 0; i < laneRefs.current.length; i++) {
      const el = laneRefs.current[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) return i;
    }
    return -1;
  }, []);

  const drag = useDrag({
    axis: 'x',
    msPerPx: () => HOUR / pxPerHour,
    laneAt: laneMode === 'person' ? laneAt : undefined,
    onCommit: ({ id, mode, deltaMs, laneIndex, originLane, viaKeyboard }) => {
      const seg = segments.find((s) => s.id === id);
      if (!seg) return;
      // A pointer drag snaps to the grid — that is what makes it feel magnetic.
      // A keyboard nudge must land exactly where it said it would, so it
      // applies the delta verbatim.
      const step = viaKeyboard ? 0 : snapMin;
      if (mode === 'move') {
        if (Math.abs(deltaMs) >= MIN) onMove(id, deltaMs, step);
        if (laneMode === 'person' && laneIndex !== originLane) {
          const from = lanes[originLane]?.id;
          const to = lanes[laneIndex]?.id;
          if (from && to) onReassign(id, from, to);
        }
      } else {
        onResize(id, mode === 'resize-start' ? 'start' : 'end', deltaMs, step);
      }
      const shift = quantise(deltaMs, seg, mode, step, zone);
      const verb = mode === 'move' ? 'Moved' : 'Resized';
      const newStart = seg.start + (mode === 'move' || mode === 'resize-start' ? shift : 0);
      const newEnd = seg.end + (mode === 'move' || mode === 'resize-end' ? shift : 0);
      onAnnounce(
        `${verb} ${seg.title} to ${fmtRange(newStart, newEnd, { zone })}` +
        (laneIndex !== originLane && lanes[laneIndex] ? `, now ${lanes[laneIndex].label}` : '') +
        `. ${viaKeyboard ? 'Dropped.' : ''}`,
      );
    },
    onPreview: (d) => {
      // Announce keyboard movement from the live state, never from a closure
      // that may already be a keystroke behind.
      if (!d.viaKeyboard) return;
      if (d.deltaMs === 0 && d.laneIndex === d.originLane) return;
      const seg = segments.find((s) => s.id === d.id);
      if (!seg) return;
      const lane = lanes[d.laneIndex];
      const moved = d.mode === 'move';
      onAnnounce(
        `${fmtRange(seg.start + (moved || d.mode === 'resize-start' ? d.deltaMs : 0),
                    seg.end + (moved || d.mode === 'resize-end' ? d.deltaMs : 0), { zone })}` +
        (d.laneIndex !== d.originLane && lane ? `, ${lane.label}` : ''),
      );
    },
    onCancel: () => onAnnounce('Move cancelled, block returned to its original time.'),
  });

  const preview = useCallback((seg: Segment): { start: number; end: number; lane: number | null } => {
    const d = drag.state;
    if (!d || d.id !== seg.id) return { start: seg.start, end: seg.end, lane: null };
    const step = snapMin * MIN;
    const snapped = d.viaKeyboard ? d.deltaMs : Math.round(d.deltaMs / step) * step;
    if (d.mode === 'move') return { start: seg.start + snapped, end: seg.end + snapped, lane: d.laneIndex };
    if (d.mode === 'resize-start') return { start: Math.min(seg.start + snapped, seg.end - 5 * MIN), end: seg.end, lane: null };
    return { start: seg.start, end: Math.max(seg.end + snapped, seg.start + 5 * MIN), lane: null };
  }, [drag.state, snapMin]);

  /* ---------- keyboard ---------- */

  const flatOrder = useMemo(() => {
    const out: { id: ID; lane: number }[] = [];
    lanes.forEach((l, li) =>
      [...l.segments].sort((a, b) => a.start - b.start).forEach((s) => out.push({ id: s.id, lane: li })));
    return out;
  }, [lanes]);

  const focusSegment = useCallback((id: ID | null) => {
    setFocusedId(id);
    if (!id) return;
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-seg-id="${CSS.escape(id)}"]`);
      el?.focus();
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent, seg: Segment, laneIndex: number) => {
    const grabbed = drag.state?.viaKeyboard && drag.state.id === seg.id;
    const fine = e.shiftKey ? 5 : e.altKey ? 60 : snapMin;

    if (grabbed) {
      switch (e.key) {
        case 'ArrowLeft':  e.preventDefault(); return drag.nudge(-fine * MIN, 0, lanes.length);
        case 'ArrowRight': e.preventDefault(); return drag.nudge(fine * MIN, 0, lanes.length);
        case 'ArrowUp':    e.preventDefault(); return drag.nudge(0, -1, lanes.length);
        case 'ArrowDown':  e.preventDefault(); return drag.nudge(0, 1, lanes.length);
        default: return;
      }
    }

    switch (e.key) {
      case ' ':
      case 'Spacebar': {
        e.preventDefault();
        drag.grab(seg.id, laneIndex);
        onAnnounce(
          `Grabbed ${seg.title}. Arrow left and right move by ${snapMin} minutes, ` +
          `hold shift for 5 minutes or alt for an hour${laneMode === 'person' ? ', up and down change person' : ''}. ` +
          'Enter to drop, Escape to cancel.',
        );
        return;
      }
      case 'Enter': e.preventDefault(); onSelect(seg.id); return;
      case 'ArrowLeft': case 'ArrowRight': {
        e.preventDefault();
        const inLane = flatOrder.filter((f) => f.lane === laneIndex);
        const at = inLane.findIndex((f) => f.id === seg.id);
        const next = inLane[at + (e.key === 'ArrowRight' ? 1 : -1)];
        if (next) focusSegment(next.id);
        return;
      }
      case 'ArrowUp': case 'ArrowDown': {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        for (let li = laneIndex + dir; li >= 0 && li < lanes.length; li += dir) {
          const cand = nearestInLane(lanes[li], seg.start);
          if (cand) { focusSegment(cand.id); return; }
        }
        return;
      }
      case 'Home': { e.preventDefault(); const f = flatOrder.filter((x) => x.lane === laneIndex)[0]; if (f) focusSegment(f.id); return; }
      case 'End': {
        e.preventDefault();
        const l = flatOrder.filter((x) => x.lane === laneIndex);
        if (l.length) focusSegment(l[l.length - 1].id);
        return;
      }
      default: return;
    }
  }, [drag, flatOrder, lanes, laneMode, onAnnounce, onSelect, snapMin, focusSegment]);

  /* Zooming holds the moment under the middle of the viewport still, so the
     plan grows and shrinks around what you were looking at. */
  const lastZoom = useRef(pxPerHour);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || lastZoom.current === pxPerHour) return;
    const centreX = el.scrollLeft + el.clientWidth / 2 - laneW;
    const centreTime = range.start + (centreX / lastZoom.current) * HOUR;
    const nextX = ((centreTime - range.start) / HOUR) * pxPerHour + laneW;
    el.scrollLeft = Math.max(0, nextX - el.clientWidth / 2);
    lastZoom.current = pxPerHour;
  }, [pxPerHour, range.start, laneW]);

  /* ---------- where the timeline opens ---------- */

  /* On the day the trip starts, or on today if the trip is happening now —
     never on the left edge of the axis, which can be earlier than either when
     something is scheduled outside the trip's own dates. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const opening = dateKeyToEpoch(openingDay(trip, zone, now), zone);
    const target = clamp(opening, range.start, range.end);
    el.scrollLeft = Math.max(0, scale.x(target) - el.clientWidth * 0.08);
    lastZoom.current = pxPerHour;
    // Only on mount and when the trip's span changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.end]);

  const days = useMemo(() => dayBands(scale), [scale]);
  const nights = useMemo(() => nightBands(scale), [scale]);
  const ticks = useMemo(() => hourTicks(scale), [scale]);

  const totalW = scale.width;

  return (
    <div className="tl" ref={scrollRef} style={{ ['--lane-w' as string]: `${laneW}px`, ['--hour-w' as string]: `${pxPerHour}px` }}>
      <p id="tl-help" className="sr-only">
        Timeline grid. Use arrow keys to move between blocks. Press space to pick a block up,
        then arrows to move it in {snapMin}-minute steps; hold shift for 5 minutes or alt for one hour.
        Press enter to drop it, or escape to cancel. Press enter on a block to open its details.
      </p>

      {/* ---- ruler ---- */}
      <div className="tl__head" style={{ width: totalW + laneW }}>
        <div className="tl__corner">
          <span className="eyebrow">{LANE_TITLE[laneMode]}</span>
          <span className="mono" style={{ fontSize: '0.62rem', color: 'var(--ink-3)' }}>
            {zone.split('/').pop()?.replace(/_/g, ' ')}
          </span>
        </div>
        <div className="tl__ruler" style={{ width: totalW }}>
          {days.map((d) => (
            <div
              key={d.key}
              className="tl__day"
              data-weekend={d.weekend}
              style={{ left: scale.x(d.start), width: scale.x(d.end) - scale.x(d.start) }}
            >
              {fmtDate(d.start, zone, 'medium')}
              {d.weekend && <span className="tl__day-badge">wknd</span>}
            </div>
          ))}
          {ticks.map((t) => (
            <div key={t.t} className="tl__hour" data-major={t.major} style={{ left: scale.x(t.t) }}>
              {pxPerHour >= 20 ? t.label : ''}
            </div>
          ))}
        </div>
      </div>

      {/* ---- lanes ---- */}
      <div role="grid" aria-label="Itinerary timeline" aria-describedby="tl-help" style={{ width: totalW + laneW }}>
        {lanes.map((lane, li) => {
          const laneH = Math.max(1, lane.rowCount) * rowH + 8;
          const gaps = laneMode === 'person' ? travelGaps(lane, trip) : [];
          // An empty stretch of lane is ambiguous: is nothing planned, or is
          // this person not on the trip yet? Shading the ends and naming the
          // date answers the question the blank space raises.
          const away = laneMode === 'person' ? awayBands(lane, range, zone) : [];

          return (
            <div
              className="tl__lane"
              role="row"
              key={lane.id}
              ref={(el) => { laneRefs.current[li] = el; }}
              style={{ ['--lane-h' as string]: `${laneH}px` }}
            >
              <div className="tl__lanehead" role="rowheader" style={{ height: laneH }}>
                {lane.color && <span className="avatar avatar--sm" style={{ ['--c' as string]: lane.color }} aria-hidden="true">
                  {lane.label.split(' ').map((w) => w[0]).slice(0, 2).join('')}
                </span>}
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="tl__lanename">{lane.label}</span>
                  {lane.sublabel && <span className="tl__lanemeta">{lane.sublabel}</span>}
                </span>
                <Tip
                  label={`Add to ${lane.label}`}
                  hint={`A new block in this lane${dayName ? ` on ${dayName}` : ''}. Or drag across the lane to draw one at the time you want.`}
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
                className="tl__track"
                style={{ width: totalW, height: laneH }}
                data-droppable={drag.state?.laneIndex === li && drag.state.originLane !== li ? 'over' : undefined}
                title={`Drag across an empty stretch to add something to ${lane.label}`}
                onPointerDown={(e) => startDraft(e, li)}
              >
                {nights.map((n, i) => (
                  <div key={i} className="tl__night" style={{ left: scale.x(n.start), width: scale.x(n.end) - scale.x(n.start) }} />
                ))}

                {away.map((b) => {
                  const left = scale.x(b.from);
                  const w = scale.x(b.to) - left;
                  if (w < 24) return null;
                  return (
                    <div key={b.key} className="tl__away" style={{ left, width: w, height: laneH }} title={b.title}>
                      {w > 96 && <span className="tl__away-label">{b.label}</span>}
                    </div>
                  );
                })}
                {days.map((d) => <div key={d.key} className="tl__daybreak" style={{ left: scale.x(d.start) }} />)}

                {gaps.map((g) => {
                  const left = scale.x(g.from);
                  const w = scale.x(g.to) - left;
                  if (w < 46) return null;
                  return (
                    <div
                      key={g.key}
                      className="tl__gap"
                      data-level={g.level}
                      data-short={g.short}
                      style={{ left, width: w, top: laneH / 2 - 9 }}
                      title={g.title}
                    >
                      {w > 96 ? `${g.needMin}m · ${g.distanceKm}km` : `${g.needMin}m`}
                    </div>
                  );
                })}

                {lane.segments.map((seg) => {
                  const p = preview(seg);
                  const hidden = p.lane !== null && p.lane !== li && drag.state?.id === seg.id;
                  const left = scale.x(p.start);
                  const width = Math.max(4, scale.x(p.end) - left);
                  const row = lane.rows.get(seg.id) ?? 0;
                  const dragging = drag.state?.id === seg.id && drag.state.engaged;
                  // A timeline block is one line tall, so detail has to be
                  // dropped by width rather than wrapped. These thresholds are
                  // the widths at which each piece stops being readable.
                  const detail = width < 30 ? 0 : width < 132 ? 1 : width < 250 ? 2 : 3;

                  return (
                    <div
                      key={seg.id}
                      data-seg-id={seg.id}
                      role="gridcell"
                      tabIndex={focusedId === seg.id || (!focusedId && flatOrder[0]?.id === seg.id) ? 0 : -1}
                      aria-selected={selectedId === seg.id}
                      aria-grabbed={drag.state?.id === seg.id ? true : undefined}
                      aria-label={describeSegment(seg, trip, clock)}
                      className={`seg${dragging ? ' is-dragging' : ''}${hidden ? ' is-ghost' : ''}`}
                      data-kind={seg.kind}
                      data-status={seg.status}
                      data-conflict={conflictIds.has(seg.id)}
                      data-narrow={detail <= 1}
                      data-tiny={detail === 0}
                      title={detail < 3 ? describeSegment(seg, trip, clock) : undefined}
                      style={{ left, width, top: row * rowH + 4, height: rowH - 8 }}
                      onPointerDown={(e) => {
                        if ((e.target as HTMLElement).dataset.grip) return;
                        drag.handlers.onPointerDown(e, seg.id, 'move', li);
                      }}
                      onPointerMove={drag.handlers.onPointerMove}
                      onPointerUp={(e) => {
                        const wasDrag = drag.state?.engaged;
                        drag.handlers.onPointerUp(e);
                        if (!wasDrag) { onSelect(seg.id); setFocusedId(seg.id); }
                      }}
                      onPointerCancel={drag.handlers.onPointerCancel}
                      onKeyDown={(e) => onKeyDown(e, seg, li)}
                      onFocus={() => setFocusedId(seg.id)}
                    >
                      <SegmentChrome
                        seg={seg} trip={trip} clock={clock} layout="bar"
                        lines={detail === 0 ? 0 : 1}
                        showPlace={detail >= 3}
                        showTime={detail >= 2}
                        conflicted={conflictIds.has(seg.id)}
                      />
                      {width > 26 && !seg.locked && (
                        <>
                          <span
                            className="seg__grip seg__grip--start" data-grip="start" aria-hidden="true"
                            onPointerDown={(e) => { e.stopPropagation(); drag.handlers.onPointerDown(e, seg.id, 'resize-start', li); }}
                            onPointerMove={drag.handlers.onPointerMove}
                            onPointerUp={drag.handlers.onPointerUp}
                          />
                          <span
                            className="seg__grip seg__grip--end" data-grip="end" aria-hidden="true"
                            onPointerDown={(e) => { e.stopPropagation(); drag.handlers.onPointerDown(e, seg.id, 'resize-end', li); }}
                            onPointerMove={drag.handlers.onPointerMove}
                            onPointerUp={drag.handlers.onPointerUp}
                          />
                        </>
                      )}
                    </div>
                  );
                })}

                {draft && draft.lane === li && (() => {
                  const from = Math.min(draft.from, draft.to);
                  const to = Math.max(draft.from, draft.to);
                  const w = Math.max(2, scale.x(to) - scale.x(from));
                  return (
                    <div className="tl__draft" style={{ left: scale.x(from), width: w, height: rowH - 8 }}>
                      {w > 84 && (
                        <span className="tl__draftlabel mono">
                          {fmtRange(from, to, { zone })}
                        </span>
                      )}
                    </div>
                  );
                })()}

                {li === 0 && now >= range.start && now <= range.end && (
                  <div className="tl__now" style={{ left: scale.x(now), height: laneH }} aria-hidden="true" />
                )}
              </div>
            </div>
          );
        })}

        {/* A lane per person, so the empty row at the bottom is how you get
            another person. Nowhere else in the timeline says that. */}
        {laneMode === 'person' && (
          <div className="tl__lane tl__lane--add" role="row">
            <div className="tl__lanehead" role="rowheader">
              <Tip label="Add someone to the trip" hint="Everyone on the trip gets their own lane here, and their own clock.">
                <button className="btn btn--sm tl__addperson" onClick={onAddPerson}>
                  <IconPlus size={13} /> Add someone
                </button>
              </Tip>
            </div>
            <div className="tl__track tl__track--empty" style={{ width: totalW }} aria-hidden="true" />
          </div>
        )}
      </div>

      {/* live time readout while dragging with a pointer */}
      {drag.state?.pointer && drag.state.engaged && (() => {
        const seg = segments.find((s) => s.id === drag.state!.id);
        if (!seg) return null;
        const p = preview(seg);
        return (
          <div className="tl__cursor-time" style={{ left: drag.state.pointer.x + 14, top: drag.state.pointer.y - 30 }}>
            {fmtRange(p.start, p.end, { zone })} · {fmtDuration(p.end - p.start)}
          </div>
        );
      })()}

      <div className="sr-only" aria-live="polite">
        {lanes.length} lanes, {segments.length} blocks, {fmtDate(range.start, zone, 'long')} to {fmtDate(range.end, zone, 'long')}.
      </div>

      <ZoomHint zoomIndex={zoomIndex} onZoom={onZoom} />
    </div>
  );
}

function ZoomHint({ zoomIndex, onZoom }: { zoomIndex: number; onZoom: (i: number) => void }) {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      onZoom(Math.max(0, Math.min(ZOOMS.length - 1, zoomIndex + (e.deltaY > 0 ? -1 : 1))));
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [zoomIndex, onZoom]);
  return null;
}

const LANE_TITLE: Record<LaneMode, string> = {
  person: 'Person', group: 'Group', place: 'Place', kind: 'Type', unified: 'All',
};

function nearestInLane(lane: Lane | undefined, t: number): Segment | undefined {
  if (!lane?.segments.length) return undefined;
  return [...lane.segments].sort((a, b) => Math.abs(a.start - t) - Math.abs(b.start - t))[0];
}

/** What the reducer will actually apply, so announcements never lie. */
function quantise(deltaMs: number, seg: Segment, mode: string, snapMin: number, zone: string): number {
  if (snapMin <= 0) return deltaMs;
  const base = mode === 'resize-end' ? seg.end : seg.start;
  return snap(base + deltaMs, snapMin, zone) - base;
}

/** The stretches at either end of a lane where this person is not on the trip
 *  yet, or is already home. Returns nothing for a lane that spans the whole
 *  range — there is no blank to explain. */
function awayBands(lane: Lane, range: { start: number; end: number }, zone: string) {
  const out: { key: string; from: number; to: number; label: string; title: string }[] = [];
  if (!lane.segments.length) {
    out.push({
      key: `${lane.id}-none`, from: range.start, to: range.end,
      label: 'Nothing scheduled',
      title: `${lane.label} has nothing scheduled on this trip.`,
    });
    return out;
  }
  const first = Math.min(...lane.segments.map((s) => s.start));
  const last = Math.max(...lane.segments.map((s) => s.end));

  if (first > range.start) {
    out.push({
      key: `${lane.id}-pre`, from: range.start, to: first,
      label: `Arrives ${fmtDate(first, zone, 'medium')}`,
      title: `${lane.label} is not on the trip until ${fmtDate(first, zone, 'long')}.`,
    });
  }
  if (last < range.end) {
    out.push({
      key: `${lane.id}-post`, from: last, to: range.end,
      label: `Left ${fmtDate(last, zone, 'medium')}`,
      title: `${lane.label} leaves on ${fmtDate(last, zone, 'long')}.`,
    });
  }
  return out;
}

/** Journey ribbons between consecutive stops in one person's lane. */
function travelGaps(lane: Lane, trip: Trip) {
  const out: {
    key: string; from: number; to: number; needMin: number; distanceKm: number;
    level: string; short: boolean; title: string;
  }[] = [];
  const segs = [...lane.segments].sort((a, b) => a.start - b.start);

  for (let i = 0; i < segs.length - 1; i++) {
    const a = segs[i];
    const b = segs[i + 1];
    if (b.start <= a.end) continue;
    const fromP = trip.places.find((p) => p.id === (a.toPlaceId ?? a.placeId));
    const toP = trip.places.find((p) => p.id === (b.fromPlaceId ?? b.placeId));
    if (!fromP || !toP || fromP.id === toP.id) continue;

    const est = estimateTravel({ from: fromP, to: toP, mode: 'taxi', departAt: a.end });
    const needMin = travelMinutes(est) + overheadMinutes('taxi', fromP.kind, toP.kind);
    const have = (b.start - a.end) / MIN;
    const t = trafficLabel(est.trafficFactor);
    out.push({
      key: `${a.id}-${b.id}`, from: a.end, to: b.start,
      needMin, distanceKm: Math.round(est.distanceKm),
      level: t.level, short: have < needMin,
      title:
        `${fromP.name} → ${toP.name}: about ${needMin} min ` +
        `(${est.distanceKm} km, ${t.text}, ×${est.trafficFactor}). ` +
        `${Math.round(have)} min available.`,
    });
  }
  return out;
}

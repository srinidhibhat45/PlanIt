/** The planning canvas: a flow chart drawn on a calendar.
 *
 *  Days run across, hours run down, and every card sits at its own time — so
 *  the picture is the plan, not a drawing of it. Lines between cards are
 *  *people*, bundled: four travellers making the same hop is one thick line
 *  carrying four faces, which is the difference between a diagram and a
 *  hairball. A line that cannot be walked, driven or flown in the time allowed
 *  turns red and says by how much.
 *
 *  Three gestures do almost everything:
 *    · drag a card            → reschedule it, across days as well as hours
 *    · drag card → card       → send that card's people on to the next one
 *    · drag a face → card     → put that person on it
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClockMode, ID, Issue, Place, Segment, Trip } from '../core/types';
import {
  DEFAULT_CANVAS, buildCanvas, canvasHeight, fitHours, hitColumn, hourLines,
  nightSpans, timeAt, yFor, type CanvasEdge, type CanvasModel, type CanvasNode, type CanvasOptions,
} from '../core/canvas';
import { HOUR, MIN, dateKey, dateKeyToEpoch, eachDay, fmtDate, fmtDuration, fmtTime, snap } from '../core/time';
import { attendeesOf } from '../core/schedule';
import { axisZone } from '../core/clock';
import { branchMembers, branchStats } from '../core/branch';
import { KIND_LABEL } from '../core/layout';
import { PlaceSearch } from './PlaceSearch';
import { initials } from './SegmentChrome';
import {
  IconBoard, IconClose, IconGrab, IconLink, IconPlus, IconSearch, IconSparkle,
  IconWarn, IconZoomIn, IconZoomOut,
} from './Icons';

const HEADER_H = 34;
const BAND_H = 46;
const ZOOM_STEPS = [0.55, 0.72, 0.9, 1.15, 1.5, 2] as const;

export interface CanvasHandlers {
  onSelect: (id: ID | null) => void;
  /** Reschedule: a new start, in whatever track the card was dropped on. */
  onMove: (id: ID, start: number, branchId?: ID) => void;
  onCreate: (draft: { start: number; end: number; branchId?: ID; placeId?: ID; title?: string; kind?: Segment['kind'] }, place?: Place) => void;
  /** Everyone on `fromId` also does `toId`. */
  onConnect: (fromId: ID, toId: ID) => void;
  onAssign: (segmentId: ID, personId: ID, on: boolean) => void;
  onCreateBranch: (name: string, memberIds: ID[], segmentIds: ID[]) => void;
  onSetBranch: (ids: ID[], branchId?: ID) => void;
  onDeleteBranch: (id: ID, keep: boolean) => void;
  onAnnounce: (text: string) => void;
}

type Drag =
  | { kind: 'node'; nodeKey: ID; segId: ID; grabDx: number; grabDy: number; x: number; y: number; over: { branchId?: ID; start: number } | null }
  | { kind: 'wire'; fromKey: string; fromId: ID; x: number; y: number; overKey: string | null }
  | { kind: 'person'; personId: ID; x: number; y: number; overKey: string | null }
  | { kind: 'place'; place: Place; x: number; y: number; over: { branchId?: ID; start: number } | null };

export function CanvasView({
  trip, segments, clock, issues, selectedId, now, handlers,
}: {
  trip: Trip;
  segments: Segment[];
  clock: ClockMode;
  issues: Issue[];
  selectedId: ID | null;
  now: number;
  handlers: CanvasHandlers;
}) {
  const zone = axisZone(clock, trip);
  const scrollRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const [zoomIx, setZoomIx] = useState(3);
  const [multi, setMulti] = useState<ID[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hoverPerson, setHoverPerson] = useState<ID | null>(null);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [branchDraft, setBranchDraft] = useState<{ name: string; segmentIds: ID[] } | null>(null);

  /* ---------- the model ---------- */

  const days = useMemo(() => {
    const from = dateKeyToEpoch(trip.startDate, zone);
    const to = dateKeyToEpoch(trip.endDate, zone) + 12 * HOUR;
    const fromSegments = trip.segments.length
      ? eachDay(
        Math.min(from, ...trip.segments.map((s) => s.start)),
        Math.max(to, ...trip.segments.map((s) => s.end)),
        zone,
      )
      : eachDay(from, to, zone);
    return fromSegments;
  }, [trip.startDate, trip.endDate, trip.segments, zone]);

  const options = useMemo<CanvasOptions>(() => {
    const scale = ZOOM_STEPS[zoomIx];
    const { hourStart, hourEnd } = fitHours(trip.segments, days, zone);
    return {
      ...DEFAULT_CANVAS,
      zone, days, hourStart, hourEnd,
      pxPerMin: DEFAULT_CANVAS.pxPerMin * scale,
      trackWidth: Math.round(DEFAULT_CANVAS.trackWidth * Math.min(1.35, Math.max(0.75, scale))),
    };
  }, [trip.segments, days, zone, zoomIx]);

  const model = useMemo<CanvasModel>(
    () => buildCanvas(trip, segments, options),
    [trip, segments, options],
  );

  const issueBySegment = useMemo(() => {
    const map = new Map<ID, Issue[]>();
    for (const i of issues) for (const sid of i.segmentIds) map.set(sid, [...(map.get(sid) ?? []), i]);
    return map;
  }, [issues]);

  const selection = useMemo(
    () => new Set<ID>(multi.length ? multi : selectedId ? [selectedId] : []),
    [multi, selectedId],
  );

  /* ---------- pointer geometry ---------- */

  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const el = surfaceRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }, []);

  /** Where a drop at this point lands, snapped to five minutes. */
  const dropAt = useCallback((x: number, y: number) => {
    const hit = hitColumn(model, x);
    if (!hit) return null;
    const raw = timeAt(y, hit.column.dayStart, options);
    return { branchId: hit.track.branchId, start: snap(raw, 5, zone) };
  }, [model, options, zone]);

  /* ---------- drag machine ----------
     Tracking is wired up synchronously from the pointerdown handler rather
     than from an effect. An effect only runs after React has committed, and a
     fast gesture — a flick of the wrist, or a synthetic event sequence — can
     deliver its first move before that, which would silently drop the drag. */

  const dragRef = useRef<Drag | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  const setDragState = useCallback((next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  /** Everything the pointer handlers need, kept in a ref so the listeners
   *  installed at pointerdown never read a stale closure. */
  const liveRef = useRef({ dropAt, toCanvas, model, trip, handlers, zone });
  liveRef.current = { dropAt, toCanvas, model, trip, handlers, zone };

  const endDrag = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
  }, []);

  const commit = useCallback(() => {
    const d = dragRef.current;
    const { model: m, trip: t, handlers: h, zone: z } = liveRef.current;
    if (!d) return;

    if (d.kind === 'node' && d.over) {
      const seg = t.segments.find((s) => s.id === d.segId);
      if (seg && (seg.start !== d.over.start || (seg.branchId ?? undefined) !== d.over.branchId)) {
        h.onMove(d.segId, d.over.start, d.over.branchId);
        h.onAnnounce(
          `Moved “${seg.title}” to ${fmtDate(d.over.start, z, 'medium')} ${fmtTime(d.over.start, { zone: z })}.`,
        );
      }
    }
    if (d.kind === 'wire' && d.overKey) {
      const target = m.nodeByKey.get(d.overKey);
      if (target && target.id !== d.fromId) {
        h.onConnect(d.fromId, target.id);
        const from = t.segments.find((s) => s.id === d.fromId);
        h.onAnnounce(`Everyone on “${from?.title}” now also does “${target.seg.title}”.`);
      }
    }
    if (d.kind === 'person' && d.overKey) {
      const target = m.nodeByKey.get(d.overKey);
      if (target) {
        const already = target.attendees.includes(d.personId);
        h.onAssign(target.id, d.personId, !already);
        const who = t.people.find((p) => p.id === d.personId)?.name ?? 'They';
        h.onAnnounce(`${who} ${already ? 'removed from' : 'added to'} “${target.seg.title}”.`);
      }
    }
    if (d.kind === 'place' && d.over) {
      h.onCreate(
        {
          start: d.over.start,
          end: d.over.start + (d.place.dwellMin ?? 90) * MIN,
          branchId: d.over.branchId,
          title: d.place.name,
          kind: kindForPlace(d.place),
        },
        d.place,
      );
      h.onAnnounce(`Added ${d.place.name} at ${fmtTime(d.over.start, { zone: z })}.`);
    }
  }, []);

  const beginDrag = useCallback((next: Drag) => {
    stopRef.current?.();
    setDragState(next);

    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const { x, y } = liveRef.current.toCanvas(e.clientX, e.clientY);
      if (d.kind === 'node') {
        setDragState({ ...d, x, y, over: liveRef.current.dropAt(x - d.grabDx, y - d.grabDy) });
      } else if (d.kind === 'place') {
        setDragState({ ...d, x, y, over: liveRef.current.dropAt(x, y) });
      } else {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const host = el?.closest<HTMLElement>('[data-node-key]');
        setDragState({ ...d, x, y, overKey: host?.dataset.nodeKey ?? null });
      }
      autoScroll(scrollRef.current, e.clientX, e.clientY);
    };

    const up = () => { commit(); setDragState(null); stop(); };
    const cancelKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setDragState(null); stop(); }
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', cancelKey);
      stopRef.current = null;
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', cancelKey);
    stopRef.current = stop;
  }, [commit, setDragState]);

  useEffect(() => endDrag, [endDrag]);

  /* ---------- derived visuals ---------- */

  const dimPerson = hoverPerson ?? (drag?.kind === 'person' ? drag.personId : null);
  const lines = useMemo(() => hourLines(options), [options]);
  const nights = useMemo(() => nightSpans(options), [options]);
  const height = canvasHeight(options);

  const nowY = useMemo(() => {
    const key = dateKey(now, zone);
    const column = model.columns.find((c) => c.dayKey === key);
    if (!column) return null;
    const mins = (now - column.dayStart) / MIN;
    const y = yFor(mins, options);
    return y >= 0 && y <= height ? { x: column.x, w: column.width, y } : null;
  }, [now, zone, model.columns, options, height]);

  /* ---------- actions ---------- */

  const createAt = (x: number, y: number) => {
    const at = dropAt(x, y);
    if (!at) return;
    handlers.onCreate({ start: at.start, end: at.start + 90 * MIN, branchId: at.branchId });
  };

  const toggleSelect = (id: ID, additive: boolean) => {
    if (!additive) { setMulti([]); handlers.onSelect(id); return; }
    setMulti((prev) => {
      const base = prev.length ? prev : selectedId ? [selectedId] : [];
      const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
      handlers.onSelect(next[next.length - 1] ?? null);
      return next;
    });
  };

  const makeBranch = () => {
    const ids = [...selection];
    if (!ids.length) return;
    // Name it after where the group is going, not after whichever card was
    // clicked first: "Bull Temple group" beats "EK 22 · Manchester → Dubai group".
    const chosen = trip.segments
      .filter((s) => ids.includes(s.id))
      .sort((a, b) => a.start - b.start);
    const first = chosen[0];
    const place = trip.places.find((p) => p.id === (first?.placeId ?? first?.toPlaceId));
    const label = (place?.name ?? first?.title ?? '').split(/[·(]/)[0].trim();
    setBranchDraft({
      name: label ? `${label.slice(0, 26)} group` : 'Side trip',
      segmentIds: ids,
    });
  };

  if (!trip.people.length && !trip.segments.length) {
    return <CanvasEmpty onCreate={() => handlers.onCreate({
      start: dateKeyToEpoch(trip.startDate, zone) + 10 * HOUR,
      end: dateKeyToEpoch(trip.startDate, zone) + 12 * HOUR,
    })} />;
  }

  return (
    <div className="cv" data-dragging={drag ? drag.kind : undefined}>
      <div className="cv__tools">
        <button className="btn btn--sm btn--primary" onClick={() => {
          const start = dateKeyToEpoch(model.columns[0]?.dayKey ?? trip.startDate, zone) + 10 * HOUR;
          handlers.onCreate({ start, end: start + 90 * MIN });
        }}>
          <IconPlus size={14} /> Block
        </button>

        <button className="btn btn--sm" aria-pressed={shelfOpen} onClick={() => setShelfOpen((s) => !s)}>
          <IconSearch size={14} /> Places
        </button>

        <span className="cv__sep" role="separator" />

        <button
          className="btn btn--sm" disabled={selection.size === 0} onClick={makeBranch}
          title="Peel the selected cards off into a sub-trip"
        >
          <IconBoard size={14} /> Sub-trip{selection.size > 0 && ` (${selection.size})`}
        </button>
        {selection.size > 0 && (
          <>
            <button className="btn btn--sm btn--ghost" onClick={() => handlers.onSetBranch([...selection], undefined)}>
              Back to main
            </button>
            <button className="btn btn--sm btn--ghost" onClick={() => { setMulti([]); handlers.onSelect(null); }}>
              Clear
            </button>
          </>
        )}

        <span className="grow" />

        {trip.branches.length > 0 && (
          <span className="cv__legend">
            {trip.branches.map((b) => {
              const st = branchStats(trip, b);
              return (
                <button
                  key={b.id} className="cv__legendchip" style={{ ['--c' as string]: b.color }}
                  onClick={() => handlers.onSetBranch([...selection], b.id)}
                  disabled={selection.size === 0}
                  title={selection.size ? `Move ${selection.size} selected into ${b.name}` : `${b.name}: ${st.members} people, ${st.segments} stops`}
                >
                  <span className="cv__legenddot" />
                  {b.name}
                  <span className="cv__legendn">{st.members}</span>
                </button>
              );
            })}
          </span>
        )}

        <span className="cv__zoom">
          <button className="btn btn--icon btn--sm btn--ghost" onClick={() => setZoomIx((z) => Math.max(0, z - 1))}
            disabled={zoomIx === 0} aria-label="Zoom out"><IconZoomOut size={14} /></button>
          <span className="cv__zoomv mono">{Math.round(ZOOM_STEPS[zoomIx] * 100)}%</span>
          <button className="btn btn--icon btn--sm btn--ghost" onClick={() => setZoomIx((z) => Math.min(ZOOM_STEPS.length - 1, z + 1))}
            disabled={zoomIx === ZOOM_STEPS.length - 1} aria-label="Zoom in"><IconZoomIn size={14} /></button>
        </span>
      </div>

      <div className="cv__frame">
        <div className="cv__scroll" ref={scrollRef}>
          <div className="cv__inner" style={{ width: model.width, height: height + HEADER_H + BAND_H }}>

            {/* --- day headers and the who-is-here band --- */}
            <div className="cv__head" style={{ width: model.width, height: HEADER_H + BAND_H }}>
              <div className="cv__corner" style={{ width: options.gutter }}>
                <span className="cv__cornerlabel">{zone.split('/').pop()?.replace(/_/g, ' ')}</span>
              </div>
              {model.columns.map((col) => (
                <DayHeader
                  key={col.dayKey}
                  col={col} zone={zone} trip={trip} model={model}
                  dimPerson={dimPerson}
                  onHoverPerson={setHoverPerson}
                  onGrabPerson={(personId, e) => {
                    const { x, y } = toCanvas(e.clientX, e.clientY);
                    beginDrag({ kind: 'person', personId, x, y, overKey: null });
                  }}
                  onDeleteBranch={handlers.onDeleteBranch}
                />
              ))}
            </div>

            {/* --- the grid surface --- */}
            <div
              className="cv__surface"
              ref={surfaceRef}
              style={{ width: model.width, height, top: HEADER_H + BAND_H }}
              onDoubleClick={(e) => {
                if ((e.target as HTMLElement).closest('[data-node-key]')) return;
                const { x, y } = toCanvas(e.clientX, e.clientY);
                createAt(x, y);
              }}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement).closest('[data-node-key]')) return;
                if (e.shiftKey) return;
                setMulti([]);
                handlers.onSelect(null);
              }}
            >
              {/* hour rules and night shading */}
              {nights.map((n, i) => (
                <div className="cv__night" key={i} style={{ top: n.top, height: n.height, width: model.width }} />
              ))}
              {lines.map((l) => (
                <div className="cv__rule" key={l.hour} data-major={l.major || undefined}
                  style={{ top: l.y, width: model.width }} />
              ))}

              {/* day columns and their tracks */}
              {model.columns.map((col) => (
                <div key={col.dayKey} className="cv__col" data-weekend={col.weekend || undefined}
                  style={{ left: col.x, width: col.width, height }}>
                  {col.tracks.map((t) => (
                    <div
                      key={t.id} className="cv__track" data-branch={t.branchId ? 'yes' : undefined}
                      style={{ left: t.x, width: t.width, height, ['--c' as string]: t.color ?? 'transparent' }}
                    />
                  ))}
                </div>
              ))}

              {/* free-time bands for whoever is being hovered */}
              {dimPerson && model.presence
                .filter((p) => p.personId === dimPerson && p.present)
                .flatMap((p) => {
                  const col = model.columns.find((c) => c.dayKey === p.dayKey);
                  if (!col) return [];
                  return p.free.map((f, i) => (
                    <div
                      key={`${p.dayKey}-${i}`} className="cv__free"
                      style={{
                        left: col.x, width: col.width,
                        top: yFor(f.fromMin, options),
                        height: yFor(f.toMin, options) - yFor(f.fromMin, options),
                        ['--c' as string]: trip.people.find((x) => x.id === dimPerson)?.color ?? 'var(--accent)',
                      }}
                    >
                      <span className="cv__freelabel">free</span>
                    </div>
                  ));
                })}

              {/* the flows */}
              <svg className="cv__wires" width={model.width} height={height} aria-hidden="true">
                <defs>
                  <marker id="cv-arrow" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                    <path d="M1 1 L7 4 L1 7 z" fill="context-stroke" />
                  </marker>
                </defs>
                {model.edges.map((edge) => (
                  <EdgeLine
                    key={edge.key} edge={edge} trip={trip}
                    dim={dimPerson !== null && !edge.personIds.includes(dimPerson)}
                    lit={selection.has(edge.fromId) || selection.has(edge.toId)}
                  />
                ))}
                {drag?.kind === 'wire' && <WireGhost drag={drag} model={model} />}
              </svg>

              {/* edge labels sit above the wires so they stay readable */}
              {model.edges.filter((e) => !e.feasible || e.personIds.length > 1).map((edge) => (
                <EdgeChip
                  key={`c-${edge.key}`} edge={edge} trip={trip}
                  dim={dimPerson !== null && !edge.personIds.includes(dimPerson)}
                />
              ))}

              {/* now line */}
              {nowY && (
                <div className="cv__now" style={{ left: nowY.x, width: nowY.w, top: nowY.y }}>
                  <span className="cv__nowdot" />
                </div>
              )}

              {/* the cards */}
              {model.nodes.map((node) => (
                <NodeCard
                  key={node.key}
                  node={node} trip={trip} zone={zone}
                  selected={selection.has(node.id)}
                  dim={dimPerson !== null && !node.attendees.includes(dimPerson)}
                  dropTarget={(drag?.kind === 'wire' || drag?.kind === 'person') && drag.overKey === node.key}
                  dragging={drag?.kind === 'node' && drag.segId === node.id}
                  issues={issueBySegment.get(node.id) ?? []}
                  onSelect={(additive) => toggleSelect(node.id, additive)}
                  onGrab={(e) => {
                    const { x, y } = toCanvas(e.clientX, e.clientY);
                    beginDrag({
                      kind: 'node', nodeKey: node.key, segId: node.id,
                      grabDx: x - node.x, grabDy: y - node.y, x, y, over: null,
                    });
                  }}
                  onWire={(e) => {
                    const { x, y } = toCanvas(e.clientX, e.clientY);
                    beginDrag({ kind: 'wire', fromKey: node.key, fromId: node.id, x, y, overKey: null });
                  }}
                  onHoverPerson={setHoverPerson}
                />
              ))}

              {/* drop preview */}
              {drag?.kind === 'node' && drag.over && <DropGhost model={model} drag={drag} options={options} zone={zone} trip={trip} />}
              {drag?.kind === 'place' && drag.over && (
                <div className="cv__placeghost" style={{
                  left: drag.x - 90, top: drag.y - 14,
                }}>
                  {drag.place.name} · {fmtTime(drag.over.start, { zone })}
                </div>
              )}
            </div>
          </div>
        </div>

        {shelfOpen && (
          <aside className="cv__shelf" aria-label="Places">
            <div className="row row--between">
              <h3 className="cv__shelfhead">Add a place</h3>
              <button className="btn btn--icon btn--sm btn--ghost" onClick={() => setShelfOpen(false)} aria-label="Close places panel">
                <IconClose size={14} />
              </button>
            </div>
            <p className="cv__shelfhelp">
              Search, or paste a Google Maps link. Drag a card onto the grid to put it on a day —
              or press its button to drop it on the first free morning.
            </p>
            <PlaceSearch
              zone={trip.baseTimezone}
              existing={trip.places}
              near={trip.places[0] ? { lat: trip.places[0].lat, lon: trip.places[0].lon } : undefined}
              autoFocus
              onPick={(place) => {
                const start = dateKeyToEpoch(model.columns[0]?.dayKey ?? trip.startDate, zone) + 10 * HOUR;
                handlers.onCreate(
                  { start, end: start + (place.dwellMin ?? 90) * MIN, title: place.name, kind: kindForPlace(place) },
                  place,
                );
                handlers.onAnnounce(`${place.name} added to ${fmtDate(start, zone, 'medium')}.`);
              }}
            />

            {trip.places.length > 0 && (
              <>
                <p className="label" style={{ marginTop: 'var(--s-4)' }}>On this trip · drag onto a day</p>
                <ul className="cv__cards">
                  {trip.places.map((p) => (
                    <li key={p.id}>
                      <div
                        className="cv__placecard"
                        onPointerDown={(e) => {
                          e.preventDefault();
                          const { x, y } = toCanvas(e.clientX, e.clientY);
                          beginDrag({ kind: 'place', place: p, x, y, over: null });
                        }}
                      >
                        <IconGrab size={13} />
                        <span className="grow truncate">{p.name}</span>
                        {p.url && (
                          <a
                            className="cv__placelink" href={p.url} target="_blank" rel="noreferrer noopener"
                            onPointerDown={(e) => e.stopPropagation()}
                            aria-label={`Open ${p.name} in maps`}
                          >
                            <IconLink size={12} />
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        )}
      </div>

      {/* hour gutter, painted over the scroller so it never scrolls away */}
      <HourGutter options={options} lines={lines} topOffset={HEADER_H + BAND_H} scrollRef={scrollRef} />

      {branchDraft && (
        <BranchDialog
          trip={trip} draft={branchDraft}
          onClose={() => setBranchDraft(null)}
          onCreate={(name, memberIds) => {
            handlers.onCreateBranch(name, memberIds, branchDraft.segmentIds);
            setBranchDraft(null);
            setMulti([]);
          }}
        />
      )}
    </div>
  );
}

/* ============================================================ */

function DayHeader({
  col, zone, trip, model, dimPerson, onHoverPerson, onGrabPerson, onDeleteBranch,
}: {
  col: CanvasModel['columns'][number];
  zone: string; trip: Trip; model: CanvasModel;
  dimPerson: ID | null;
  onHoverPerson: (id: ID | null) => void;
  onGrabPerson: (id: ID, e: React.PointerEvent) => void;
  onDeleteBranch: (id: ID, keep: boolean) => void;
}) {
  const here = model.presence.filter((p) => p.dayKey === col.dayKey && p.present);
  const arriving = here.filter((p) => {
    const prev = model.presence.find(
      (x) => x.personId === p.personId && x.dayKey === model.columns[col.index - 1]?.dayKey,
    );
    return col.index === 0 ? true : !prev?.present;
  });

  return (
    <div className="cv__day" style={{ left: col.x, width: col.width }} data-weekend={col.weekend || undefined}>
      <div className="cv__dayhead">
        <span className="cv__dayname">{fmtDate(col.dayStart, zone, 'weekday')}</span>
        <span className="cv__daydate">{fmtDate(col.dayStart, zone, 'medium')}</span>
        <span className="grow" />
        <span className="cv__daycount">{here.length ? `${here.length} here` : '—'}</span>
      </div>

      <div className="cv__band">
        <div className="cv__faces">
          {here.map((p) => {
            const person = trip.people.find((x) => x.id === p.personId);
            if (!person) return null;
            const isNew = arriving.includes(p);
            return (
              <button
                key={p.personId}
                className="cv__face"
                style={{ ['--c' as string]: person.color }}
                data-dim={dimPerson !== null && dimPerson !== p.personId ? 'yes' : undefined}
                data-new={isNew || undefined}
                title={`${person.name}${isNew ? ' — arrives' : ''} · ${Math.round(p.busyMin / 60)} h booked, ${p.free.length} free ${p.free.length === 1 ? 'gap' : 'gaps'}. Drag onto a card to add them.`}
                onPointerEnter={() => onHoverPerson(p.personId)}
                onPointerLeave={() => onHoverPerson(null)}
                onPointerDown={(e) => { e.preventDefault(); onGrabPerson(p.personId, e); }}
              >
                {initials(person.name)}
                {isNew && <span className="cv__facenew" aria-hidden="true" />}
              </button>
            );
          })}
          {!here.length && <span className="cv__nobody">nobody here</span>}
        </div>

        {col.tracks.filter((t) => t.branchId).map((t) => {
          const branch = trip.branches.find((b) => b.id === t.branchId);
          if (!branch) return null;
          return (
            <div key={t.id} className="cv__branchtab" style={{ left: t.x, width: t.width, ['--c' as string]: t.color }}>
              <span className="truncate">{branch.name}</span>
              <span className="cv__branchn">{branchMembers(trip, branch).length}</span>
              <button
                className="cv__branchx" aria-label={`Dissolve ${branch.name} back into the main timeline`}
                title="Dissolve back into the main timeline"
                onClick={() => onDeleteBranch(branch.id, true)}
              >
                <IconClose size={11} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NodeCard({
  node, trip, zone, selected, dim, dropTarget, dragging, issues,
  onSelect, onGrab, onWire, onHoverPerson,
}: {
  node: CanvasNode; trip: Trip; zone: string;
  selected: boolean; dim: boolean; dropTarget: boolean; dragging: boolean;
  issues: Issue[];
  onSelect: (additive: boolean) => void;
  onGrab: (e: React.PointerEvent) => void;
  onWire: (e: React.PointerEvent) => void;
  onHoverPerson: (id: ID | null) => void;
}) {
  const seg = node.seg;
  const place = trip.places.find((p) => p.id === (seg.placeId ?? seg.toPlaceId ?? seg.fromPlaceId));
  const branch = trip.branches.find((b) => b.id === node.branchId);
  const worst = issues.some((i) => i.severity === 'error') ? 'error'
    : issues.some((i) => i.severity === 'warning') ? 'warning' : null;
  const people = node.attendees.map((id) => trip.people.find((p) => p.id === id)).filter(Boolean);
  const compact = node.h < 62;
  // Fanned cards get thin. Below these widths the place line and then the
  // duration cost more than they earn, so they go rather than wrap.
  const narrow = node.w < 132;
  const tiny = node.w < 96;

  return (
    <article
      className="cvn"
      data-node-key={node.key}
      data-kind={seg.kind}
      data-selected={selected || undefined}
      data-dim={dim || undefined}
      data-drop={dropTarget || undefined}
      data-dragging={dragging || undefined}
      data-status={seg.status}
      data-compact={compact || undefined}
      data-narrow={narrow || undefined}
      style={{
        left: node.x, top: node.y, width: node.w, height: node.h, zIndex: node.z,
        ...(seg.color ? { ['--c' as string]: seg.color } : null),
        ...(branch ? { ['--bc' as string]: branch.color } : null),
      }}
      data-branch={branch ? 'yes' : undefined}
      tabIndex={0}
      aria-label={`${seg.title}, ${fmtTime(seg.start, { zone })} to ${fmtTime(seg.end, { zone })}, ${people.length} people${worst ? `, has a ${worst}` : ''}`}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('.cvn__port')) return;
        onSelect(e.shiftKey || e.metaKey || e.ctrlKey);
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey && e.button === 0) onGrab(e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(e.shiftKey); }
      }}
    >
      <span className="cvn__spine" />

      <header className="cvn__head">
        <span className="cvn__time mono">
          {node.continuation ? '↳ ' : ''}{fmtTime(seg.start, { zone })}
          {!compact && !narrow && <span className="cvn__dur">{fmtDuration(seg.end - seg.start)}</span>}
        </span>
        {worst && (
          <span className={`cvn__warn cvn__warn--${worst}`} title={issues[0]?.title}>
            <IconWarn size={11} />
          </span>
        )}
      </header>

      <h4 className="cvn__title">{seg.title}</h4>

      {!compact && !tiny && (
        <p className="cvn__where">
          {seg.flight
            ? `${seg.flight.carrier}${seg.flight.number} · ${seg.flight.fromCode}→${seg.flight.toCode}`
            : place?.name ?? KIND_LABEL[seg.kind] ?? seg.kind}
        </p>
      )}

      <footer className="cvn__foot">
        <span className="avatar-stack">
          {people.slice(0, 5).map((p) => p && (
            <span
              key={p.id} className="avatar avatar--sm" style={{ ['--c' as string]: p.color }}
              title={p.name}
              onPointerEnter={() => onHoverPerson(p.id)}
              onPointerLeave={() => onHoverPerson(null)}
            >
              {initials(p.name)}
            </span>
          ))}
          {people.length > 5 && <span className="avatar avatar--sm cvn__more">+{people.length - 5}</span>}
          {people.length === 0 && <span className="cvn__nobody">nobody yet</span>}
        </span>
        {seg.status === 'tentative' && <span className="cvn__tent">?</span>}
      </footer>

      {/* the outbound port — drag from here to send these people onward */}
      <button
        className="cvn__port"
        aria-label={`Connect ${seg.title} to what these people do next`}
        title="Drag to the next thing these people do"
        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); onWire(e); }}
      >
        <span />
      </button>
    </article>
  );
}

function EdgeLine({ edge, trip, dim, lit }: { edge: CanvasEdge; trip: Trip; dim: boolean; lit: boolean }) {
  const width = Math.min(7, 1.4 + edge.personIds.length * 0.75);
  const stroke = edge.personIds.length === 1
    ? trip.people.find((p) => p.id === edge.personIds[0])?.color ?? 'var(--line-3)'
    : 'var(--ink-3)';
  return (
    <path
      className="cvw"
      d={edge.path}
      stroke={edge.feasible ? stroke : 'var(--danger)'}
      strokeWidth={lit ? width + 1.4 : width}
      strokeDasharray={edge.feasible ? undefined : '7 5'}
      markerEnd="url(#cv-arrow)"
      data-dim={dim || undefined}
      data-lit={lit || undefined}
      data-role={edge.role}
      fill="none"
    />
  );
}

function EdgeChip({ edge, trip, dim }: { edge: CanvasEdge; trip: Trip; dim: boolean }) {
  const short = edge.needMin !== undefined ? Math.round(edge.needMin - edge.haveMin) : 0;
  return (
    <div
      className="cvchip" data-bad={!edge.feasible || undefined} data-dim={dim || undefined}
      style={{ left: edge.mid.x, top: edge.mid.y }}
    >
      {!edge.feasible ? (
        <>
          <IconWarn size={11} />
          <span>
            {edge.distanceKm !== undefined && `${Math.round(edge.distanceKm)} km · `}
            needs {fmtDuration(edge.needMin! * MIN)}, has {fmtDuration(Math.max(0, edge.haveMin) * MIN)}
            {short > 0 && ` — short ${fmtDuration(short * MIN)}`}
          </span>
        </>
      ) : (
        <span className="avatar-stack">
          {edge.personIds.slice(0, 4).map((id) => {
            const p = trip.people.find((x) => x.id === id);
            return p ? (
              <span key={id} className="avatar avatar--sm" style={{ ['--c' as string]: p.color }} title={p.name}>
                {initials(p.name)}
              </span>
            ) : null;
          })}
          {edge.personIds.length > 4 && <span className="avatar avatar--sm cvn__more">+{edge.personIds.length - 4}</span>}
        </span>
      )}
    </div>
  );
}

function WireGhost({ drag, model }: { drag: Extract<Drag, { kind: 'wire' }>; model: CanvasModel }) {
  const from = model.nodeByKey.get(drag.fromKey);
  if (!from) return null;
  const a = { x: from.x + from.w / 2, y: from.y + from.h };
  const dx = Math.max(24, Math.abs(drag.x - a.x) * 0.4);
  return (
    <path
      className="cvw cvw--ghost"
      d={`M ${a.x} ${a.y} C ${a.x} ${a.y + dx}, ${drag.x} ${drag.y - dx}, ${drag.x} ${drag.y}`}
      fill="none" stroke="var(--brand)" strokeWidth={2.5} strokeDasharray="6 4"
      markerEnd="url(#cv-arrow)"
    />
  );
}

function DropGhost({
  model, drag, options, zone, trip,
}: {
  model: CanvasModel; drag: Extract<Drag, { kind: 'node' }>;
  options: CanvasOptions; zone: string; trip: Trip;
}) {
  if (!drag.over) return null;
  const node = model.nodeByKey.get(drag.nodeKey);
  const hit = hitColumn(model, drag.x - drag.grabDx);
  if (!node || !hit) return null;
  const duration = node.seg.end - node.seg.start;
  const top = yFor((drag.over.start - hit.column.dayStart) / MIN, options);
  const branch = trip.branches.find((b) => b.id === drag.over!.branchId);
  return (
    <div
      className="cv__ghost"
      style={{
        left: hit.column.x + hit.track.x, width: hit.track.width,
        top, height: Math.max(26, (duration / MIN) * options.pxPerMin),
      }}
    >
      <span className="mono">{fmtTime(drag.over.start, { zone })}</span>
      <span className="cv__ghostday">{fmtDate(drag.over.start, zone, 'weekday')}</span>
      {branch && <span className="cv__ghostbranch" style={{ ['--c' as string]: branch.color }}>{branch.name}</span>}
    </div>
  );
}

function HourGutter({
  options, lines, topOffset, scrollRef,
}: {
  options: CanvasOptions;
  lines: ReturnType<typeof hourLines>;
  topOffset: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const on = () => setScrollTop(el.scrollTop);
    el.addEventListener('scroll', on, { passive: true });
    return () => el.removeEventListener('scroll', on);
  }, [scrollRef]);

  return (
    <div className="cv__gutter" style={{ width: options.gutter, top: topOffset }} aria-hidden="true">
      <div style={{ transform: `translateY(${-scrollTop}px)`, position: 'relative' }}>
        {lines.map((l) => (
          <span className="cv__hour" key={l.hour} data-major={l.major || undefined} style={{ top: l.y }}>
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function BranchDialog({
  trip, draft, onClose, onCreate,
}: {
  trip: Trip;
  draft: { name: string; segmentIds: ID[] };
  onClose: () => void;
  onCreate: (name: string, memberIds: ID[]) => void;
}) {
  // Whoever is already on the selected cards is the obvious default — the
  // planner has usually assigned them before deciding to split the group.
  const suggested = useMemo(() => {
    const set = new Set<ID>();
    for (const id of draft.segmentIds) {
      const seg = trip.segments.find((s) => s.id === id);
      if (seg) for (const a of attendeesOf(seg, trip)) set.add(a);
    }
    return [...set];
  }, [draft.segmentIds, trip]);

  const [name, setName] = useState(draft.name);
  const [members, setMembers] = useState<ID[]>(suggested);
  const staying = trip.people.filter((p) => !members.includes(p.id));

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="branch-h">
      <div className="sheet__scrim" onClick={onClose} />
      <form className="sheet__panel" onSubmit={(e) => { e.preventDefault(); onCreate(name, members); }}>
        <h2 id="branch-h" className="sheet__title">Split off a sub-trip</h2>
        <p className="sheet__lead">
          {draft.segmentIds.length} {draft.segmentIds.length === 1 ? 'card moves' : 'cards move'} onto their own
          track. Everyone else carries on down the main line, and both stay on the same canvas.
        </p>

        <label className="field">
          <span className="field__label">Call it</span>
          <input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Beach group" />
        </label>

        <fieldset className="field">
          <legend className="field__label">Who goes</legend>
          <div className="cv__picker">
            {trip.people.map((p) => {
              const on = members.includes(p.id);
              return (
                <label key={p.id} className="cv__pick" data-on={on || undefined} style={{ ['--c' as string]: p.color }}>
                  <input
                    type="checkbox" checked={on}
                    onChange={() => setMembers((m) => (on ? m.filter((x) => x !== p.id) : [...m, p.id]))}
                  />
                  <span className="avatar avatar--sm" style={{ ['--c' as string]: p.color }}>{initials(p.name)}</span>
                  {p.name}
                </label>
              );
            })}
          </div>
          <span className="field__help">
            {members.length === 0
              ? 'Pick at least one person.'
              : staying.length === 0
                ? 'Everyone is going — that is just the main timeline. Leave someone behind, or cancel.'
                : `${members.length} peel off, ${staying.length} stay: ${staying.map((p) => p.name.split(' ')[0]).join(', ')}.`}
          </span>
        </fieldset>

        <div className="row row--between" style={{ marginTop: 'var(--s-4)' }}>
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!members.length || !name.trim()}>
            Create sub-trip
          </button>
        </div>
      </form>
    </div>
  );
}

function CanvasEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty">
      <p className="empty__title">An empty board</p>
      <p className="empty__body">
        Days run across, hours run down. Add the people first — the roster along the top is what
        you drag onto cards to say who is doing what — then drop the first block on a day.
      </p>
      <div className="row" style={{ gap: 'var(--s-2)', justifyContent: 'center' }}>
        <button className="btn btn--primary" onClick={onCreate}>
          <IconSparkle size={15} /> Put something on day one
        </button>
      </div>
    </div>
  );
}

/* ---------- odds and ends ---------- */

function kindForPlace(place: Place): Segment['kind'] {
  switch (place.kind) {
    case 'restaurant': return 'meal';
    case 'bar': return 'activity';
    case 'hotel': return 'checkin';
    case 'airport': return 'flight';
    case 'venue': case 'office': return 'session';
    default: return 'activity';
  }
}

/** Nudge the scroller when a drag reaches its edge. */
function autoScroll(el: HTMLElement | null, clientX: number, clientY: number) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const EDGE = 56;
  const speed = 14;
  if (clientX > r.right - EDGE) el.scrollLeft += speed;
  else if (clientX < r.left + EDGE) el.scrollLeft -= speed;
  if (clientY > r.bottom - EDGE) el.scrollTop += speed;
  else if (clientY < r.top + EDGE) el.scrollTop -= speed;
}

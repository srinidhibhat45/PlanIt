/** The board.
 *
 *  An unbounded whiteboard, not a calendar. Cards sit wherever you put them,
 *  connectors say what follows what, frames say what belongs together — and
 *  none of it touches the clock until you ask it to. **Resolve** is the bridge:
 *  it reads the arrangement and hands back a schedule, which the timeline, day
 *  and map views then render as usual.
 *
 *  What a position means:
 *    · inside a day frame  → that card happens on that day, and top-to-bottom
 *      inside the frame is the order of the day
 *    · inside a sub-trip frame → that card belongs to that sub-trip
 *    · anywhere else       → nothing at all, which is the point of a board
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type {
  ClockMode, Frame, ID, Issue, Link, Place, Point, Rect, Segment, Sticky, Trip,
} from '../core/types';
import {
  CARD_H, CARD_W, STICKY_H, STICKY_W, cardRect, cardsIn, connector, contentBounds,
  fitTo, frameAt, isScheduled, normalise, nextFreeSpot, peopleFlows,
  stickyRect, toWorld, zoomAt, type Viewport,
} from '../core/board';
import { contains } from '../core/resolve';
import { MIN, fmtDate, fmtDuration, fmtTime } from '../core/time';
import { attendeesOf } from '../core/schedule';
import { axisZone } from '../core/clock';
import { branchMembers } from '../core/branch';
import { KIND_LABEL } from '../core/layout';
import { PlaceSearch } from './PlaceSearch';
import { initials } from './SegmentChrome';
import {
  IconBoard, IconClose, IconGrab, IconLink, IconLock, IconPlus, IconSearch,
  IconSparkle, IconTarget, IconTrash, IconWarn, IconZoomIn, IconZoomOut,
} from './Icons';

export type Tool = 'select' | 'hand' | 'card' | 'note' | 'frame' | 'connect';

export interface BoardHandlers {
  onSelect: (id: ID | null) => void;
  onMoveCards: (ids: ID[], dx: number, dy: number) => void;
  onCreateCard: (at: Point, draft?: Partial<Segment>, place?: Place) => void;
  onDeleteCards: (ids: ID[]) => void;
  onPin: (ids: ID[], pinned: boolean) => void;
  onAssign: (segmentId: ID, personId: ID, on: boolean) => void;
  onLink: (fromId: ID, toId: ID, kind: Link['kind']) => void;
  onPatchLink: (id: ID, patch: Partial<Link>) => void;
  onUnlink: (ids: ID[]) => void;
  onAddSticky: (sticky: Sticky) => void;
  onPatchSticky: (id: ID, patch: Partial<Sticky>) => void;
  onDeleteSticky: (id: ID) => void;
  onAddFrame: (frame: Frame) => void;
  onPatchFrame: (id: ID, patch: Partial<Frame>) => void;
  onDeleteFrame: (id: ID) => void;
  onCreateBranch: (name: string, memberIds: ID[], segmentIds: ID[], rect: Rect) => void;
  onDeleteBranch: (id: ID, keep: boolean) => void;
  onTidy: () => void;
  onResolve: () => void;
  onAnnounce: (text: string) => void;
}

type Drag =
  | { kind: 'pan'; fromScreen: Point; fromView: Point }
  | { kind: 'marquee'; from: Point; to: Point; additive: boolean }
  | { kind: 'cards'; ids: ID[]; from: Point; to: Point }
  | { kind: 'sticky'; id: ID; from: Point; to: Point }
  | { kind: 'frame'; id: ID; ids: ID[]; stickyIds: ID[]; from: Point; to: Point }
  | { kind: 'resize'; id: ID; rect: Rect; to: Point }
  | { kind: 'connect'; fromId: ID; to: Point; overId: ID | null }
  | { kind: 'person'; personId: ID; to: Point; overId: ID | null }
  | { kind: 'place'; place: Place; to: Point };

const STICKY_COLOURS = ['#ffb020', '#14d4c4', '#8b7cff', '#ff6b9d', '#a3e635'];

export function CanvasView({
  trip, segments, clock, issues, selectedId, now, handlers,
}: {
  trip: Trip;
  segments: Segment[];
  clock: ClockMode;
  issues: Issue[];
  selectedId: ID | null;
  now: number;
  handlers: BoardHandlers;
}) {
  const zone = axisZone(clock, trip);
  const hostRef = useRef<HTMLDivElement>(null);

  const [view, setView] = useState<Viewport>(() => ({ x: -60, y: -60, zoom: 0.75 }));
  const [tool, setTool] = useState<Tool>('select');
  const [sel, setSel] = useState<ID[]>([]);
  const [selLink, setSelLink] = useState<ID | null>(null);
  const [selSticky, setSelSticky] = useState<ID | null>(null);
  const [selFrame, setSelFrame] = useState<ID | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [hoverPerson, setHoverPerson] = useState<ID | null>(null);
  const [showFlows, setShowFlows] = useState(true);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [branchDraft, setBranchDraft] = useState<{ name: string; ids: ID[] } | null>(null);
  const [editingSticky, setEditingSticky] = useState<ID | null>(null);

  /* ---------- derived ---------- */

  const visible = useMemo(() => new Set(segments.map((s) => s.id)), [segments]);
  const cards = useMemo(
    () => trip.segments.filter((s) => visible.has(s.id) && s.at),
    [trip.segments, visible],
  );
  const rects = useMemo(
    () => new Map<ID, Rect>(cards.map((s) => [s.id, cardRect(s)])),
    [cards],
  );

  const links = useMemo(
    () => (trip.links ?? [])
      .map((l) => {
        const a = rects.get(l.fromId);
        const b = rects.get(l.toId);
        return a && b ? { link: l, geom: connector(a, b) } : null;
      })
      .filter((x): x is { link: Link; geom: ReturnType<typeof connector> } => !!x),
    [trip.links, rects],
  );

  const flows = useMemo(
    () => (showFlows ? peopleFlows(trip, rects) : []),
    [trip, rects, showFlows],
  );

  const issueBySegment = useMemo(() => {
    const map = new Map<ID, Issue[]>();
    for (const i of issues) for (const sid of i.segmentIds) map.set(sid, [...(map.get(sid) ?? []), i]);
    return map;
  }, [issues]);

  const selection = useMemo(
    () => new Set(sel.length ? sel : selectedId ? [selectedId] : []),
    [sel, selectedId],
  );

  const linked = useMemo(() => {
    const set = new Set<ID>();
    for (const l of trip.links ?? []) { set.add(l.fromId); set.add(l.toId); }
    return set;
  }, [trip.links]);

  /* ---------- coordinates ---------- */

  const screenToWorld = useCallback((clientX: number, clientY: number): Point => {
    const el = hostRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return toWorld(view, clientX - r.left, clientY - r.top);
  }, [view]);

  /** Refs so the pointer handlers installed at pointerdown never read a stale
   *  closure — the same reason the handlers are wired up synchronously below. */
  const live = useRef({ view, screenToWorld, trip, handlers, sel, tool });
  live.current = { view, screenToWorld, trip, handlers, sel, tool };

  const dragRef = useRef<Drag | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  const setDragState = useCallback((d: Drag | null) => { dragRef.current = d; setDrag(d); }, []);

  const beginDrag = useCallback((start: Drag, onEnd: (d: Drag) => void) => {
    stopRef.current?.();
    setDragState(start);

    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === 'pan') {
        const dx = (e.clientX - d.fromScreen.x) / live.current.view.zoom;
        const dy = (e.clientY - d.fromScreen.y) / live.current.view.zoom;
        setView((v) => ({ ...v, x: d.fromView.x - dx, y: d.fromView.y - dy }));
        return;
      }
      const p = live.current.screenToWorld(e.clientX, e.clientY);
      if (d.kind === 'connect' || d.kind === 'person') {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const over = el?.closest<HTMLElement>('[data-card-id]')?.dataset.cardId ?? null;
        setDragState({ ...d, to: p, overId: over });
      } else if (d.kind === 'resize') {
        setDragState({ ...d, to: p });
      } else {
        setDragState({ ...d, to: p });
      }
    };

    const finish = () => {
      const d = dragRef.current;
      if (d) onEnd(d);
      setDragState(null);
      stop();
    };
    const cancelKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setDragState(null); stop(); }
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', cancelKey);
      stopRef.current = null;
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', cancelKey);
    stopRef.current = stop;
  }, [setDragState]);

  useEffect(() => () => stopRef.current?.(), []);

  /* ---------- wheel: pan, or zoom with a modifier ---------- */

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        setView((v) => zoomAt(v, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0022)));
      } else {
        setView((v) => ({ ...v, x: v.x + e.deltaX / v.zoom, y: v.y + e.deltaY / v.zoom }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* ---------- keyboard ---------- */

  const fit = useCallback(() => {
    const el = hostRef.current;
    if (!el) return;
    setView(fitTo(contentBounds(trip), el.clientWidth, el.clientHeight));
  }, [trip]);

  useEffect(() => {
    const typing = () => {
      const a = document.activeElement;
      return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || (a as HTMLElement).isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !typing()) { setSpaceDown(true); e.preventDefault(); return; }
      if (typing() || e.metaKey || e.ctrlKey) return;
      const map: Record<string, Tool> = { v: 'select', h: 'hand', c: 'card', n: 'note', f: 'frame', l: 'connect' };
      const next = map[e.key.toLowerCase()];
      if (next) { setTool(next); return; }
      if (e.key === 'Escape') { setSel([]); setSelLink(null); setSelSticky(null); setSelFrame(null); setTool('select'); }
      if ((e.key === 'Delete' || e.key === 'Backspace')) {
        if (selLink) { handlers.onUnlink([selLink]); setSelLink(null); e.preventDefault(); }
        else if (selSticky) { handlers.onDeleteSticky(selSticky); setSelSticky(null); e.preventDefault(); }
        else if (selFrame) { handlers.onDeleteFrame(selFrame); setSelFrame(null); e.preventDefault(); }
      }
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceDown(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [handlers, selLink, selSticky, selFrame]);

  // Fit once, as soon as there is something to fit to.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !cards.length) return;
    fitted.current = true;
    fit();
  }, [cards.length, fit]);

  /* ---------- selection ---------- */

  const clearOthers = () => { setSelLink(null); setSelSticky(null); setSelFrame(null); };

  const selectCard = (id: ID, additive: boolean) => {
    clearOthers();
    if (!additive) { setSel([id]); handlers.onSelect(id); return; }
    setSel((prev) => {
      const base = prev.length ? prev : selectedId ? [selectedId] : [];
      const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
      handlers.onSelect(next[next.length - 1] ?? null);
      return next;
    });
  };

  /* ---------- surface gestures ---------- */

  const panning = tool === 'hand' || spaceDown;

  const onSurfacePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-board-item]')) return;
    const p = screenToWorld(e.clientX, e.clientY);

    if (panning || e.button === 1) {
      beginDrag(
        { kind: 'pan', fromScreen: { x: e.clientX, y: e.clientY }, fromView: { x: view.x, y: view.y } },
        () => {},
      );
      return;
    }

    if (tool === 'card') {
      handlers.onCreateCard(p);
      setTool('select');
      return;
    }
    if (tool === 'note') {
      handlers.onAddSticky({
        id: `sty_${Math.random().toString(36).slice(2, 10)}`,
        text: '', at: p, color: STICKY_COLOURS[trip.stickies.length % STICKY_COLOURS.length],
      });
      setTool('select');
      return;
    }
    if (tool === 'frame') {
      beginDrag({ kind: 'marquee', from: p, to: p, additive: false }, (d) => {
        if (d.kind !== 'marquee') return;
        const rect = normalise(d.from, d.to);
        if (rect.w < 60 || rect.h < 60) { setTool('select'); return; }
        handlers.onAddFrame({
          id: `frm_${Math.random().toString(36).slice(2, 10)}`,
          title: 'Frame', rect, color: 'var(--line-3)',
        });
        setTool('select');
      });
      return;
    }

    // Select tool on empty space: marquee.
    if (!e.shiftKey) { setSel([]); handlers.onSelect(null); clearOthers(); }
    beginDrag({ kind: 'marquee', from: p, to: p, additive: e.shiftKey }, (d) => {
      if (d.kind !== 'marquee') return;
      const rect = normalise(d.from, d.to);
      if (rect.w < 4 && rect.h < 4) return;
      const caught = cardsIn(live.current.trip, rect).filter((id) => visible.has(id));
      setSel((prev) => (d.additive ? [...new Set([...prev, ...caught])] : caught));
      handlers.onSelect(caught[caught.length - 1] ?? null);
    });
  };

  /* ---------- card gestures ---------- */

  const startCardDrag = (id: ID, e: React.PointerEvent) => {
    const p = screenToWorld(e.clientX, e.clientY);
    const ids = selection.has(id) ? [...selection] : [id];
    beginDrag({ kind: 'cards', ids, from: p, to: p }, (d) => {
      if (d.kind !== 'cards') return;
      const dx = d.to.x - d.from.x;
      const dy = d.to.y - d.from.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      handlers.onMoveCards(d.ids, dx, dy);
      const landed = frameAt(live.current.trip, { x: (rects.get(d.ids[0])?.x ?? 0) + dx + CARD_W / 2, y: (rects.get(d.ids[0])?.y ?? 0) + dy + CARD_H / 2 });
      handlers.onAnnounce(
        landed
          ? `Moved ${d.ids.length} ${d.ids.length === 1 ? 'card' : 'cards'} into ${landed.title}.`
          : `Moved ${d.ids.length} ${d.ids.length === 1 ? 'card' : 'cards'}.`,
      );
    });
  };

  const startConnect = (fromId: ID, e: React.PointerEvent) => {
    const p = screenToWorld(e.clientX, e.clientY);
    beginDrag({ kind: 'connect', fromId, to: p, overId: null }, (d) => {
      if (d.kind !== 'connect' || !d.overId || d.overId === d.fromId) return;
      handlers.onLink(d.fromId, d.overId, e.altKey ? 'then' : 'travel');
      const a = live.current.trip.segments.find((s) => s.id === d.fromId);
      const b = live.current.trip.segments.find((s) => s.id === d.overId);
      handlers.onAnnounce(`“${b?.title}” now comes after “${a?.title}”.`);
    });
  };

  /* ---------- ghost geometry while dragging ---------- */

  const ghostDelta = drag?.kind === 'cards'
    ? { dx: drag.to.x - drag.from.x, dy: drag.to.y - drag.from.y, ids: new Set(drag.ids) }
    : null;
  const frameDelta = drag?.kind === 'frame'
    ? { dx: drag.to.x - drag.from.x, dy: drag.to.y - drag.from.y }
    : null;

  const rectFor = (seg: Segment): Rect => {
    const base = cardRect(seg);
    if (ghostDelta?.ids.has(seg.id)) return { ...base, x: base.x + ghostDelta.dx, y: base.y + ghostDelta.dy };
    if (frameDelta && drag?.kind === 'frame' && drag.ids.includes(seg.id)) {
      return { ...base, x: base.x + frameDelta.dx, y: base.y + frameDelta.dy };
    }
    return base;
  };

  const dimPerson = hoverPerson ?? (drag?.kind === 'person' ? drag.personId : null);

  const blank = !cards.length && !trip.stickies.length && !trip.frames.length;

  return (
    <div className="bd" data-tool={panning ? 'hand' : tool} data-dragging={drag?.kind ?? undefined}>
      <Toolbar
        tool={tool} onTool={setTool}
        zoom={view.zoom}
        onZoom={(f) => {
          const el = hostRef.current;
          if (el) setView((v) => zoomAt(v, el.clientWidth / 2, el.clientHeight / 2, f));
        }}
        onFit={fit}
        onReset={() => setView((v) => ({ ...v, zoom: 1 }))}
        selection={selection.size}
        showFlows={showFlows} onFlows={() => setShowFlows((f) => !f)}
        shelfOpen={shelfOpen} onShelf={() => setShelfOpen((o) => !o)}
        onTidy={handlers.onTidy}
        onResolve={handlers.onResolve}
        onSubTrip={() => {
          const ids = [...selection];
          if (!ids.length) return;
          const chosen = trip.segments.filter((s) => ids.includes(s.id)).sort((a, b) => a.start - b.start);
          const place = trip.places.find((p) => p.id === (chosen[0]?.placeId ?? chosen[0]?.toPlaceId));
          const label = (place?.name ?? chosen[0]?.title ?? '').split(/[·(]/)[0].trim();
          setBranchDraft({ name: label ? `${label.slice(0, 26)} group` : 'Side trip', ids });
        }}
        onPin={() => {
          const ids = [...selection];
          const allPinned = ids.every((id) => trip.segments.find((s) => s.id === id)?.pinned);
          handlers.onPin(ids, !allPinned);
        }}
        pinned={[...selection].every((id) => trip.segments.find((s) => s.id === id)?.pinned)}
        onDelete={() => { handlers.onDeleteCards([...selection]); setSel([]); handlers.onSelect(null); }}
        branches={trip.branches}
        onFocusBranch={(id) => {
          const frame = trip.frames.find((f) => f.branchId === id);
          const el = hostRef.current;
          if (frame && el) setView(fitTo(frame.rect, el.clientWidth, el.clientHeight));
        }}
      />

      <div className="bd__frame">
        <div
          className="bd__host"
          ref={hostRef}
          onPointerDown={onSurfacePointerDown}
          role="application"
          aria-label="Planning board"
          style={{
            // The dot grid is part of the board, so it pans and zooms with it.
            backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`,
            backgroundPosition: `${-view.x * view.zoom}px ${-view.y * view.zoom}px`,
          }}
        >
          <div
            className="bd__world"
            style={{
              transform: `translate(${-view.x * view.zoom}px, ${-view.y * view.zoom}px) scale(${view.zoom})`,
            }}
          >
            {/* frames sit behind everything */}
            {(trip.frames ?? []).map((f) => (
              <FrameBox
                key={f.id} frame={f} trip={trip}
                selected={selFrame === f.id}
                delta={drag?.kind === 'frame' && drag.id === f.id ? frameDelta : null}
                resizing={drag?.kind === 'resize' && drag.id === f.id ? drag.to : null}
                onSelect={() => { setSelFrame(f.id); setSel([]); setSelLink(null); setSelSticky(null); handlers.onSelect(null); }}
                onGrab={(e) => {
                  const p = screenToWorld(e.clientX, e.clientY);
                  const inside = trip.segments.filter((s) => s.at && contains(f.rect, s.at)).map((s) => s.id);
                  const stickies = trip.stickies.filter((n) => contains(f.rect, n.at)).map((n) => n.id);
                  beginDrag({ kind: 'frame', id: f.id, ids: inside, stickyIds: stickies, from: p, to: p }, (d) => {
                    if (d.kind !== 'frame') return;
                    const dx = d.to.x - d.from.x;
                    const dy = d.to.y - d.from.y;
                    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
                    // A frame carries what is inside it, the way a section does.
                    handlers.onPatchFrame(f.id, { rect: { ...f.rect, x: f.rect.x + dx, y: f.rect.y + dy } });
                    if (d.ids.length) handlers.onMoveCards(d.ids, dx, dy);
                    for (const id of d.stickyIds) {
                      const n = trip.stickies.find((x) => x.id === id);
                      if (n) handlers.onPatchSticky(id, { at: { x: n.at.x + dx, y: n.at.y + dy } });
                    }
                  });
                }}
                onResize={(e) => {
                  const p = screenToWorld(e.clientX, e.clientY);
                  beginDrag({ kind: 'resize', id: f.id, rect: f.rect, to: p }, (d) => {
                    if (d.kind !== 'resize') return;
                    handlers.onPatchFrame(f.id, {
                      rect: {
                        ...f.rect,
                        w: Math.max(160, d.to.x - f.rect.x),
                        h: Math.max(120, d.to.y - f.rect.y),
                      },
                    });
                  });
                }}
                onRename={(title) => handlers.onPatchFrame(f.id, { title })}
                onDelete={() => { handlers.onDeleteFrame(f.id); setSelFrame(null); }}
                onDissolveBranch={() => f.branchId && handlers.onDeleteBranch(f.branchId, true)}
              />
            ))}

            {/* connectors and flows */}
            <svg className="bd__wires" aria-hidden="true">
              <defs>
                <marker id="bd-arrow" viewBox="0 0 9 9" refX="7.5" refY="4.5" markerWidth="6.5" markerHeight="6.5" orient="auto">
                  <path d="M1 1 L8 4.5 L1 8 z" fill="context-stroke" />
                </marker>
              </defs>

              {showFlows && flows.map((flow) => (
                <path
                  key={`flow-${flow.key}`}
                  className="bd__flow"
                  d={flow.path}
                  strokeWidth={Math.min(6, 1.2 + flow.personIds.length * 0.7)}
                  stroke={flow.personIds.length === 1
                    ? trip.people.find((p) => p.id === flow.personIds[0])?.color ?? 'var(--ink-3)'
                    : 'var(--ink-3)'}
                  data-dim={dimPerson !== null && !flow.personIds.includes(dimPerson) ? 'yes' : undefined}
                  fill="none"
                />
              ))}

              {links.map(({ link, geom }) => (
                <g key={link.id}>
                  <path
                    className="bd__wirehit" d={geom.path} fill="none"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelLink(link.id); setSel([]); setSelFrame(null); setSelSticky(null);
                    }}
                  />
                  <path
                    className="bd__wire" d={geom.path} fill="none"
                    data-kind={link.kind}
                    data-on={selLink === link.id || undefined}
                    markerEnd="url(#bd-arrow)"
                  />
                </g>
              ))}

              {drag?.kind === 'connect' && (
                <ConnectGhost rect={rects.get(drag.fromId)} to={drag.to} />
              )}
            </svg>

            {/* connector labels, above the wires */}
            {links.map(({ link, geom }) => (
              <LinkChip
                key={`c-${link.id}`}
                link={link} at={geom.mid}
                trip={trip} zone={zone}
                selected={selLink === link.id}
                onSelect={() => { setSelLink(link.id); setSel([]); }}
                onToggleKind={() => handlers.onPatchLink(link.id, { kind: link.kind === 'travel' ? 'then' : 'travel' })}
                onDelete={() => { handlers.onUnlink([link.id]); setSelLink(null); }}
              />
            ))}

            {showFlows && flows.filter((f) => f.personIds.length > 1).map((flow) => (
              <div
                key={`fl-${flow.key}`} className="bd__flowchip"
                style={{ left: flow.mid.x, top: flow.mid.y }}
                data-dim={dimPerson !== null && !flow.personIds.includes(dimPerson) ? 'yes' : undefined}
              >
                <span className="avatar-stack">
                  {flow.personIds.slice(0, 4).map((id) => {
                    const p = trip.people.find((x) => x.id === id);
                    return p ? (
                      <span key={id} className="avatar avatar--sm" style={{ ['--c' as string]: p.color }} title={p.name}>
                        {initials(p.name)}
                      </span>
                    ) : null;
                  })}
                </span>
              </div>
            ))}

            {/* stickies */}
            {(trip.stickies ?? []).map((n) => (
              <StickyNote
                key={n.id} note={n}
                selected={selSticky === n.id}
                editing={editingSticky === n.id}
                delta={drag?.kind === 'sticky' && drag.id === n.id
                  ? { dx: drag.to.x - drag.from.x, dy: drag.to.y - drag.from.y }
                  : (frameDelta && drag?.kind === 'frame' && drag.stickyIds.includes(n.id) ? frameDelta : null)}
                onSelect={() => { setSelSticky(n.id); setSel([]); setSelLink(null); setSelFrame(null); handlers.onSelect(null); }}
                onEdit={() => setEditingSticky(n.id)}
                onCommit={(text) => { handlers.onPatchSticky(n.id, { text }); setEditingSticky(null); }}
                onGrab={(e) => {
                  const p = screenToWorld(e.clientX, e.clientY);
                  beginDrag({ kind: 'sticky', id: n.id, from: p, to: p }, (d) => {
                    if (d.kind !== 'sticky') return;
                    const dx = d.to.x - d.from.x;
                    const dy = d.to.y - d.from.y;
                    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
                    handlers.onPatchSticky(n.id, { at: { x: n.at.x + dx, y: n.at.y + dy } });
                  });
                }}
                onDelete={() => { handlers.onDeleteSticky(n.id); setSelSticky(null); }}
              />
            ))}

            {/* cards */}
            {cards.map((seg) => (
              <BoardCard
                key={seg.id}
                seg={seg} rect={rectFor(seg)} trip={trip} zone={zone}
                selected={selection.has(seg.id)}
                dim={dimPerson !== null && !attendeesOf(seg, trip).includes(dimPerson)}
                dropTarget={(drag?.kind === 'connect' || drag?.kind === 'person') && drag.overId === seg.id}
                wired={linked.has(seg.id) || isScheduled(trip, seg)}
                issues={issueBySegment.get(seg.id) ?? []}
                connectMode={tool === 'connect'}
                onSelect={(additive) => selectCard(seg.id, additive)}
                onGrab={(e) => startCardDrag(seg.id, e)}
                onConnect={(e) => startConnect(seg.id, e)}
                onHoverPerson={setHoverPerson}
                onTogglePin={() => handlers.onPin([seg.id], !seg.pinned)}
              />
            ))}

            {/* marquee */}
            {drag?.kind === 'marquee' && (
              <div className="bd__marquee" style={rectStyle(normalise(drag.from, drag.to))} />
            )}

            {drag?.kind === 'place' && (
              <div className="bd__placeghost" style={{ left: drag.to.x, top: drag.to.y }}>
                {drag.place.name}
              </div>
            )}
          </div>

          {blank && (
            <BoardEmpty
              hasSegments={trip.segments.length > 0}
              onTidy={handlers.onTidy}
              onAdd={() => handlers.onCreateCard({ x: 120, y: 120 })}
            />
          )}

          <Roster
            trip={trip} now={now} zone={zone}
            dimPerson={dimPerson}
            onHover={setHoverPerson}
            onGrab={(personId, e) => {
              const p = screenToWorld(e.clientX, e.clientY);
              beginDrag({ kind: 'person', personId, to: p, overId: null }, (d) => {
                if (d.kind !== 'person' || !d.overId) return;
                const target = live.current.trip.segments.find((s) => s.id === d.overId);
                if (!target) return;
                const already = attendeesOf(target, live.current.trip).includes(d.personId);
                handlers.onAssign(target.id, d.personId, !already);
                const who = live.current.trip.people.find((x) => x.id === d.personId)?.name ?? 'They';
                handlers.onAnnounce(`${who} ${already ? 'removed from' : 'added to'} “${target.title}”.`);
              });
            }}
          />

          {drag?.kind === 'person' && (
            <div className="bd__dragface" style={{ left: 0, top: 0 }} aria-hidden="true" />
          )}
        </div>

        {shelfOpen && (
          <aside className="bd__shelf" aria-label="Places">
            <div className="row row--between">
              <h3 className="bd__shelfhead">Add a place</h3>
              <button className="btn btn--icon btn--sm btn--ghost" onClick={() => setShelfOpen(false)} aria-label="Close places panel">
                <IconClose size={14} />
              </button>
            </div>
            <p className="bd__shelfhelp">
              Search, or paste a Google Maps link. Picking one drops a card on the board — drag it
              wherever it belongs.
            </p>
            <PlaceSearch
              zone={trip.baseTimezone}
              existing={trip.places}
              near={trip.places[0] ? { lat: trip.places[0].lat, lon: trip.places[0].lon } : undefined}
              autoFocus
              onPick={(place) => {
                const el = hostRef.current;
                const at = el
                  ? screenToWorld(el.getBoundingClientRect().left + el.clientWidth / 2,
                                  el.getBoundingClientRect().top + el.clientHeight / 2)
                  : nextFreeSpot(trip);
                handlers.onCreateCard(nextFreeSpot(trip, at), { title: place.name, kind: kindForPlace(place) }, place);
                handlers.onAnnounce(`${place.name} added to the board.`);
              }}
            />
            {trip.places.length > 0 && (
              <>
                <p className="label" style={{ marginTop: 'var(--s-4)' }}>On this trip</p>
                <ul className="bd__cards">
                  {trip.places.map((p) => (
                    <li key={p.id}>
                      <button
                        className="bd__placecard"
                        onClick={() => {
                          handlers.onCreateCard(nextFreeSpot(trip), { title: p.name, kind: kindForPlace(p), placeId: p.id });
                          handlers.onAnnounce(`${p.name} added to the board.`);
                        }}
                      >
                        <IconPlus size={13} />
                        <span className="grow truncate">{p.name}</span>
                        {p.url && (
                          <a
                            className="bd__placelink" href={p.url} target="_blank" rel="noreferrer noopener"
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Open ${p.name} in maps`}
                          >
                            <IconLink size={12} />
                          </a>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        )}
      </div>

      {branchDraft && (
        <BranchDialog
          trip={trip} draft={branchDraft}
          onClose={() => setBranchDraft(null)}
          onCreate={(name, memberIds) => {
            const chosen = trip.segments.filter((s) => branchDraft.ids.includes(s.id) && s.at);
            const pad = 44;
            const xs = chosen.map((s) => s.at!.x);
            const ys = chosen.map((s) => s.at!.y);
            const rect: Rect = chosen.length
              ? {
                x: Math.min(...xs) - pad, y: Math.min(...ys) - pad - 26,
                w: Math.max(...xs) + CARD_W - Math.min(...xs) + pad * 2,
                h: Math.max(...ys) + CARD_H - Math.min(...ys) + pad * 2 + 26,
              }
              : { x: 0, y: 0, w: 460, h: 320 };
            handlers.onCreateBranch(name, memberIds, branchDraft.ids, rect);
            setBranchDraft(null);
            setSel([]);
          }}
        />
      )}
    </div>
  );
}

/* ============================================================ */

function Toolbar({
  tool, onTool, zoom, onZoom, onFit, onReset, selection, showFlows, onFlows, shelfOpen, onShelf,
  onTidy, onResolve, onSubTrip, onPin, pinned, onDelete, branches, onFocusBranch,
}: {
  tool: Tool; onTool: (t: Tool) => void;
  zoom: number; onZoom: (factor: number) => void; onFit: () => void; onReset: () => void;
  selection: number;
  showFlows: boolean; onFlows: () => void;
  shelfOpen: boolean; onShelf: () => void;
  onTidy: () => void; onResolve: () => void; onSubTrip: () => void;
  onPin: () => void; pinned: boolean; onDelete: () => void;
  branches: Trip['branches'];
  onFocusBranch: (id: ID) => void;
}) {
  const tools: { id: Tool; label: string; key: string; Icon: (p: { size?: number }) => ReactElement }[] = [
    { id: 'select', label: 'Select', key: 'V', Icon: IconTarget },
    { id: 'hand', label: 'Pan', key: 'H', Icon: IconGrab },
    { id: 'card', label: 'Card', key: 'C', Icon: IconPlus },
    { id: 'note', label: 'Note', key: 'N', Icon: IconBoard },
    { id: 'frame', label: 'Frame', key: 'F', Icon: IconBoard },
    { id: 'connect', label: 'Connect', key: 'L', Icon: IconLink },
  ];

  return (
    <div className="bd__tools">
      <div className="bd__toolgroup" role="toolbar" aria-label="Board tools">
        {tools.map((t) => (
          <button
            key={t.id} className="bd__tool" aria-pressed={tool === t.id}
            onClick={() => onTool(t.id)}
            title={`${t.label} · ${t.key}`}
            aria-label={`${t.label} tool, shortcut ${t.key}`}
          >
            <t.Icon size={15} />
          </button>
        ))}
      </div>

      <span className="bd__sep" role="separator" />

      <button className="btn btn--sm" aria-pressed={shelfOpen} onClick={onShelf}>
        <IconSearch size={14} /> Places
      </button>
      <button className="btn btn--sm" aria-pressed={showFlows} onClick={onFlows} title="Show who goes from what to what">
        People flows
      </button>

      <span className="bd__sep" role="separator" />

      <button className="btn btn--sm" onClick={onTidy} title="Lay the board out from the schedule: a frame per day, in time order">
        Tidy
      </button>
      <button className="btn btn--sm btn--primary" onClick={onResolve} title="Read the board and give every framed or wired card a time">
        <IconSparkle size={14} /> Resolve to timeline
      </button>

      {selection > 0 && (
        <>
          <span className="bd__sep" role="separator" />
          <span className="bd__count">{selection} selected</span>
          <button className="btn btn--sm" onClick={onSubTrip}><IconBoard size={14} /> Sub-trip</button>
          <button className="btn btn--sm" onClick={onPin} aria-pressed={pinned} title="A pinned card keeps its time when the board resolves">
            <IconLock size={13} /> {pinned ? 'Unpin' : 'Pin time'}
          </button>
          <button className="btn btn--sm btn--ghost" onClick={onDelete} aria-label="Delete selected cards">
            <IconTrash size={13} />
          </button>
        </>
      )}

      <span className="grow" />

      {branches.length > 0 && (
        <span className="bd__legend">
          {branches.map((b) => (
            <button
              key={b.id} className="bd__legendchip" style={{ ['--c' as string]: b.color }}
              onClick={() => onFocusBranch(b.id)}
              title={`Jump to ${b.name}`}
            >
              <span className="bd__legenddot" /> {b.name}
            </button>
          ))}
        </span>
      )}

      <span className="bd__zoom">
        <button className="btn btn--icon btn--sm btn--ghost" onClick={() => onZoom(1 / 1.25)} aria-label="Zoom out"><IconZoomOut size={14} /></button>
        <button className="bd__zoomv mono" onClick={onReset} title="Reset to 100%">{Math.round(zoom * 100)}%</button>
        <button className="btn btn--icon btn--sm btn--ghost" onClick={() => onZoom(1.25)} aria-label="Zoom in"><IconZoomIn size={14} /></button>
        <button className="btn btn--sm btn--ghost" onClick={onFit}>Fit</button>
      </span>
    </div>
  );
}

function BoardCard({
  seg, rect, trip, zone, selected, dim, dropTarget, wired, issues, connectMode,
  onSelect, onGrab, onConnect, onHoverPerson, onTogglePin,
}: {
  seg: Segment; rect: Rect; trip: Trip; zone: string;
  selected: boolean; dim: boolean; dropTarget: boolean; wired: boolean;
  issues: Issue[]; connectMode: boolean;
  onSelect: (additive: boolean) => void;
  onGrab: (e: React.PointerEvent) => void;
  onConnect: (e: React.PointerEvent) => void;
  onHoverPerson: (id: ID | null) => void;
  onTogglePin: () => void;
}) {
  const place = trip.places.find((p) => p.id === (seg.placeId ?? seg.toPlaceId ?? seg.fromPlaceId));
  const branch = trip.branches.find((b) => b.id === seg.branchId);
  const worst = issues.some((i) => i.severity === 'error') ? 'error'
    : issues.some((i) => i.severity === 'warning') ? 'warning' : null;
  const people = attendeesOf(seg, trip).map((id) => trip.people.find((p) => p.id === id)).filter(Boolean);

  return (
    <article
      className="bdc"
      data-board-item="card"
      data-card-id={seg.id}
      data-kind={seg.kind}
      data-selected={selected || undefined}
      data-dim={dim || undefined}
      data-drop={dropTarget || undefined}
      data-status={seg.status}
      data-loose={!wired && !seg.pinned ? 'yes' : undefined}
      style={{
        left: rect.x, top: rect.y, width: rect.w, height: rect.h,
        ...(seg.color ? { ['--c' as string]: seg.color } : null),
        ...(branch ? { ['--bc' as string]: branch.color } : null),
      }}
      tabIndex={0}
      aria-label={`${seg.title}, ${fmtDate(seg.start, zone, 'medium')} ${fmtTime(seg.start, { zone })}, ${people.length} people${worst ? `, has a ${worst}` : ''}`}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('.bdc__port, .bdc__pin')) return;
        e.stopPropagation();
        onSelect(e.shiftKey || e.metaKey || e.ctrlKey);
        if (connectMode) { onConnect(e); return; }
        if (e.button === 0 && !e.shiftKey) onGrab(e);
      }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(e.shiftKey); } }}
    >
      <span className="bdc__spine" />

      <header className="bdc__head">
        <span className="bdc__time mono">
          {fmtDate(seg.start, zone, 'short')} · {fmtTime(seg.start, { zone })}
          <span className="bdc__dur">{fmtDuration(seg.end - seg.start)}</span>
        </span>
        {worst && (
          <span className={`bdc__warn bdc__warn--${worst}`} title={issues[0]?.title}>
            <IconWarn size={11} />
          </span>
        )}
        <button
          className="bdc__pin" aria-pressed={!!seg.pinned} onClick={onTogglePin}
          title={seg.pinned ? 'Pinned — resolving will not move it' : 'Pin this time'}
          aria-label={seg.pinned ? `Unpin ${seg.title}` : `Pin ${seg.title}`}
        >
          <IconLock size={11} />
        </button>
      </header>

      <h4 className="bdc__title">{seg.title}</h4>
      <p className="bdc__where">
        {seg.flight
          ? `${seg.flight.carrier}${seg.flight.number} · ${seg.flight.fromCode}→${seg.flight.toCode}`
          : place?.name ?? KIND_LABEL[seg.kind] ?? seg.kind}
      </p>

      <footer className="bdc__foot">
        <span className="avatar-stack">
          {people.slice(0, 6).map((p) => p && (
            <span
              key={p.id} className="avatar avatar--sm" style={{ ['--c' as string]: p.color }}
              title={p.name}
              onPointerEnter={() => onHoverPerson(p.id)}
              onPointerLeave={() => onHoverPerson(null)}
            >
              {initials(p.name)}
            </span>
          ))}
          {people.length > 6 && <span className="avatar avatar--sm bdc__more">+{people.length - 6}</span>}
          {people.length === 0 && <span className="bdc__nobody">nobody yet</span>}
        </span>
        {seg.status === 'tentative' && <span className="bdc__tent" title="Tentative">?</span>}
      </footer>

      {/* four ports, the FigJam gesture: drag one onto another card */}
      {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
        <button
          key={side}
          className={`bdc__port bdc__port--${side}`}
          aria-label={`Connect ${seg.title} to what happens next`}
          title="Drag onto another card — that card then comes after this one"
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); onConnect(e); }}
        />
      ))}
    </article>
  );
}

function FrameBox({
  frame, trip, selected, delta, resizing, onSelect, onGrab, onResize, onRename, onDelete, onDissolveBranch,
}: {
  frame: Frame; trip: Trip; selected: boolean;
  delta: { dx: number; dy: number } | null;
  resizing: Point | null;
  onSelect: () => void;
  onGrab: (e: React.PointerEvent) => void;
  onResize: (e: React.PointerEvent) => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onDissolveBranch: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const branch = trip.branches.find((b) => b.id === frame.branchId);
  const rect: Rect = {
    x: frame.rect.x + (delta?.dx ?? 0),
    y: frame.rect.y + (delta?.dy ?? 0),
    w: resizing ? Math.max(160, resizing.x - frame.rect.x) : frame.rect.w,
    h: resizing ? Math.max(120, resizing.y - frame.rect.y) : frame.rect.h,
  };
  const count = trip.segments.filter((s) => s.at && contains(frame.rect, s.at)).length;

  return (
    <section
      className="bdf"
      data-board-item="frame"
      data-selected={selected || undefined}
      data-day={frame.dayKey ? 'yes' : undefined}
      data-branch={branch ? 'yes' : undefined}
      style={{ ...rectStyle(rect), ...(branch ? { ['--c' as string]: branch.color } : null) }}
      aria-label={`Frame ${frame.title}, ${count} cards`}
    >
      <header
        className="bdf__bar"
        onPointerDown={(e) => { e.stopPropagation(); onSelect(); onGrab(e); }}
        onDoubleClick={() => setEditing(true)}
      >
        {editing ? (
          <input
            className="bdf__rename" defaultValue={frame.title} autoFocus
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={(e) => { onRename(e.target.value); setEditing(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { onRename((e.target as HTMLInputElement).value); setEditing(false); }
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <span className="bdf__title truncate">{frame.title}</span>
        )}
        <span className="bdf__meta">
          {frame.dayKey && <span className="bdf__tag">day</span>}
          {branch && <span className="bdf__tag bdf__tag--branch">{branchMembers(trip, branch).length} away</span>}
          <span className="bdf__n">{count}</span>
        </span>
        {branch ? (
          <button
            className="bdf__x" onPointerDown={(e) => e.stopPropagation()} onClick={onDissolveBranch}
            aria-label={`Dissolve ${branch.name} back into the main timeline`}
            title="Dissolve back into the main timeline"
          ><IconClose size={11} /></button>
        ) : (
          <button
            className="bdf__x" onPointerDown={(e) => e.stopPropagation()} onClick={onDelete}
            aria-label={`Remove the frame ${frame.title}`}
            title="Remove this frame (the cards stay)"
          ><IconClose size={11} /></button>
        )}
      </header>
      <button
        className="bdf__resize" aria-label={`Resize ${frame.title}`}
        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); onResize(e); }}
      />
    </section>
  );
}

function StickyNote({
  note, selected, editing, delta, onSelect, onEdit, onCommit, onGrab, onDelete,
}: {
  note: Sticky; selected: boolean; editing: boolean;
  delta: { dx: number; dy: number } | null;
  onSelect: () => void; onEdit: () => void; onCommit: (text: string) => void;
  onGrab: (e: React.PointerEvent) => void; onDelete: () => void;
}) {
  const rect = stickyRect(note);
  return (
    <div
      className="bds"
      data-board-item="sticky"
      data-selected={selected || undefined}
      style={{
        ...rectStyle({ ...rect, x: rect.x + (delta?.dx ?? 0), y: rect.y + (delta?.dy ?? 0) }),
        ['--c' as string]: note.color,
      }}
      onPointerDown={(e) => {
        if (editing) return;
        e.stopPropagation();
        onSelect();
        onGrab(e);
      }}
      onDoubleClick={onEdit}
    >
      {editing ? (
        <textarea
          className="bds__edit" defaultValue={note.text} autoFocus
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => onCommit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onCommit((e.target as HTMLTextAreaElement).value); }}
        />
      ) : (
        <p className="bds__text">{note.text || 'Double-click to write'}</p>
      )}
      {selected && !editing && (
        <button className="bds__x" onClick={onDelete} onPointerDown={(e) => e.stopPropagation()} aria-label="Delete note">
          <IconClose size={11} />
        </button>
      )}
    </div>
  );
}

function LinkChip({
  link, at, trip, zone, selected, onSelect, onToggleKind, onDelete,
}: {
  link: Link; at: Point; trip: Trip; zone: string; selected: boolean;
  onSelect: () => void; onToggleKind: () => void; onDelete: () => void;
}) {
  const from = trip.segments.find((s) => s.id === link.fromId);
  const to = trip.segments.find((s) => s.id === link.toId);
  const gap = from && to ? (to.start - from.end) / MIN : 0;

  return (
    <div
      className="bdl" data-board-item="link" data-on={selected || undefined}
      style={{ left: at.x, top: at.y }}
      onPointerDown={(e) => { e.stopPropagation(); onSelect(); }}
    >
      <button className="bdl__kind" onClick={onToggleKind} title="Switch between a plain 'then' and a journey">
        {link.kind === 'travel' ? '⇢ travel' : 'then'}
      </button>
      {gap !== 0 && (
        <span className="bdl__gap mono" title={`Gap between them right now, in ${zone}`}>
          {gap < 0 ? 'overlaps' : fmtDuration(gap * MIN)}
        </span>
      )}
      {selected && (
        <button className="bdl__x" onClick={onDelete} aria-label="Delete connector"><IconClose size={10} /></button>
      )}
    </div>
  );
}

function ConnectGhost({ rect, to }: { rect: Rect | undefined; to: Point }) {
  if (!rect) return null;
  const from = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  const pull = Math.max(30, Math.abs(to.x - from.x) * 0.4);
  return (
    <path
      className="bd__wire bd__wire--ghost"
      d={`M ${from.x} ${from.y} C ${from.x + pull} ${from.y}, ${to.x - pull} ${to.y}, ${to.x} ${to.y}`}
      fill="none" markerEnd="url(#bd-arrow)"
    />
  );
}

/** The roster is fixed to the viewport, not to the board — it is a palette of
 *  people you drag onto cards, and it must not sail off when you pan. */
function Roster({
  trip, zone, now, dimPerson, onHover, onGrab,
}: {
  trip: Trip; zone: string; now: number;
  dimPerson: ID | null;
  onHover: (id: ID | null) => void;
  onGrab: (id: ID, e: React.PointerEvent) => void;
}) {
  if (!trip.people.length) return null;
  return (
    <div className="bd__roster" aria-label="Travellers — drag onto a card">
      <span className="bd__rosterlabel">Drag onto a card</span>
      {trip.people.map((p) => (
        <button
          key={p.id}
          className="bd__face"
          style={{ ['--c' as string]: p.color }}
          data-dim={dimPerson !== null && dimPerson !== p.id ? 'yes' : undefined}
          title={`${p.name} · ${p.homeCity}. Drag onto a card to put them on it.`}
          onPointerEnter={() => onHover(p.id)}
          onPointerLeave={() => onHover(null)}
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); onGrab(p.id, e); }}
        >
          {initials(p.name)}
        </button>
      ))}
      <span className="bd__rosterday mono">{fmtDate(now, zone, 'short')}</span>
    </div>
  );
}

function BranchDialog({
  trip, draft, onClose, onCreate,
}: {
  trip: Trip;
  draft: { name: string; ids: ID[] };
  onClose: () => void;
  onCreate: (name: string, memberIds: ID[]) => void;
}) {
  const suggested = useMemo(() => {
    const set = new Set<ID>();
    for (const id of draft.ids) {
      const seg = trip.segments.find((s) => s.id === id);
      if (seg) for (const a of attendeesOf(seg, trip)) set.add(a);
    }
    return [...set];
  }, [draft.ids, trip]);

  const [name, setName] = useState(draft.name);
  const [members, setMembers] = useState<ID[]>(suggested);
  const staying = trip.people.filter((p) => !members.includes(p.id));

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="branch-h">
      <div className="sheet__scrim" onClick={onClose} />
      <form className="sheet__panel" onSubmit={(e) => { e.preventDefault(); onCreate(name, members); }}>
        <h2 id="branch-h" className="sheet__title">Split off a sub-trip</h2>
        <p className="sheet__lead">
          A frame goes round the {draft.ids.length} selected {draft.ids.length === 1 ? 'card' : 'cards'}.
          Anything you drop into it from now on joins the sub-trip; everyone else carries on down the
          main line.
        </p>

        <label className="field">
          <span className="field__label">Call it</span>
          <input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Beach group" />
        </label>

        <fieldset className="field">
          <legend className="field__label">Who goes</legend>
          <div className="bd__picker">
            {trip.people.map((p) => {
              const on = members.includes(p.id);
              return (
                <label key={p.id} className="bd__pick" data-on={on || undefined} style={{ ['--c' as string]: p.color }}>
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
                ? 'Everyone is going — that is just the main plan. Leave someone behind, or cancel.'
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

function BoardEmpty({
  hasSegments, onTidy, onAdd,
}: {
  hasSegments: boolean; onTidy: () => void; onAdd: () => void;
}) {
  return (
    <div className="empty bd__empty">
      <p className="empty__title">A blank board</p>
      <p className="empty__body">
        {hasSegments
          ? 'This trip already has a plan but nothing has been put on the board yet. Tidy lays it out for you — a frame per day, in time order — and you can rearrange it however you like from there.'
          : 'Drop cards anywhere, wire them together in the order they happen, and put the ones that share a day inside a frame. When the shape is right, Resolve turns it into a schedule.'}
      </p>
      <div className="row" style={{ gap: 'var(--s-2)', justifyContent: 'center' }}>
        {hasSegments && (
          <button className="btn btn--primary" onClick={onTidy}>
            <IconSparkle size={15} /> Lay out the existing plan
          </button>
        )}
        <button className={`btn ${hasSegments ? '' : 'btn--primary'}`} onClick={onAdd}>
          <IconPlus size={15} /> Add the first card
        </button>
      </div>
    </div>
  );
}

/* ---------- odds and ends ---------- */

function rectStyle(r: Rect) {
  return { left: r.x, top: r.y, width: r.w, height: r.h };
}

export function kindForPlace(place: Place): Segment['kind'] {
  switch (place.kind) {
    case 'restaurant': return 'meal';
    case 'bar': return 'activity';
    case 'hotel': return 'checkin';
    case 'airport': return 'flight';
    case 'venue': case 'office': return 'session';
    default: return 'activity';
  }
}

export { CARD_W, CARD_H, STICKY_W, STICKY_H };

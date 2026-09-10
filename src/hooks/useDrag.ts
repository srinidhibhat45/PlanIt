/** Pointer + keyboard dragging for scheduled blocks.
 *
 *  The keyboard path is not a fallback — it is the same state machine driven
 *  by arrow keys, so a keyboard user can move a block to the minute and hears
 *  every change announced. That is what makes drag-and-drop here conform to
 *  WCAG 2.1.1 (Keyboard) and 2.5.7 (Dragging Movements). */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ID } from '../core/types';

export type DragMode = 'move' | 'resize-start' | 'resize-end';

export interface DragState {
  id: ID;
  mode: DragMode;
  /** Time shift in ms implied by the gesture so far. */
  deltaMs: number;
  /** Lane the pointer is currently over (index into the lane list). */
  laneIndex: number;
  originLane: number;
  pointer: { x: number; y: number } | null;
  viaKeyboard: boolean;
  /** True once the gesture passed the movement threshold. */
  engaged: boolean;
}

export interface DragCommit {
  id: ID;
  mode: DragMode;
  deltaMs: number;
  laneIndex: number;
  originLane: number;
  viaKeyboard: boolean;
}

export interface UseDragOptions {
  axis: 'x' | 'y';
  /** Milliseconds represented by one pixel along the axis. */
  msPerPx: () => number;
  /** Which lane a client coordinate falls in; return -1 to keep the current one. */
  laneAt?: (clientX: number, clientY: number) => number;
  onCommit: (c: DragCommit) => void;
  onCancel?: () => void;
  /** Called on every change while dragging — used for live announcements. */
  onPreview?: (s: DragState) => void;
  disabled?: boolean;
}

const THRESHOLD_PX = 3;

export function useDrag(opts: UseDragOptions) {
  const [state, setState] = useState<DragState | null>(null);
  const ref = useRef<{
    startX: number; startY: number; origin: DragState; pointerId: number; el: HTMLElement;
  } | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const stateRef = useRef<DragState | null>(null);
  stateRef.current = state;

  const finish = useCallback((commit: boolean) => {
    const s = stateRef.current;
    const start = ref.current;
    if (start && start.el.hasPointerCapture?.(start.pointerId)) {
      try { start.el.releasePointerCapture(start.pointerId); } catch { /* already gone */ }
    }
    ref.current = null;
    setState(null);
    if (!s) return;
    if (commit && (s.engaged || s.viaKeyboard)) {
      optsRef.current.onCommit({
        id: s.id, mode: s.mode, deltaMs: s.deltaMs,
        laneIndex: s.laneIndex, originLane: s.originLane, viaKeyboard: s.viaKeyboard,
      });
    } else {
      optsRef.current.onCancel?.();
    }
  }, []);

  /* ---------- pointer ---------- */

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, id: ID, mode: DragMode, laneIndex: number) => {
      if (optsRef.current.disabled) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const origin: DragState = {
        id, mode, deltaMs: 0, laneIndex, originLane: laneIndex,
        pointer: { x: e.clientX, y: e.clientY }, viaKeyboard: false, engaged: false,
      };
      ref.current = { startX: e.clientX, startY: e.clientY, origin, pointerId: e.pointerId, el };
      setState(origin);
    },
    [],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const start = ref.current;
    if (!start) return;
    const dx = e.clientX - start.startX;
    const dy = e.clientY - start.startY;
    const primary = optsRef.current.axis === 'x' ? dx : dy;
    const engaged = Math.hypot(dx, dy) > THRESHOLD_PX;
    if (!engaged && !start.origin.engaged) return;

    const laneAt = optsRef.current.laneAt;
    const lane = start.origin.mode === 'move' && laneAt ? laneAt(e.clientX, e.clientY) : -1;

    const next: DragState = {
      ...start.origin,
      engaged: true,
      deltaMs: start.origin.mode === 'move' || start.origin.mode === 'resize-start' || start.origin.mode === 'resize-end'
        ? primary * optsRef.current.msPerPx()
        : 0,
      laneIndex: lane >= 0 ? lane : start.origin.laneIndex,
      pointer: { x: e.clientX, y: e.clientY },
    };
    setState(next);
    optsRef.current.onPreview?.(next);
  }, []);

  const onPointerUp = useCallback((_e?: React.PointerEvent<HTMLElement>) => finish(true), [finish]);
  const onPointerCancel = useCallback((_e?: React.PointerEvent<HTMLElement>) => finish(false), [finish]);

  /* ---------- keyboard ---------- */

  const grab = useCallback((id: ID, laneIndex: number, mode: DragMode = 'move') => {
    const s: DragState = {
      id, mode, deltaMs: 0, laneIndex, originLane: laneIndex,
      pointer: null, viaKeyboard: true, engaged: true,
    };
    setState(s);
    optsRef.current.onPreview?.(s);
  }, []);

  /** Returns true when it handled the key. */
  const nudge = useCallback((deltaMs: number, laneDelta: number, laneCount: number) => {
    setState((prev) => {
      if (!prev) return prev;
      const next: DragState = {
        ...prev,
        deltaMs: prev.deltaMs + deltaMs,
        laneIndex: Math.max(0, Math.min(laneCount - 1, prev.laneIndex + laneDelta)),
      };
      optsRef.current.onPreview?.(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!state?.viaKeyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); finish(true); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state?.viaKeyboard, finish]);

  return {
    state,
    isDragging: !!state?.engaged,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    grab, nudge, commit: () => finish(true), cancel: () => finish(false),
  };
}

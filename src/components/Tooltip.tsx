/** Tooltips that actually explain the tool.
 *
 *  The browser's own `title` is the wrong instrument for a dense toolbar: it
 *  waits a second or more, it cannot be styled, it never appears for a
 *  keyboard user, and it is silently dropped on touch. Every icon-only control
 *  in this app therefore carries a `Tip` instead — a name, an optional
 *  shortcut, and a line saying what the thing is *for*.
 *
 *  Behaviour worth knowing:
 *   · The first tip waits a beat; once one has been shown, the neighbours
 *     appear instantly, so running along a toolbar reads like one label that
 *     follows the pointer rather than six separate waits.
 *   · Keyboard focus shows it immediately — that is the whole point of it not
 *     being `title`.
 *   · Escape, a click, or scrolling dismisses it.
 *   · It is `aria-describedby`, never the accessible *name*: the control keeps
 *     its own label so a screen reader is not at the mercy of hover. */

import {
  cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
} from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';

type Side = 'top' | 'bottom' | 'left' | 'right';

/** How long the very first tip in a burst waits before appearing. */
const WARM_UP = 340;
/** After a tip closes, its neighbours are "warm" for this long and open at once. */
const WARM_FOR = 600;
/** Breathing room between the control and its tip, and against the viewport. */
const GAP = 8;
const EDGE = 8;

let warmUntil = 0;

export interface TipContent {
  /** What the control is called — the first, bold line. */
  label: string;
  /** What it does, in a sentence. This is the part that saves the guess. */
  hint?: string;
  /** The keystroke that reaches it, e.g. `⌘K`, `N`, `[`. */
  keys?: string;
}

export function Tip({
  label, hint, keys, side = 'bottom', disabled, children,
}: TipContent & {
  side?: Side;
  /** Turn the tip off without unwrapping the control (e.g. while dragging). */
  disabled?: boolean;
  children: ReactElement<Record<string, unknown>>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; side: Side } | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen((was) => {
      if (was) warmUntil = Date.now() + WARM_FOR;
      return false;
    });
  }, []);

  const show = useCallback((immediate: boolean) => {
    if (disabled) return;
    window.clearTimeout(timer.current);
    const wait = immediate || Date.now() < warmUntil ? 0 : WARM_UP;
    if (wait === 0) { setOpen(true); return; }
    timer.current = window.setTimeout(() => setOpen(true), wait);
  }, [disabled]);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { if (disabled) close(); }, [disabled, close]);

  /* Anything that moves the control out from under the tip closes it: a
     scrolled toolbar would otherwise leave the label stranded mid-screen. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [open, close]);

  /* Measure once the tip exists, so it can flip and clamp rather than hang
     off the edge of the window. */
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const a = anchorRef.current?.getBoundingClientRect();
    const t = tipRef.current?.getBoundingClientRect();
    if (!a || !t) return;
    setPos(placeTip(a, t.width, t.height, side));
  }, [open, side, label, hint, keys]);

  if (!isValidElement(children)) return children;

  const child = children as ReactElement<Record<string, unknown>>;
  const childProps = child.props;
  const described = [childProps['aria-describedby'], open ? id : null].filter(Boolean).join(' ');

  const trigger = cloneElement(child, {
    // A native tooltip on top of this one would be two labels, half a second
    // apart, disagreeing about where they sit.
    title: undefined,
    'aria-describedby': described || undefined,
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
      assignRef(child, node);
    },
    onPointerEnter: (e: React.PointerEvent) => {
      (childProps.onPointerEnter as ((e: React.PointerEvent) => void) | undefined)?.(e);
      if (e.pointerType !== 'touch') show(false);
    },
    onPointerLeave: (e: React.PointerEvent) => {
      (childProps.onPointerLeave as ((e: React.PointerEvent) => void) | undefined)?.(e);
      close();
    },
    onPointerDown: (e: React.PointerEvent) => {
      (childProps.onPointerDown as ((e: React.PointerEvent) => void) | undefined)?.(e);
      close();
    },
    onFocus: (e: React.FocusEvent) => {
      (childProps.onFocus as ((e: React.FocusEvent) => void) | undefined)?.(e);
      // Only a keyboard arrival earns an instant tip; a click already told
      // the user what the control does by doing it.
      if (e.currentTarget.matches?.(':focus-visible')) show(true);
    },
    onBlur: (e: React.FocusEvent) => {
      (childProps.onBlur as ((e: React.FocusEvent) => void) | undefined)?.(e);
      close();
    },
  } as Record<string, unknown>);

  return (
    <>
      {trigger}
      {open && createPortal(
        <div
          ref={tipRef}
          id={id}
          role="tooltip"
          className="tip"
          data-side={pos?.side ?? side}
          style={{
            left: pos?.x ?? -9999,
            top: pos?.y ?? -9999,
            visibility: pos ? 'visible' : 'hidden',
          }}
        >
          <span className="tip__head">
            <span className="tip__label">{label}</span>
            {keys && <kbd className="tip__keys">{keys}</kbd>}
          </span>
          {hint && <span className="tip__hint">{hint}</span>}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Put the tip on the side there is room for, then keep it on screen. */
function placeTip(a: DOMRect, w: number, h: number, prefer: Side): { x: number; y: number; side: Side } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fits: Record<Side, boolean> = {
    bottom: a.bottom + GAP + h <= vh - EDGE,
    top: a.top - GAP - h >= EDGE,
    right: a.right + GAP + w <= vw - EDGE,
    left: a.left - GAP - w >= EDGE,
  };
  const order: Side[] = prefer === 'top' ? ['top', 'bottom', 'right', 'left']
    : prefer === 'left' ? ['left', 'right', 'bottom', 'top']
      : prefer === 'right' ? ['right', 'left', 'bottom', 'top']
        : ['bottom', 'top', 'right', 'left'];
  const side = order.find((s) => fits[s]) ?? prefer;

  let x = side === 'left' ? a.left - GAP - w
    : side === 'right' ? a.right + GAP
      : a.left + a.width / 2 - w / 2;
  let y = side === 'top' ? a.top - GAP - h
    : side === 'bottom' ? a.bottom + GAP
      : a.top + a.height / 2 - h / 2;

  x = Math.max(EDGE, Math.min(x, vw - EDGE - w));
  y = Math.max(EDGE, Math.min(y, vh - EDGE - h));
  return { x, y, side };
}

/** Keep whatever ref the wrapped element already had. In React 19 a ref is an
 *  ordinary prop, so that is the only place worth looking — reading
 *  `element.ref` is deprecated and warns. */
function assignRef(el: ReactElement, node: HTMLElement | null) {
  const ref = (el.props as { ref?: unknown } | undefined)?.ref;
  if (typeof ref === 'function') (ref as (n: HTMLElement | null) => void)(node);
  else if (ref && typeof ref === 'object') (ref as { current: HTMLElement | null }).current = node;
}

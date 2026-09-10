/** Which clock the whole app renders in.
 *  A real menu rather than a cramped select: eight people across three zones
 *  is the point of this app, so switching between their clocks has to be
 *  one obvious click and fully keyboard-driven. */

import { useEffect, useId, useRef, useState } from 'react';
import type { ClockMode, ID, Trip } from '../core/types';
import { clockLabel } from '../core/clock';
import { deviceZone, zoneAbbr, zoneCity } from '../core/time';
import { IconChevron, IconGlobe } from './Icons';

export function ClockMenu({ trip, clock, onClock }: {
  trip: Trip; clock: ClockMode; onClock: (c: ClockMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); wrapRef.current?.querySelector('button')?.focus(); }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[aria-checked="true"], button')?.focus());
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const options: { key: string; label: string; sub: string; value: ClockMode }[] = [
    { key: 'event', label: 'Item local time', sub: 'Each block in the zone it happens in', value: { type: 'event' } },
    { key: 'base', label: 'Trip time', sub: `${zoneCity(trip.baseTimezone)} · ${zoneAbbr(Date.now(), trip.baseTimezone)}`, value: { type: 'base' } },
    { key: 'device', label: 'My device', sub: `${zoneCity(deviceZone())} · ${zoneAbbr(Date.now(), deviceZone())}`, value: { type: 'device' } },
    ...trip.people.map((p) => ({
      key: `person:${p.id}`,
      label: `${p.name.split(' ')[0]}’s clock`,
      sub: `${zoneCity(p.homeTimezone)} · ${zoneAbbr(Date.now(), p.homeTimezone)}`,
      value: { type: 'person', personId: p.id } as ClockMode,
    })),
  ];

  const currentKey = clock.type === 'person' ? `person:${(clock as { personId: ID }).personId}` : clock.type;

  const move = (dir: 1 | -1) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + dir + items.length) % items.length]?.focus();
  };

  return (
    <div className="clockmenu" ref={wrapRef}>
      <button
        type="button"
        className="btn clockmenu__trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={id}
        title={'Which clock every time in the app is written in\nRight now: ' + clockLabel(clock, trip)}
        onClick={() => setOpen((o) => !o)}
      >
        <IconGlobe size={15} />
        <span className="clockmenu__label">{clockLabel(clock, trip)}</span>
        <IconChevron size={13} />
      </button>

      {open && (
        <div className="clockmenu__panel" id={id} role="menu" aria-label="Show times in" ref={listRef}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
          }}>
          <p className="eyebrow" style={{ padding: 'var(--s-2) var(--s-3) var(--s-1)' }}>Show times in</p>
          {options.map((o, i) => (
            <button
              key={o.key}
              type="button"
              role="menuitemradio"
              aria-checked={currentKey === o.key}
              className="clockmenu__item"
              title={`${o.label} — ${o.sub}`}
              onClick={() => { onClock(o.value); setOpen(false); }}
            >
              <span className="clockmenu__check" aria-hidden="true">{currentKey === o.key ? '●' : ''}</span>
              <span>
                <span className="clockmenu__name">{o.label}</span>
                <span className="clockmenu__sub">{o.sub}</span>
              </span>
              {i === 2 && <span className="sr-only">End of general options; people follow.</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

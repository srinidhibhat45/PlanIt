/** Find a place by name, by pasted map link, or by raw coordinates.
 *
 *  Results from the built-in gazetteer appear on the first keystroke and never
 *  go away; live results are merged in behind them if and when the network
 *  answers. Nothing here ever shows a spinner in place of results — the offline
 *  list is always the floor. */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Place, Zone } from '../core/types';
import {
  isShortMapLink, mergeHits, parseMapLink, placeFromHit, searchBuiltin, searchLive,
  type PlaceHit,
} from '../core/geo';
import { zoneAbbr } from '../core/time';
import { IconGlobe, IconLink, IconSearch } from './Icons';

const KIND_GLYPH: Record<string, string> = {
  airport: '✈', hotel: '⌂', venue: '◈', restaurant: '☖', bar: '♨',
  temple: '⛩', landmark: '⚑', transit: '⇄', office: '▣', other: '◦',
};

export function PlaceSearch({
  zone, near, existing, autoFocus, placeholder, onPick, onClose,
}: {
  /** Fallback zone for coordinates that fall outside every known box. */
  zone: Zone;
  /** Biases live search towards the trip, so "the pub" finds a local one. */
  near?: { lat: number; lon: number };
  /** Places already on the trip, offered first so they are reused not cloned. */
  existing: Place[];
  autoFocus?: boolean;
  placeholder?: string;
  onPick: (place: Place, isNew: boolean) => void;
  onClose?: () => void;
}) {
  const [q, setQ] = useState('');
  const [live, setLive] = useState<PlaceHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  const pasted = useMemo(() => parseMapLink(q, zone), [q, zone]);
  const shortLink = !pasted && isShortMapLink(q);

  const mine = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 1) return existing.slice(0, 4);
    return existing
      .filter((p) => `${p.name} ${p.address ?? ''} ${p.code ?? ''}`.toLowerCase().includes(needle))
      .slice(0, 5);
  }, [existing, q]);

  const builtin = useMemo(() => (pasted ? [] : searchBuiltin(q)), [q, pasted]);

  // Live search is debounced and abortable: typing fast must not queue up a
  // dozen requests, and an answer to an old query must never overwrite a new one.
  useEffect(() => {
    if (pasted || q.trim().length < 3) { setLive([]); setBusy(false); return; }
    const controller = new AbortController();
    setBusy(true);
    const timer = setTimeout(async () => {
      const hits = await searchLive(q, controller.signal, near);
      if (!controller.signal.aborted) { setLive(hits); setBusy(false); }
    }, 320);
    return () => { controller.abort(); clearTimeout(timer); setBusy(false); };
  }, [q, near, pasted]);

  const hits = useMemo(
    () => (pasted ? [pasted] : mergeHits(builtin, live)).slice(0, 9),
    [pasted, builtin, live],
  );

  const rows: ({ kind: 'existing'; place: Place } | { kind: 'hit'; hit: PlaceHit })[] = [
    ...mine.map((place) => ({ kind: 'existing' as const, place })),
    ...hits.map((hit) => ({ kind: 'hit' as const, hit })),
  ];

  useEffect(() => { setCursor(0); }, [q]);

  const choose = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (row.kind === 'existing') onPick(row.place, false);
    else onPick(placeFromHit(row.hit), true);
    setQ('');
  };

  return (
    <div className="psearch">
      <div className="psearch__box">
        <IconSearch size={15} />
        <input
          ref={inputRef}
          className="psearch__input"
          value={q}
          placeholder={placeholder ?? 'Search a place, or paste a map link'}
          aria-label="Search for a place"
          aria-controls={listId}
          aria-expanded={rows.length > 0}
          role="combobox"
          aria-autocomplete="list"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(rows.length - 1, c + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); choose(cursor); }
            else if (e.key === 'Escape') { if (q) setQ(''); else onClose?.(); }
          }}
        />
        {busy && <span className="psearch__busy" aria-hidden="true" />}
      </div>

      {shortLink && (
        <p className="psearch__note">
          Shortened map links cannot be opened from a browser. Open it once, then copy the
          full address out of the address bar — or just paste the coordinates.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="psearch__list" id={listId} role="listbox">
          {rows.map((row, i) => {
            const selected = i === cursor;
            if (row.kind === 'existing') {
              return (
                <li key={`e-${row.place.id}`}>
                  <button
                    type="button" role="option" aria-selected={selected}
                    className="psearch__row" data-on={selected || undefined}
                    onMouseEnter={() => setCursor(i)} onClick={() => choose(i)}
                  >
                    <span className="psearch__glyph" aria-hidden="true">{KIND_GLYPH[row.place.kind] ?? '◦'}</span>
                    <span className="psearch__text">
                      <span className="psearch__name">{row.place.name}</span>
                      <span className="psearch__ctx">{row.place.address ?? row.place.kind}</span>
                    </span>
                    <span className="chip chip--accent">on this trip</span>
                  </button>
                </li>
              );
            }
            const h = row.hit;
            return (
              <li key={`h-${h.lat},${h.lon},${h.name}`}>
                <button
                  type="button" role="option" aria-selected={selected}
                  className="psearch__row" data-on={selected || undefined}
                  onMouseEnter={() => setCursor(i)} onClick={() => choose(i)}
                >
                  <span className="psearch__glyph" aria-hidden="true">{KIND_GLYPH[h.kind] ?? '◦'}</span>
                  <span className="psearch__text">
                    <span className="psearch__name">
                      {h.name}
                      {h.code && <span className="psearch__code">{h.code}</span>}
                    </span>
                    <span className="psearch__ctx">{h.context}</span>
                  </span>
                  <span className="psearch__meta">
                    {h.source === 'link' || h.source === 'coords'
                      ? <IconLink size={13} />
                      : h.source === 'osm' ? <IconGlobe size={13} /> : null}
                    <span className="mono">{zoneAbbr(Date.now(), h.timezone)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {q.trim().length >= 2 && rows.length === 0 && !busy && (
        <p className="psearch__note">
          Nothing found. Paste a Google Maps or OpenStreetMap link instead, or type
          coordinates as <span className="mono">15.2993, 74.1240</span>.
        </p>
      )}
    </div>
  );
}

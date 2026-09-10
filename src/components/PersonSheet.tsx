/** Add or edit one traveller.
 *
 *  The two fields that matter most are the ones people skip: where they are
 *  coming from, and when they can actually be there. Both drive the analyser —
 *  a home city gives the first leg a distance, and an availability window is
 *  what lets the app say "that workshop is before Priya lands" without waiting
 *  for a flight to be entered. So both get real estate here, not a fold-out. */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ID, Person, Trip, Zone } from '../core/types';
import { dateKey, fromZoned, toParts, zoneCity } from '../core/time';
import { guessZone } from '../core/geo';
import { uid } from '../core/store';
import { PlaceSearch } from './PlaceSearch';
import { initials } from './SegmentChrome';
import { IconClose, IconTrash } from './Icons';

const SWATCHES = [
  '#ff6b35', '#14d4c4', '#8b7cff', '#ffb020', '#ff6b9d',
  '#5ac8fa', '#a3e635', '#f472b6', '#38bdf8', '#fb923c',
];

/** A colour nobody else on the trip already has. */
export function nextPersonColor(trip: Trip): string {
  const used = new Set(trip.people.map((p) => p.color));
  return SWATCHES.find((c) => !used.has(c)) ?? SWATCHES[trip.people.length % SWATCHES.length];
}

export function emptyPerson(trip: Trip): Person {
  return {
    id: uid('per'),
    name: '',
    homeCity: '',
    homeTimezone: trip.baseTimezone,
    color: nextPersonColor(trip),
    groupIds: [],
    interests: [],
  };
}

/** Split a stored epoch into the date and time inputs, in a given zone. */
function toFields(at: number | undefined, zone: Zone): { date: string; time: string } {
  if (at === undefined) return { date: '', time: '' };
  const p = toParts(at, zone);
  return {
    date: dateKey(at, zone),
    time: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`,
  };
}

function fromFields(date: string, time: string, zone: Zone): number | undefined {
  if (!date) return undefined;
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  if (!y || !m || !d) return undefined;
  return fromZoned(y, m, d, hh || 0, mm || 0, 0, zone);
}

export function PersonSheet({
  trip, person, onSave, onDelete, onClose,
}: {
  trip: Trip;
  /** Undefined for a brand new person. */
  person?: Person;
  onSave: (person: Person) => void;
  onDelete?: (id: ID) => void;
  onClose: () => void;
}) {
  const seed = useMemo(() => person ?? emptyPerson(trip), [person, trip]);
  const [draft, setDraft] = useState<Person>(seed);
  const [interestText, setInterestText] = useState(seed.interests.join(', '));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const zone = trip.baseTimezone;
  const [inFields, setIn] = useState(() => toFields(seed.windowStart, zone));
  const [outFields, setOut] = useState(() => toFields(seed.windowEnd, zone));

  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const patch = (p: Partial<Person>) => setDraft((d) => ({ ...d, ...p }));

  const windowStart = fromFields(inFields.date, inFields.time, zone);
  const windowEnd = fromFields(outFields.date, outFields.time, zone);
  const windowBackwards = windowStart !== undefined && windowEnd !== undefined && windowEnd <= windowStart;
  const valid = draft.name.trim().length > 0 && !windowBackwards;

  const submit = () => {
    if (!valid) return;
    onSave({
      ...draft,
      name: draft.name.trim(),
      homeCity: draft.homeCity.trim(),
      interests: interestText.split(',').map((s) => s.trim()).filter(Boolean),
      windowStart,
      windowEnd,
    });
  };

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="person-h">
      <div className="sheet__scrim" onClick={onClose} />
      <form
        className="sheet__panel sheet__panel--wide"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
      >
        <div className="row row--between">
          <h2 id="person-h" className="sheet__title">
            {person ? `Edit ${person.name || 'traveller'}` : 'Add someone to the trip'}
          </h2>
          <button type="button" className="btn btn--icon btn--ghost" onClick={onClose} title="Close · Esc" aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>

        <div className="psheet">
          <div className="psheet__identity">
            <span className="avatar avatar--lg" style={{ ['--c' as string]: draft.color }} aria-hidden="true">
              {initials(draft.name || '?')}
            </span>
            <fieldset className="psheet__swatches">
              <legend className="sr-only">Colour</legend>
              {SWATCHES.map((c) => (
                <label key={c} className="psheet__swatch" style={{ background: c }}>
                  <input
                    type="radio" name="colour" value={c} checked={draft.color === c}
                    onChange={() => patch({ color: c })}
                  />
                  <span className="sr-only">Colour {c}</span>
                </label>
              ))}
            </fieldset>
          </div>

          <label className="field">
            <span className="field__label">Name</span>
            <input
              ref={nameRef} className="input" value={draft.name} required
              placeholder="Aarti Naik"
              onChange={(e) => patch({ name: e.target.value })}
            />
          </label>

          <div className="row" style={{ gap: 'var(--s-3)' }}>
            <label className="field grow">
              <span className="field__label">Email <span className="field__opt">optional</span></span>
              <input
                className="input" type="email" value={draft.email ?? ''}
                onChange={(e) => patch({ email: e.target.value || undefined })}
              />
            </label>
            <label className="field grow">
              <span className="field__label">Phone <span className="field__opt">optional</span></span>
              <input
                className="input" type="tel" value={draft.phone ?? ''}
                onChange={(e) => patch({ phone: e.target.value || undefined })}
              />
            </label>
          </div>

          <div className="field">
            <span className="field__label">Travelling from</span>
            {draft.homeCity ? (
              <div className="psheet__chosen">
                <span className="grow">
                  <strong>{draft.homeCity}</strong>
                  <span className="psheet__zone">
                    {zoneCity(draft.homeTimezone)}
                    {draft.homeLat !== undefined && ` · ${draft.homeLat.toFixed(2)}, ${draft.homeLon?.toFixed(2)}`}
                  </span>
                </span>
                <button
                  type="button" className="btn btn--sm btn--ghost"
                  onClick={() => patch({ homeCity: '', homeLat: undefined, homeLon: undefined })}
                >
                  Change
                </button>
              </div>
            ) : (
              <PlaceSearch
                zone={trip.baseTimezone}
                existing={trip.places}
                placeholder="Their home city — Goa, Delhi, London…"
                // A home city is not a stop on the trip, so it is recorded on
                // the person and deliberately not added to the trip's places.
                onPick={(place) => patch({
                  homeCity: place.name,
                  homeTimezone: place.timezone || guessZone(place.lat, place.lon, trip.baseTimezone),
                  homeLat: place.lat,
                  homeLon: place.lon,
                })}
              />
            )}
            <span className="field__help">
              Sets their clock, and lets the app model the journey in before any flight is entered.
            </span>
          </div>

          <fieldset className="psheet__window">
            <legend className="field__label">When they can be there</legend>
            <p className="field__help" style={{ marginTop: 0 }}>
              Leave blank if they are around for the whole trip. Anything scheduled outside this
              is flagged as impossible rather than merely tight.
            </p>
            <div className="row" style={{ gap: 'var(--s-3)', flexWrap: 'wrap' }}>
              <label className="field">
                <span className="field__label">From</span>
                <div className="row" style={{ gap: 4 }}>
                  <input
                    className="input" type="date" value={inFields.date}
                    min={trip.startDate} max={trip.endDate}
                    onChange={(e) => setIn((f) => ({ ...f, date: e.target.value }))}
                  />
                  <input
                    className="input input--time" type="time" value={inFields.time} step={300}
                    disabled={!inFields.date}
                    onChange={(e) => setIn((f) => ({ ...f, time: e.target.value }))}
                  />
                </div>
              </label>
              <label className="field">
                <span className="field__label">Until</span>
                <div className="row" style={{ gap: 4 }}>
                  <input
                    className="input" type="date" value={outFields.date}
                    min={inFields.date || trip.startDate}
                    onChange={(e) => setOut((f) => ({ ...f, date: e.target.value }))}
                  />
                  <input
                    className="input input--time" type="time" value={outFields.time} step={300}
                    disabled={!outFields.date}
                    onChange={(e) => setOut((f) => ({ ...f, time: e.target.value }))}
                  />
                </div>
              </label>
            </div>
            {windowBackwards && (
              <p className="field__error">They cannot leave before they arrive.</p>
            )}
          </fieldset>

          <label className="field">
            <span className="field__label">Interests <span className="field__opt">comma separated</span></span>
            <input
              className="input" value={interestText}
              placeholder="food, beaches, live music"
              onChange={(e) => setInterestText(e.target.value)}
            />
            <span className="field__help">Used when the app suggests something for a free evening.</span>
          </label>

          <div className="row" style={{ gap: 'var(--s-3)' }}>
            <label className="field grow">
              <span className="field__label">Dietary <span className="field__opt">optional</span></span>
              <input
                className="input" value={draft.dietary ?? ''} placeholder="vegetarian, no nuts"
                onChange={(e) => patch({ dietary: e.target.value || undefined })}
              />
            </label>
            <label className="field grow">
              <span className="field__label">Mobility <span className="field__opt">optional</span></span>
              <input
                className="input" value={draft.mobilityNotes ?? ''} placeholder="no long walks"
                onChange={(e) => patch({ mobilityNotes: e.target.value || undefined })}
              />
            </label>
          </div>

          <label className="field">
            <span className="field__label">Notes <span className="field__opt">optional</span></span>
            <textarea
              className="input" rows={2} value={draft.notes ?? ''}
              onChange={(e) => patch({ notes: e.target.value || undefined })}
            />
          </label>
        </div>

        <div className="row row--between" style={{ marginTop: 'var(--s-4)' }}>
          {person && onDelete ? (
            confirmDelete ? (
              <span className="row" style={{ gap: 'var(--s-2)' }}>
                <span className="field__error" style={{ margin: 0 }}>Remove from the trip?</span>
                <button type="button" className="btn btn--sm btn--danger" onClick={() => onDelete(person.id)}>
                  Remove
                </button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
              </span>
            ) : (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirmDelete(true)}>
                <IconTrash size={14} /> Remove
              </button>
            )
          ) : <span />}

          <span className="row" style={{ gap: 'var(--s-2)' }}>
            <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={!valid}>
              {person ? 'Save' : 'Add to trip'}
            </button>
          </span>
        </div>
      </form>
    </div>
  );
}

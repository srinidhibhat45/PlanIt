/** The library: every trip in this browser, and the door into a new one.
 *
 *  This is the first screen. It has one job — get someone into a trip in as
 *  few decisions as possible — so the new-trip form asks for four things and
 *  guesses three of them. */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ID, Trip, Zone } from '../core/types';
import { blankTrip, defaultDates, tripLengthDays, type TripMeta } from '../core/library';
import { dateKeyToEpoch, deviceZone, fmtDate } from '../core/time';
import { isValidZone } from '../core/geo';
import { IconCopy, IconPlus, IconSparkle, IconTrash, IconUpload } from './Icons';
import { Tip } from './Tooltip';

const COMMON_ZONES: Zone[] = [
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Bangkok', 'Asia/Tokyo',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York',
  'America/Los_Angeles', 'Australia/Sydney', 'UTC',
];

export function TripsView({
  trips, onOpen, onCreate, onDuplicate, onDelete, onLoadExample, onImport,
}: {
  trips: TripMeta[];
  onOpen: (id: ID) => void;
  onCreate: (trip: Trip) => void;
  onDuplicate: (id: ID) => void;
  onDelete: (id: ID) => void;
  onLoadExample: () => void;
  onImport: (file: File) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [confirmId, setConfirmId] = useState<ID | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="library">
      <header className="library__top">
        <div className="row" style={{ gap: 'var(--s-3)', alignItems: 'center' }}>
          <span className="brand__mark" aria-hidden="true">P</span>
          <div>
            <h1 className="library__brand">PlanIt</h1>
            <p className="library__tag">
              Itineraries for groups who do not all do the same thing at the same time.
            </p>
          </div>
        </div>
        <div className="row" style={{ gap: 'var(--s-2)' }}>
          <input
            ref={fileRef} type="file" accept="application/json,.json" hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImport(f);
              e.target.value = '';
            }}
          />
          <Tip label="Import a trip" hint="Opens a JSON backup you exported from the share dialog earlier. It arrives as a new trip of your own.">
            <button className="btn btn--ghost" onClick={() => fileRef.current?.click()}>
              <IconUpload size={15} /> Import
            </button>
          </Tip>
          <Tip label="New trip" hint="An empty itinerary: name it, pick the dates and the zone it happens in, then add who is coming." side="left">
            <button className="btn btn--primary" onClick={() => setCreating(true)}>
              <IconPlus size={15} /> New trip
            </button>
          </Tip>
        </div>
      </header>

      <div className="library__body">
        {trips.length === 0 && !creating && (
          <div className="library__empty">
            <h2 className="library__emptytitle">No trips yet</h2>
            <p className="library__emptybody">
              A trip holds the people, the places and the plan. Start an empty one and add
              who is coming, or open the worked example to see what a finished one looks like.
            </p>
            <div className="row" style={{ gap: 'var(--s-2)', justifyContent: 'center' }}>
              <button className="btn btn--primary btn--lg" onClick={() => setCreating(true)}>
                <IconPlus size={16} /> Start a trip
              </button>
              <Tip label="Open the example" hint="A fully worked eight-person conference trip — people, flights, clashes and all — to look around in.">
                <button className="btn btn--lg" onClick={onLoadExample}>
                  <IconSparkle size={16} /> Open the example
                </button>
              </Tip>
            </div>
          </div>
        )}

        {trips.length > 0 && (
          <>
            <div className="row row--between" style={{ marginBottom: 'var(--s-4)' }}>
              <h2 className="library__heading">
                {trips.length} {trips.length === 1 ? 'trip' : 'trips'}
              </h2>
              <Tip label="Add the example trip" hint="A fully worked eight-person conference trip, added alongside your own. Delete it whenever you like." side="left">
                <button className="btn btn--sm btn--ghost" onClick={onLoadExample}>
                  <IconSparkle size={14} /> Add the example trip
                </button>
              </Tip>
            </div>
            <ul className="library__grid">
              {trips.map((t) => (
                <li key={t.id}>
                  <TripCard
                    meta={t}
                    confirming={confirmId === t.id}
                    onOpen={() => onOpen(t.id)}
                    onDuplicate={() => onDuplicate(t.id)}
                    onAskDelete={() => setConfirmId(t.id)}
                    onCancelDelete={() => setConfirmId(null)}
                    onConfirmDelete={() => { onDelete(t.id); setConfirmId(null); }}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {creating && (
        <NewTripDialog
          onClose={() => setCreating(false)}
          onCreate={(trip) => { setCreating(false); onCreate(trip); }}
        />
      )}
    </div>
  );
}

function TripCard({
  meta, confirming, onOpen, onDuplicate, onAskDelete, onCancelDelete, onConfirmDelete,
}: {
  meta: TripMeta; confirming: boolean;
  onOpen: () => void; onDuplicate: () => void;
  onAskDelete: () => void; onCancelDelete: () => void; onConfirmDelete: () => void;
}) {
  const days = tripLengthDays(meta);
  const start = dateKeyToEpoch(meta.startDate, meta.baseTimezone);
  const end = dateKeyToEpoch(meta.endDate, meta.baseTimezone);
  const when = `${fmtDate(start, meta.baseTimezone, 'medium')} – ${fmtDate(end, meta.baseTimezone, 'medium')}`;
  const past = end < Date.now();

  return (
    <article className="tripcard" data-past={past || undefined}>
      <button className="tripcard__hit" onClick={onOpen} aria-label={`Open ${meta.name}`} />
      <div className="tripcard__head">
        <h3 className="tripcard__name">{meta.name}</h3>
        {meta.subtitle && <p className="tripcard__sub truncate">{meta.subtitle}</p>}
      </div>

      <p className="tripcard__when">{when}</p>

      <div className="tripcard__stats">
        <span className="chip">{days} {days === 1 ? 'day' : 'days'}</span>
        <span className="chip">{meta.peopleCount} {meta.peopleCount === 1 ? 'person' : 'people'}</span>
        <span className="chip">{meta.segmentCount} blocks</span>
        {meta.branchCount > 0 && (
          <span className="chip chip--accent">{meta.branchCount} sub-{meta.branchCount === 1 ? 'trip' : 'trips'}</span>
        )}
      </div>

      <div className="tripcard__foot">
        <div className="avatar-stack" aria-hidden="true">
          {meta.swatches.map((c, i) => (
            <span className="avatar avatar--sm" key={i} style={{ background: c, color: '#0b0c12' }} />
          ))}
          {meta.peopleCount > meta.swatches.length && (
            <span className="avatar avatar--sm tripcard__more">+{meta.peopleCount - meta.swatches.length}</span>
          )}
          {meta.peopleCount === 0 && <span className="tripcard__nobody">Nobody added yet</span>}
        </div>

        <div className="tripcard__actions">
          {confirming ? (
            <>
              <span className="tripcard__confirm">Delete for good?</span>
              <button className="btn btn--sm btn--danger" onClick={onConfirmDelete}>Delete</button>
              <button className="btn btn--sm btn--ghost" onClick={onCancelDelete}>Keep</button>
            </>
          ) : (
            <>
              <Tip label="Duplicate this trip" hint="The same plan as a separate trip. The two share nothing after the copy — change one and the other stays put.">
                <button
                  className="btn btn--icon btn--sm btn--ghost" onClick={onDuplicate}
                  aria-label={`Duplicate ${meta.name}`}
                >
                  <IconCopy size={14} />
                </button>
              </Tip>
              <Tip label="Delete this trip" hint="Asks first. Trips live in this browser only, so a deleted one cannot be recovered from anywhere else." side="left">
                <button
                  className="btn btn--icon btn--sm btn--ghost" onClick={onAskDelete}
                  aria-label={`Delete ${meta.name}`}
                >
                  <IconTrash size={14} />
                </button>
              </Tip>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function NewTripDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (t: Trip) => void }) {
  const guessZone = useMemo(() => deviceZone(), []);
  const dates = useMemo(() => defaultDates(guessZone), [guessZone]);
  const [name, setName] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [startDate, setStart] = useState(dates.startDate);
  const [endDate, setEnd] = useState(dates.endDate);
  const [zone, setZone] = useState<Zone>(guessZone);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const zoneOk = isValidZone(zone);
  const datesOk = endDate >= startDate;
  const valid = name.trim().length > 0 && zoneOk && datesOk;
  const zoneOptions = useMemo(
    () => [...new Set([guessZone, ...COMMON_ZONES])],
    [guessZone],
  );

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="newtrip-h">
      <div className="sheet__scrim" onClick={onClose} />
      <form
        className="sheet__panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          onCreate(blankTrip({ name, subtitle, startDate, endDate, baseTimezone: zone }));
        }}
      >
        <h2 id="newtrip-h" className="sheet__title">New trip</h2>
        <p className="sheet__lead">
          Dates can move later — nothing here is locked in.
        </p>

        <label className="field">
          <span className="field__label">What is it</span>
          <input
            ref={nameRef} className="input" value={name} required
            placeholder="Goa, October"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field__label">One line about it <span className="field__opt">optional</span></span>
          <input
            className="input" value={subtitle}
            placeholder="Eight of us, three of whom leave early"
            onChange={(e) => setSubtitle(e.target.value)}
          />
        </label>

        <div className="row" style={{ gap: 'var(--s-3)' }}>
          <label className="field grow">
            <span className="field__label">First day</span>
            <input
              className="input" type="date" value={startDate}
              onChange={(e) => {
                setStart(e.target.value);
                if (endDate < e.target.value) setEnd(e.target.value);
              }}
            />
          </label>
          <label className="field grow">
            <span className="field__label">Last day</span>
            <input className="input" type="date" value={endDate} min={startDate} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span className="field__label">Where it happens</span>
          <select className="input" value={zone} onChange={(e) => setZone(e.target.value)}>
            {zoneOptions.map((z) => (
              <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>
            ))}
          </select>
          <span className="field__help">
            The clock the plan is drawn in. People flying in from elsewhere keep their own —
            you set that per person.
          </span>
        </label>

        <div className="row row--between" style={{ marginTop: 'var(--s-4)' }}>
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!valid}>
            Create and add people
          </button>
        </div>
      </form>
    </div>
  );
}

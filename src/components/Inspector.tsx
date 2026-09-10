/** Detail editor for one block. Every field writes straight through to the
 *  reducer, so undo works at field granularity. Times are edited in the
 *  segment's own zone and stored as UTC. */

import { useMemo } from 'react';
import type { ClockMode, ID, Issue, Segment, SegmentKind, SegmentStatus, Trip } from '../core/types';
import { MIN, fmtDuration, fmtTime, pad, parseLocal, toParts, zoneAbbr, zoneCity } from '../core/time';
import { attendeesOf } from '../core/schedule';
import { KIND_LABEL } from '../core/layout';
import { googleCalendarUrl, outlookUrl, iconFor } from '../core/ics';
import { estimateTravel, overheadMinutes, trafficLabel, travelMinutes } from '../core/travel';
import { initials } from './SegmentChrome';
import { IconClose, IconCopy, IconLink, IconLock, IconTrash } from './Icons';

const KINDS: SegmentKind[] = ['flight', 'transfer', 'checkin', 'checkout', 'session', 'workshop', 'meal', 'activity', 'free', 'rest', 'buffer', 'note'];
const STATUSES: SegmentStatus[] = ['confirmed', 'tentative', 'cancelled'];

export function Inspector({
  seg, trip, clock, issues, onPatch, onDelete, onDuplicate, onClose, onToggleAttendee, onSelect,
}: {
  seg: Segment | null; trip: Trip; clock: ClockMode; issues: Issue[];
  onPatch: (id: ID, patch: Partial<Segment>, label?: string) => void;
  onDelete: (id: ID) => void;
  onDuplicate: (id: ID) => void;
  onClose: () => void;
  onToggleAttendee: (id: ID, personId: ID, on: boolean) => void;
  onSelect: (id: ID) => void;
}) {
  const zone = seg?.timezone ?? trip.baseTimezone;
  const attendees = useMemo(() => (seg ? attendeesOf(seg, trip) : []), [seg, trip]);
  const related = useMemo(
    () => (seg ? issues.filter((i) => i.segmentIds.includes(seg.id)) : []),
    [issues, seg],
  );

  if (!seg) {
    return (
      <div className="inspector__inner">
        <div className="empty">
          <p className="empty__title">Nothing selected</p>
          <p className="empty__body">
            Pick a block on the timeline to edit it. Press <kbd>?</kbd> for the full keyboard map.
          </p>
        </div>
      </div>
    );
  }

  const sp = toParts(seg.start, zone);
  const ep = toParts(seg.end, zone);
  const dateVal = (p: typeof sp) => `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const timeVal = (p: typeof sp) => `${pad(p.hour)}:${pad(p.minute)}`;

  const setStart = (date: string, time: string) => {
    const start = parseLocal(date, time, zone);
    onPatch(seg.id, { start, end: start + (seg.end - seg.start) }, 'Changed start time');
  };
  const setEnd = (date: string, time: string) => {
    const end = parseLocal(date, time, zone);
    onPatch(seg.id, { end: Math.max(end, seg.start + 5 * MIN) }, 'Changed end time');
  };

  const fromPlace = trip.places.find((p) => p.id === seg.fromPlaceId);
  const toPlace = trip.places.find((p) => p.id === (seg.toPlaceId ?? seg.placeId));
  // A flight is not a long taxi ride: infer the mode from the kind unless the
  // segment says otherwise.
  const mode = seg.travel?.mode ?? (seg.kind === 'flight' ? 'plane' : 'taxi');
  const est = fromPlace && toPlace && fromPlace.id !== toPlace.id
    ? estimateTravel({ from: fromPlace, to: toPlace, mode, departAt: seg.start })
    : null;
  const isAir = mode === 'plane';

  return (
    <div className="inspector__inner">
      <header className="row row--between">
        <div className="grow" style={{ minWidth: 0 }}>
          <p className="eyebrow">{iconFor(seg)} {KIND_LABEL[seg.kind]}</p>
          <h2 style={{ fontSize: 'var(--step-1)' }} className="truncate">{seg.title}</h2>
        </div>
        <button className="btn btn--icon btn--ghost" onClick={onClose} aria-label="Close details"><IconClose /></button>
      </header>

      {related.length > 0 && (
        <ul className="issues" aria-label="Problems with this block">
          {related.map((i) => (
            <li key={i.id} className="issue" data-sev={i.severity}>
              <span className="issue__dot" aria-hidden="true" />
              <span>
                <span className="issue__title">{i.title}</span>
                <br />
                <span className="issue__detail">{i.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="field">
        <label htmlFor="i-title">Title</label>
        <input id="i-title" className="input" value={seg.title}
          onChange={(e) => onPatch(seg.id, { title: e.target.value }, 'Renamed block')} />
      </div>

      <div className="row" style={{ gap: 'var(--s-3)', alignItems: 'flex-start' }}>
        <div className="field grow">
          <label htmlFor="i-kind">Type</label>
          <select id="i-kind" className="input" value={seg.kind}
            onChange={(e) => onPatch(seg.id, { kind: e.target.value as SegmentKind }, 'Changed type')}>
            {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </div>
        <div className="field grow">
          <label htmlFor="i-status">Status</label>
          <select id="i-status" className="input" value={seg.status}
            onChange={(e) => onPatch(seg.id, { status: e.target.value as SegmentStatus }, 'Changed status')}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label" style={{ paddingBottom: 'var(--s-1)' }}>
          Times · {zoneCity(zone)} ({zoneAbbr(seg.start, zone)})
        </legend>
        <div className="stack">
          <div className="row">
            <div className="field grow">
              <label htmlFor="i-sd">Start date</label>
              <input id="i-sd" className="input" type="date" value={dateVal(sp)}
                onChange={(e) => setStart(e.target.value, timeVal(sp))} />
            </div>
            <div className="field" style={{ width: '7.5rem' }}>
              <label htmlFor="i-st">Start</label>
              <input id="i-st" className="input" type="time" value={timeVal(sp)}
                onChange={(e) => setStart(dateVal(sp), e.target.value)} />
            </div>
          </div>
          <div className="row">
            <div className="field grow">
              <label htmlFor="i-ed">End date</label>
              <input id="i-ed" className="input" type="date" value={dateVal(ep)}
                onChange={(e) => setEnd(e.target.value, timeVal(ep))} />
            </div>
            <div className="field" style={{ width: '7.5rem' }}>
              <label htmlFor="i-et">End</label>
              <input id="i-et" className="input" type="time" value={timeVal(ep)}
                onChange={(e) => setEnd(dateVal(ep), e.target.value)} />
            </div>
          </div>
          <p style={{ fontSize: 'var(--step--2)', color: 'var(--ink-3)' }}>
            {fmtDuration(seg.end - seg.start)}
            {clock.type !== 'event' && (
              <> · shown elsewhere as <span className="mono">{fmtTime(seg.start, { zone: trip.baseTimezone })}</span> trip time</>
            )}
          </p>
        </div>
      </fieldset>

      <div className="field">
        <label htmlFor="i-tz">Happens in time zone</label>
        <select id="i-tz" className="input" value={seg.timezone}
          onChange={(e) => onPatch(seg.id, { timezone: e.target.value }, 'Changed time zone')}>
          {[...new Set([trip.baseTimezone, ...trip.places.map((p) => p.timezone), ...trip.people.map((p) => p.homeTimezone)])]
            .sort()
            .map((z) => <option key={z} value={z}>{z} ({zoneAbbr(seg.start, z)})</option>)}
        </select>
      </div>

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="field grow">
          <label htmlFor="i-from">From</label>
          <select id="i-from" className="input" value={seg.fromPlaceId ?? ''}
            onChange={(e) => onPatch(seg.id, { fromPlaceId: e.target.value || undefined }, 'Changed origin')}>
            <option value="">—</option>
            {trip.places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="field grow">
          <label htmlFor="i-to">{seg.fromPlaceId ? 'To' : 'Place'}</label>
          <select id="i-to" className="input" value={(seg.fromPlaceId ? seg.toPlaceId : seg.placeId) ?? ''}
            onChange={(e) => {
              const v = e.target.value || undefined;
              onPatch(seg.id, seg.fromPlaceId ? { toPlaceId: v } : { placeId: v }, 'Changed place');
            }}>
            <option value="">—</option>
            {trip.places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      {est && isAir && (
        <div className="panel" style={{ padding: 'var(--s-3)', display: 'grid', gap: 4 }}>
          <p className="eyebrow">Flight</p>
          <p className="mono" style={{ fontSize: 'var(--step--1)' }}>
            {Math.round(est.distanceKm).toLocaleString()} km great circle · {fmtDuration(seg.end - seg.start)} block time
          </p>
          <p style={{ fontSize: 'var(--step--2)', color: 'var(--ink-2)' }}>
            Averaging {Math.round(est.distanceKm / ((seg.end - seg.start) / 3_600_000))} km/h including taxi and climb.
            Schedules are what the airline says they are — nothing here adjusts them.
          </p>
        </div>
      )}

      {est && !isAir && (
        <div className="panel" style={{ padding: 'var(--s-3)', display: 'grid', gap: 4 }}>
          <p className="eyebrow">Modelled journey</p>
          <p className="mono" style={{ fontSize: 'var(--step--1)' }}>
            {est.distanceKm} km · {travelMinutes(est)} min moving
            {' + '}{overheadMinutes(mode, fromPlace?.kind, toPlace?.kind)} min overhead
          </p>
          <p style={{ fontSize: 'var(--step--2)', color: 'var(--ink-2)' }}>
            {trafficLabel(est.trafficFactor).text} at {fmtTime(seg.start, { zone })} (×{est.trafficFactor} on free-flow).
            Estimated offline; the map upgrades this to a real road route when it can reach the router.
          </p>
          <button className="btn btn--sm" type="button"
            onClick={() => {
              const need = travelMinutes(est) + overheadMinutes(mode, fromPlace?.kind, toPlace?.kind);
              onPatch(seg.id, { end: seg.start + need * MIN }, 'Fitted to travel time');
            }}>
            Fit block to the modelled time
          </button>
        </div>
      )}

      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label" style={{ paddingBottom: 'var(--s-2)' }}>Who is on this</legend>
        <label className="row" style={{ marginBottom: 'var(--s-2)' }}>
          <input type="checkbox" checked={!!seg.everyone}
            onChange={(e) => onPatch(seg.id, { everyone: e.target.checked || undefined }, 'Changed attendees')} />
          <span>Everyone on the trip</span>
        </label>
        <ul style={{ display: 'grid', gap: 2 }}>
          {trip.people.map((p) => {
            const on = attendees.includes(p.id);
            return (
              <li key={p.id}>
                <label className="person-row" style={{ ['--c' as string]: p.color, cursor: 'pointer' }}>
                  <input type="checkbox" checked={on} disabled={!!seg.everyone}
                    onChange={(e) => onToggleAttendee(seg.id, p.id, e.target.checked)} />
                  <span className="avatar avatar--sm" style={{ ['--c' as string]: p.color }} aria-hidden="true">{initials(p.name)}</span>
                  <span className="grow">
                    <span className="person-row__name">{p.name}</span><span className="person-row__meta">{zoneCity(p.homeTimezone)}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div className="field">
        <label htmlFor="i-notes">Notes</label>
        <textarea id="i-notes" className="input" value={seg.notes ?? ''} rows={3}
          onChange={(e) => onPatch(seg.id, { notes: e.target.value || undefined }, 'Edited notes')} />
      </div>

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="field grow">
          <label htmlFor="i-tags">Tags (comma separated)</label>
          <input id="i-tags" className="input" value={seg.tags.join(', ')}
            onChange={(e) => onPatch(seg.id, { tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) }, 'Edited tags')} />
        </div>
        <div className="field" style={{ width: '8rem' }}>
          <label htmlFor="i-cost">Cost ({trip.currency})</label>
          <input id="i-cost" className="input" type="number" inputMode="decimal" value={seg.cost ?? ''}
            onChange={(e) => onPatch(seg.id, { cost: e.target.value ? Number(e.target.value) : undefined }, 'Edited cost')} />
        </div>
      </div>

      <div className="field">
        <label htmlFor="i-url">Link</label>
        <input id="i-url" className="input" type="url" placeholder="https://" value={seg.url ?? ''}
          onChange={(e) => onPatch(seg.id, { url: e.target.value || undefined }, 'Edited link')} />
      </div>

      <hr className="divider" />

      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button type="button" className="btn btn--sm" aria-pressed={!!seg.locked}
          onClick={() => onPatch(seg.id, { locked: !seg.locked }, seg.locked ? 'Unlocked' : 'Locked')}>
          <IconLock size={14} /> {seg.locked ? 'Locked' : 'Lock'}
        </button>
        <button type="button" className="btn btn--sm" onClick={() => onDuplicate(seg.id)}>
          <IconCopy size={14} /> Duplicate
        </button>
        <a className="btn btn--sm" href={googleCalendarUrl(seg, trip)} target="_blank" rel="noreferrer noopener">
          <IconLink size={14} /> Google
        </a>
        <a className="btn btn--sm" href={outlookUrl(seg, trip)} target="_blank" rel="noreferrer noopener">
          <IconLink size={14} /> Outlook
        </a>
        <button type="button" className="btn btn--sm btn--danger" style={{ marginLeft: 'auto' }}
          onClick={() => { onDelete(seg.id); onClose(); }}>
          <IconTrash size={14} /> Delete
        </button>
      </div>

      {related.some((i) => i.segmentIds.length > 1) && (
        <div className="stack">
          <p className="eyebrow">Linked blocks</p>
          {related.flatMap((i) => i.segmentIds).filter((id) => id !== seg.id)
            .filter((v, idx, arr) => arr.indexOf(v) === idx)
            .map((id) => {
              const other = trip.segments.find((s) => s.id === id);
              return other ? (
                <button key={id} type="button" className="btn btn--sm" onClick={() => onSelect(id)}>
                  {iconFor(other)} {other.title}
                </button>
              ) : null;
            })}
        </div>
      )}
    </div>
  );
}

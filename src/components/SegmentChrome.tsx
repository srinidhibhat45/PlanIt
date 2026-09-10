/** The inside of a scheduled block — shared by the timeline and day grid.
 *
 *  Two layouts, because the two grids give a block very different shapes:
 *
 *   - `bar`   (timeline) — a wide, short box. Everything sits on ONE line, so
 *              the text can never be taller than the box. Detail drops off the
 *              right-hand end as the block narrows: time first, then the place,
 *              then the title, leaving the icon alone in a sliver.
 *   - `block` (day grid) — a narrow, tall box. Lines stack, but only as many as
 *              the caller says will fit.
 *
 *  The rule both layouts obey: never render a line that has no room. Text that
 *  overflows a fixed-height box does not clip politely — it paints on top of
 *  the line below it and outside the block's own border. */

import type { ClockMode, Segment, Trip } from '../core/types';
import { fmtRange, fmtTime, fmtDuration, zoneCity } from '../core/time';
import { iconFor } from '../core/ics';
import { attendeesOf } from '../core/schedule';
import { KIND_LABEL } from '../core/layout';
import { resolveZone } from '../core/clock';

export type SegLayout = 'bar' | 'block';

export function SegmentChrome({
  seg, trip, clock, layout = 'block', lines = 2, showTime = true, showPlace = true,
  showWho = false, conflicted,
}: {
  seg: Segment;
  trip: Trip;
  clock: ClockMode;
  layout?: SegLayout;
  /** How many text lines the box can hold. 0 means icon only. */
  lines?: number;
  showTime?: boolean;
  showPlace?: boolean;
  showWho?: boolean;
  conflicted?: boolean;
}) {
  const zone = resolveZone(clock, seg, trip);
  const place = trip.places.find((p) => p.id === (seg.placeId ?? seg.toPlaceId));
  const people = attendeesOf(seg, trip);
  const icon = iconFor(seg);
  const badges = (seg.locked || conflicted) && (
    <span className="seg__badges">
      {conflicted && <span className="seg__warn" aria-hidden="true">▲</span>}
      {seg.locked && <span className="seg__lock" aria-hidden="true">🔒</span>}
    </span>
  );

  /* A sliver too narrow for a word still has to say *something*. The icon and
     the colour bar carry it, and the accessible name carries the rest. */
  if (lines <= 0) {
    return <span className="seg__icon seg__icon--solo" aria-hidden="true">{icon}</span>;
  }

  if (layout === 'bar') {
    return (
      <span className="seg__line">
        {/* Start time leads, the way it does in the agenda and the trip grid.
            A timeline block already draws its duration as width, so repeating
            the full range here only competes with the title for room. */}
        {showTime && <time className="seg__time mono">{fmtTime(seg.start, { zone })}</time>}
        <span className="seg__icon" aria-hidden="true">{icon}</span>
        <span className="seg__title">{seg.title}</span>
        {showPlace && place && <span className="seg__where">· {place.name}</span>}
        {badges}
      </span>
    );
  }

  return (
    <>
      <span className="seg__line">
        <span className="seg__icon" aria-hidden="true">{icon}</span>
        <span className="seg__title">{seg.title}</span>
        {badges}
      </span>
      {lines > 1 && showTime && (
        <span className="seg__meta">
          <time className="mono">{fmtRange(seg.start, seg.end, { zone })}</time>
          {showPlace && place && <span className="seg__where">· {place.name}</span>}
        </span>
      )}
      {showWho && people.length > 0 && lines > 2 && (
        <span className="avatar-stack" aria-hidden="true">
          {people.slice(0, 5).map((id) => {
            const p = trip.people.find((x) => x.id === id);
            if (!p) return null;
            return (
              <span key={id} className="avatar avatar--sm" style={{ ['--c' as string]: p.color }}>
                {initials(p.name)}
              </span>
            );
          })}
          {people.length > 5 && <span className="avatar avatar--sm" style={{ ['--c' as string]: 'var(--ink-3)' }}>+{people.length - 5}</span>}
        </span>
      )}
    </>
  );
}

export function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

/** The full sentence a screen reader hears for a block. */
export function describeSegment(seg: Segment, trip: Trip, clock: ClockMode): string {
  const zone = resolveZone(clock, seg, trip);
  const place = trip.places.find((p) => p.id === (seg.placeId ?? seg.toPlaceId));
  const from = trip.places.find((p) => p.id === seg.fromPlaceId);
  const people = attendeesOf(seg, trip)
    .map((id) => trip.people.find((p) => p.id === id)?.name)
    .filter(Boolean);

  const parts = [
    `${KIND_LABEL[seg.kind] ?? seg.kind}: ${seg.title}`,
    `${fmtRange(seg.start, seg.end, { zone })} ${zoneCity(zone)} time`,
    `lasting ${fmtDuration(seg.end - seg.start)}`,
  ];
  if (from && place) parts.push(`from ${from.name} to ${place.name}`);
  else if (place) parts.push(`at ${place.name}`);
  if (seg.everyone) parts.push('everyone attending');
  else if (people.length) parts.push(`with ${people.length === 1 ? people[0] : `${people.length} people: ${people.join(', ')}`}`);
  else parts.push('nobody assigned');
  if (seg.status !== 'confirmed') parts.push(seg.status);
  if (seg.locked) parts.push('locked');
  return parts.join(', ') + '.';
}

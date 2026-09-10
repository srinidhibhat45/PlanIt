/** Which zone the UI should render a given segment in. */

import type { ClockMode, Segment, Trip, Zone } from './types';
import { deviceZone } from './time';

export function resolveZone(clock: ClockMode, seg: Segment | null, trip: Trip): Zone {
  switch (clock.type) {
    case 'event': return seg?.timezone ?? trip.baseTimezone;
    case 'base': return trip.baseTimezone;
    case 'device': return deviceZone();
    case 'person': return trip.people.find((p) => p.id === clock.personId)?.homeTimezone ?? trip.baseTimezone;
  }
}

/** The zone the axis itself is drawn in — always a single zone. */
export function axisZone(clock: ClockMode, trip: Trip): Zone {
  return clock.type === 'event' ? trip.baseTimezone : resolveZone(clock, null, trip);
}

export function clockLabel(clock: ClockMode, trip: Trip): string {
  switch (clock.type) {
    case 'event': return 'Local to each item';
    case 'base': return `Trip time · ${trip.baseTimezone.split('/').pop()?.replace(/_/g, ' ')}`;
    case 'device': return `My device · ${deviceZone().split('/').pop()?.replace(/_/g, ' ')}`;
    case 'person': {
      const p = trip.people.find((x) => x.id === clock.personId);
      return p ? `${p.name.split(' ')[0]}’s clock` : 'Person clock';
    }
  }
}

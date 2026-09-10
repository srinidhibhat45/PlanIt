/** PlanIt domain model.
 *  Canonical rule: every instant is stored as UTC epoch milliseconds.
 *  A `timezone` on an entity says how that instant should be *rendered* by default.
 *  Nothing in the app ever stores a naive local time. */

export type ID = string;
export type Epoch = number;          // UTC milliseconds
export type IsoDate = string;        // 'YYYY-MM-DD'
export type Zone = string;           // IANA, e.g. 'Asia/Kolkata'

export type PlaceKind =
  | 'airport' | 'hotel' | 'venue' | 'restaurant' | 'bar'
  | 'temple' | 'landmark' | 'transit' | 'office' | 'other';

export interface Place {
  id: ID;
  name: string;
  kind: PlaceKind;
  lat: number;
  lon: number;
  timezone: Zone;
  address?: string;
  /** IATA code for airports. */
  code?: string;
  url?: string;
  notes?: string;
  /** Typical dwell time in minutes — used by the gap analyser. */
  dwellMin?: number;
}

export type SegmentKind =
  | 'flight' | 'transfer' | 'checkin' | 'checkout'
  | 'session' | 'workshop' | 'meal' | 'activity'
  | 'free' | 'rest' | 'buffer' | 'note';

export type SegmentStatus = 'confirmed' | 'tentative' | 'cancelled';

export type TravelMode = 'car' | 'taxi' | 'transit' | 'walk' | 'plane' | 'train' | 'ferry';

export interface TravelDetail {
  mode: TravelMode;
  distanceKm: number;
  /** Free-flow driving minutes before traffic is applied. */
  baseMin: number;
  /** Multiplier applied for time-of-day congestion (1.0 = free flow). */
  trafficFactor: number;
  /** Encoded route geometry, [lat, lon][] — filled by the routing adapter. */
  geometry?: [number, number][];
  /** Where the estimate came from. */
  source: 'estimate' | 'osrm' | 'manual';
}

export interface FlightDetail {
  carrier: string;
  number: string;
  fromCode: string;
  toCode: string;
  terminal?: string;
  seat?: string;
  confirmation?: string;
}

export interface Segment {
  id: ID;
  title: string;
  kind: SegmentKind;
  start: Epoch;
  end: Epoch;
  /** Zone the segment physically happens in. */
  timezone: Zone;
  placeId?: ID;
  fromPlaceId?: ID;
  toPlaceId?: ID;
  /** Explicit attendee list. Empty array = nobody; use `everyone` for whole-trip items. */
  attendeeIds: ID[];
  everyone?: boolean;
  groupIds: ID[];
  status: SegmentStatus;
  travel?: TravelDetail;
  flight?: FlightDetail;
  notes?: string;
  url?: string;
  tags: string[];
  cost?: number;
  currency?: string;
  /** Locked segments are never moved by auto-arrange and warn on drag. */
  locked?: boolean;
  /** Overrides the kind's palette colour. */
  color?: string;
}

export interface Person {
  id: ID;
  name: string;
  email?: string;
  homeCity: string;
  homeTimezone: Zone;
  color: string;
  groupIds: ID[];
  interests: string[];
  dietary?: string;
  mobilityNotes?: string;
  phone?: string;
  notes?: string;
}

export type GroupKind = 'track' | 'hotel' | 'affinity' | 'custom';

export interface Group {
  id: ID;
  name: string;
  kind: GroupKind;
  color: string;
  memberIds: ID[];
  /** For hotel groups, the place they are staying at. */
  placeId?: ID;
  description?: string;
}

/** An unscheduled idea sitting in the backlog, waiting to be dragged onto a day. */
export interface Idea {
  id: ID;
  title: string;
  kind: SegmentKind;
  durationMin: number;
  placeId?: ID;
  attendeeIds: ID[];
  tags: string[];
  notes?: string;
  votes: ID[];
}

export interface Trip {
  id: ID;
  name: string;
  subtitle?: string;
  startDate: IsoDate;
  endDate: IsoDate;
  /** The zone the trip "lives" in — the default rendering zone. */
  baseTimezone: Zone;
  currency: string;
  places: Place[];
  people: Person[];
  groups: Group[];
  segments: Segment[];
  ideas: Idea[];
  updatedAt: Epoch;
  schemaVersion: 1;
}

/* ---------- View state ---------- */

export type ViewId = 'timeline' | 'day' | 'week' | 'agenda' | 'map' | 'people' | 'board';

export type LaneMode = 'person' | 'group' | 'place' | 'kind' | 'unified';

/** Which clock the UI renders in. */
export type ClockMode =
  | { type: 'event' }               // each segment in its own local zone
  | { type: 'base' }                // the trip's base zone
  | { type: 'device' }              // the viewer's device zone
  | { type: 'person'; personId: ID }; // walk in one person's shoes

export interface Filters {
  personIds: ID[];
  groupIds: ID[];
  kinds: SegmentKind[];
  tags: string[];
  query: string;
  hideCancelled: boolean;
}

export type Density = 'comfortable' | 'compact';
export type ThemeMode = 'dark' | 'light' | 'system';

export interface Issue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  segmentIds: ID[];
  personIds: ID[];
  /** Machine-readable so the UI can offer a one-click fix. */
  code:
    | 'overlap' | 'travel-gap' | 'no-transfer' | 'orphan-evening'
    | 'before-arrival' | 'after-departure' | 'no-attendees'
    | 'unreachable' | 'tight-connection' | 'no-meal' | 'late-night';
}

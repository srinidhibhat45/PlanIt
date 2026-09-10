/** PlanIt domain model.
 *  Canonical rule: every instant is stored as UTC epoch milliseconds.
 *  A `timezone` on an entity says how that instant should be *rendered* by default.
 *  Nothing in the app ever stores a naive local time. */

export type ID = string;

/** Board coordinates. The board is unbounded, so these are signed and have no
 *  units beyond "one unit is one pixel at 100% zoom". */
export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
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
  /** Sub-trip this belongs to. Undefined = the main timeline everyone shares. */
  branchId?: ID;
  /** Where the card sits on the board. Absent until the board first lays it out. */
  at?: Point;
  /** A pinned card keeps the time it has; the resolver schedules around it.
   *  Everything else takes its time from the links running into it. */
  pinned?: boolean;
  /** The person whose personal itinerary this came from. Undefined = trip-level,
   *  authored by whoever is planning. Used to decide who may edit it. */
  ownerId?: ID;
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
  /** When this person is available to the trip, independent of any booked
   *  flight. Set from the People step; the analyser treats anything outside it
   *  as impossible. */
  windowStart?: Epoch;
  windowEnd?: Epoch;
  /** Where they are travelling from, so the first leg can be modelled before
   *  any flight is entered. */
  homeLat?: number;
  homeLon?: number;
  /** A personal edit link hands this person their own itinerary. */
  handle?: string;
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

/** A connector the planner drew between two cards.
 *
 *  This is the spine of the board: it says *B happens after A*, and it is what
 *  lets a pile of cards arranged by hand resolve into a schedule. The travel
 *  kind additionally says "and getting there takes a journey", which the
 *  resolver costs using the same model the analyser uses. */
export interface Link {
  id: ID;
  fromId: ID;
  toId: ID;
  kind: 'then' | 'travel';
  /** For a travel link, how they are getting there. */
  mode?: TravelMode;
  /** Extra slack the planner wants on top of the modelled journey, in minutes. */
  bufferMin?: number;
  label?: string;
}

/** A loose note on the board. Not scheduled, not on anyone's itinerary — the
 *  equivalent of a sticky on a whiteboard, and just as disposable. */
export interface Sticky {
  id: ID;
  text: string;
  at: Point;
  color: string;
  /** Who wrote it, when the board is being used by more than one person. */
  authorId?: ID;
}

/** A region of the board that means something.
 *
 *  Containment is the interface: drop a card inside a frame and it takes on
 *  what the frame says. A frame with a `dayKey` puts everything in it on that
 *  day; one with a `branchId` puts everything in it on that sub-trip. A frame
 *  with neither is just a labelled area, which is often all you want. */
export interface Frame {
  id: ID;
  title: string;
  rect: Rect;
  color: string;
  dayKey?: IsoDate;
  branchId?: ID;
  collapsed?: boolean;
}

/** A sub-trip: a slice of the plan a subset of people do on their own, which
 *  splits off the shared timeline and rejoins it later. Branches nest — a
 *  branch may have a parent branch — so a side trip can itself fork. */
export interface Branch {
  id: ID;
  name: string;
  color: string;
  /** Who peels off. Segments in the branch default to these attendees. */
  memberIds: ID[];
  /** Nesting. Undefined = forks directly off the main timeline. */
  parentId?: ID;
  notes?: string;
  /** Collapsed branches render as a single spanning bar rather than nodes. */
  collapsed?: boolean;
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
  branches: Branch[];
  links: Link[];
  stickies: Sticky[];
  frames: Frame[];
  ideas: Idea[];
  createdAt?: Epoch;
  updatedAt: Epoch;
  schemaVersion: 1;
}

/* ---------- View state ---------- */

export type ViewId = 'canvas' | 'timeline' | 'day' | 'week' | 'agenda' | 'map' | 'people' | 'board';

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
  /** Empty = every branch plus the main line. */
  branchIds: ID[];
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
    | 'unreachable' | 'tight-connection' | 'no-meal' | 'late-night'
    | 'outside-window' | 'branch-clash' | 'branch-rejoin' | 'branch-orphan'
    | 'needs-flight' | 'link-cycle' | 'link-backwards';
}

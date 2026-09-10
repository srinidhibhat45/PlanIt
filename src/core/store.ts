/** Trip state: a reducer with linear undo/redo, debounced persistence and a
 *  tiny pub/sub so any component can subscribe without a state library. */

import type { ID, Idea, Group, Person, Place, Segment, Trip } from './types';
import { MIN, snap } from './time';

export type Action =
  | { type: 'trip/patch'; patch: Partial<Trip>; label?: string }
  | { type: 'trip/replace'; trip: Trip; label?: string }
  | { type: 'segment/add'; segment: Segment }
  | { type: 'segment/patch'; id: ID; patch: Partial<Segment>; label?: string }
  | { type: 'segment/move'; id: ID; deltaMs: number; snapMin?: number }
  | { type: 'segment/set-time'; id: ID; start: number; end: number }
  | { type: 'segment/resize'; id: ID; edge: 'start' | 'end'; deltaMs: number; snapMin?: number }
  | { type: 'segment/delete'; id: ID }
  | { type: 'segment/duplicate'; id: ID }
  | { type: 'segment/assign'; id: ID; personId: ID; on: boolean }
  | { type: 'person/add'; person: Person }
  | { type: 'person/patch'; id: ID; patch: Partial<Person> }
  | { type: 'person/delete'; id: ID }
  | { type: 'place/add'; place: Place }
  | { type: 'place/patch'; id: ID; patch: Partial<Place> }
  | { type: 'place/delete'; id: ID }
  | { type: 'group/add'; group: Group }
  | { type: 'group/patch'; id: ID; patch: Partial<Group> }
  | { type: 'group/delete'; id: ID }
  | { type: 'idea/add'; idea: Idea }
  | { type: 'idea/patch'; id: ID; patch: Partial<Idea> }
  | { type: 'idea/delete'; id: ID }
  | { type: 'idea/promote'; id: ID; start: number; timezone: string }
  | { type: 'history/undo' }
  | { type: 'history/redo' };

export interface TripState {
  present: Trip;
  past: Trip[];
  future: Trip[];
  /** Human label for the last change, shown in the undo affordance. */
  lastLabel: string | null;
}

const HISTORY_LIMIT = 120;

export function uid(prefix = 'id'): string {
  const r = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}_${r.replace(/-/g, '').slice(0, 12)}`;
}

/** Actions that should not create an undo entry. */
const TRANSIENT = new Set<Action['type']>(['history/undo', 'history/redo']);

export function reducer(state: TripState, action: Action): TripState {
  if (action.type === 'history/undo') {
    const prev = state.past[state.past.length - 1];
    if (!prev) return state;
    return {
      present: prev,
      past: state.past.slice(0, -1),
      future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
      lastLabel: null,
    };
  }
  if (action.type === 'history/redo') {
    const next = state.future[0];
    if (!next) return state;
    return {
      present: next,
      past: [...state.past, state.present].slice(-HISTORY_LIMIT),
      future: state.future.slice(1),
      lastLabel: null,
    };
  }

  const next = applyToTrip(state.present, action);
  if (next === state.present) return state;

  const stamped: Trip = { ...next, updatedAt: Date.now() };
  return {
    present: stamped,
    past: TRANSIENT.has(action.type) ? state.past : [...state.past, state.present].slice(-HISTORY_LIMIT),
    future: [],
    lastLabel: labelFor(action, state.present),
  };
}

function labelFor(a: Action, before: Trip): string {
  const seg = (id: ID) => before.segments.find((s) => s.id === id)?.title ?? 'item';
  switch (a.type) {
    case 'segment/add': return `Added “${a.segment.title}”`;
    case 'segment/delete': return `Deleted “${seg(a.id)}”`;
    case 'segment/move': return `Moved “${seg(a.id)}”`;
    case 'segment/set-time': return `Rescheduled “${seg(a.id)}”`;
    case 'segment/resize': return `Resized “${seg(a.id)}”`;
    case 'segment/duplicate': return `Duplicated “${seg(a.id)}”`;
    case 'segment/patch': return a.label ?? `Edited “${seg(a.id)}”`;
    case 'segment/assign': return `Changed attendees on “${seg(a.id)}”`;
    case 'idea/promote': return 'Scheduled an idea';
    case 'trip/replace': return a.label ?? 'Loaded a trip';
    default: return ('label' in a && a.label) || 'Change';
  }
}

function applyToTrip(trip: Trip, a: Action): Trip {
  const mapSeg = (id: ID, fn: (s: Segment) => Segment): Trip => ({
    ...trip,
    segments: trip.segments.map((s) => (s.id === id ? fn(s) : s)),
  });

  switch (a.type) {
    case 'trip/patch': return { ...trip, ...a.patch };
    case 'trip/replace': return a.trip;

    case 'segment/add':
      return { ...trip, segments: [...trip.segments, a.segment] };

    case 'segment/patch':
      return mapSeg(a.id, (s) => ({ ...s, ...a.patch }));

    case 'segment/move':
      return mapSeg(a.id, (s) => {
        // snapMin of 0 means "exactly this delta" — used by keyboard nudges,
        // which have already chosen a round number and must not be re-rounded.
        const step = a.snapMin ?? 5;
        const start = step > 0 ? snap(s.start + a.deltaMs, step, s.timezone) : s.start + a.deltaMs;
        return { ...s, start, end: start + (s.end - s.start) };
      });

    case 'segment/set-time':
      return mapSeg(a.id, (s) => ({ ...s, start: a.start, end: Math.max(a.start + 5 * MIN, a.end) }));

    case 'segment/resize':
      return mapSeg(a.id, (s) => {
        const step = a.snapMin ?? 5;
        const at = (base: number) => (step > 0 ? snap(base + a.deltaMs, step, s.timezone) : base + a.deltaMs);
        if (a.edge === 'start') return { ...s, start: Math.min(at(s.start), s.end - 5 * MIN) };
        return { ...s, end: Math.max(at(s.end), s.start + 5 * MIN) };
      });

    case 'segment/delete':
      return { ...trip, segments: trip.segments.filter((s) => s.id !== a.id) };

    case 'segment/duplicate': {
      const src = trip.segments.find((s) => s.id === a.id);
      if (!src) return trip;
      const copy: Segment = { ...src, id: uid('seg'), title: `${src.title} (copy)` };
      return { ...trip, segments: [...trip.segments, copy] };
    }

    case 'segment/assign':
      return mapSeg(a.id, (s) => {
        const has = s.attendeeIds.includes(a.personId);
        if (a.on === has && !s.everyone) return s;
        const attendeeIds = a.on
          ? [...new Set([...s.attendeeIds, a.personId])]
          : s.attendeeIds.filter((p) => p !== a.personId);
        // turning someone off an `everyone` segment materialises the list first
        if (s.everyone && !a.on) {
          return { ...s, everyone: false, attendeeIds: trip.people.map((p) => p.id).filter((p) => p !== a.personId) };
        }
        return { ...s, attendeeIds };
      });

    case 'person/add': return { ...trip, people: [...trip.people, a.person] };
    case 'person/patch':
      return { ...trip, people: trip.people.map((p) => (p.id === a.id ? { ...p, ...a.patch } : p)) };
    case 'person/delete':
      return {
        ...trip,
        people: trip.people.filter((p) => p.id !== a.id),
        groups: trip.groups.map((g) => ({ ...g, memberIds: g.memberIds.filter((m) => m !== a.id) })),
        segments: trip.segments.map((s) => ({ ...s, attendeeIds: s.attendeeIds.filter((x) => x !== a.id) })),
      };

    case 'place/add': return { ...trip, places: [...trip.places, a.place] };
    case 'place/patch':
      return { ...trip, places: trip.places.map((p) => (p.id === a.id ? { ...p, ...a.patch } : p)) };
    case 'place/delete':
      return {
        ...trip,
        places: trip.places.filter((p) => p.id !== a.id),
        segments: trip.segments.map((s) => ({
          ...s,
          placeId: s.placeId === a.id ? undefined : s.placeId,
          fromPlaceId: s.fromPlaceId === a.id ? undefined : s.fromPlaceId,
          toPlaceId: s.toPlaceId === a.id ? undefined : s.toPlaceId,
        })),
      };

    case 'group/add': return { ...trip, groups: [...trip.groups, a.group] };
    case 'group/patch':
      return { ...trip, groups: trip.groups.map((g) => (g.id === a.id ? { ...g, ...a.patch } : g)) };
    case 'group/delete':
      return {
        ...trip,
        groups: trip.groups.filter((g) => g.id !== a.id),
        people: trip.people.map((p) => ({ ...p, groupIds: p.groupIds.filter((x) => x !== a.id) })),
        segments: trip.segments.map((s) => ({ ...s, groupIds: s.groupIds.filter((x) => x !== a.id) })),
      };

    case 'idea/add': return { ...trip, ideas: [...trip.ideas, a.idea] };
    case 'idea/patch':
      return { ...trip, ideas: trip.ideas.map((i) => (i.id === a.id ? { ...i, ...a.patch } : i)) };
    case 'idea/delete':
      return { ...trip, ideas: trip.ideas.filter((i) => i.id !== a.id) };

    case 'idea/promote': {
      const idea = trip.ideas.find((i) => i.id === a.id);
      if (!idea) return trip;
      const seg: Segment = {
        id: uid('seg'),
        title: idea.title,
        kind: idea.kind,
        start: a.start,
        end: a.start + idea.durationMin * MIN,
        timezone: a.timezone,
        placeId: idea.placeId,
        attendeeIds: idea.attendeeIds.length ? idea.attendeeIds : idea.votes,
        groupIds: [],
        status: 'tentative',
        notes: idea.notes,
        tags: idea.tags,
      };
      return { ...trip, segments: [...trip.segments, seg], ideas: trip.ideas.filter((i) => i.id !== a.id) };
    }

    default: return trip;
  }
}

export function initialState(trip: Trip): TripState {
  return { present: trip, past: [], future: [], lastLabel: null };
}

/* ---------- persistence ---------- */

const KEY = 'planit.trip.v1';

export function saveTrip(trip: Trip) {
  try { localStorage.setItem(KEY, JSON.stringify(trip)); } catch { /* quota or private mode */ }
}

export function loadTrip(): Trip | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as Trip;
    return t?.schemaVersion === 1 && Array.isArray(t.segments) ? t : null;
  } catch { return null; }
}

export function clearSaved() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

const PREFS = 'planit.prefs.v1';

export function savePrefs(p: unknown) {
  try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* ignore */ }
}

export function loadPrefs<T>(fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFS);
    return raw ? { ...fallback, ...(JSON.parse(raw) as object) } : fallback;
  } catch { return fallback; }
}

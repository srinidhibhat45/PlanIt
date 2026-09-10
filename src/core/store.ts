/** Trip state: a reducer with linear undo/redo, debounced persistence and a
 *  tiny pub/sub so any component can subscribe without a state library. */

import type { Branch, Frame, ID, Idea, Group, Link, Person, Place, Point, Segment, Sticky, Trip } from './types';
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
  | { type: 'branch/add'; branch: Branch; segmentIds?: ID[] }
  | { type: 'branch/patch'; id: ID; patch: Partial<Branch> }
  /** `keep` moves the branch's segments up to its parent; otherwise they are
   *  deleted along with it. */
  | { type: 'branch/delete'; id: ID; keep: boolean }
  | { type: 'branch/set-members'; id: ID; memberIds: ID[]; syncSegments: boolean }
  | { type: 'segment/set-branch'; ids: ID[]; branchId?: ID }
  | { type: 'segments/add'; segments: Segment[]; places?: Place[]; label?: string }
  /* ---- the board ---- */
  | { type: 'board/nudge'; ids: ID[]; dx: number; dy: number }
  | { type: 'board/place'; positions: [ID, Point][]; label?: string }
  | { type: 'board/layout'; positions: [ID, Point][]; frames: Frame[] }
  | { type: 'board/apply-times'; times: { id: ID; start: number }[] }
  | { type: 'segment/pin'; ids: ID[]; pinned: boolean }
  | { type: 'link/add'; link: Link }
  | { type: 'link/patch'; id: ID; patch: Partial<Link> }
  | { type: 'link/delete'; ids: ID[] }
  | { type: 'sticky/add'; sticky: Sticky }
  | { type: 'sticky/patch'; id: ID; patch: Partial<Sticky> }
  | { type: 'sticky/delete'; id: ID }
  | { type: 'frame/add'; frame: Frame }
  | { type: 'frame/patch'; id: ID; patch: Partial<Frame> }
  | { type: 'frame/delete'; id: ID }
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
    case 'branch/add': return `Created the sub-trip “${a.branch.name}”`;
    case 'branch/delete': return a.keep ? 'Dissolved a sub-trip' : 'Deleted a sub-trip';
    case 'branch/patch': return 'Edited a sub-trip';
    case 'branch/set-members': return 'Changed who is on a sub-trip';
    case 'segment/set-branch':
      return a.branchId ? 'Moved into a sub-trip' : 'Moved back to the main timeline';
    case 'segments/add': return a.label ?? `Added ${a.segments.length} blocks`;
    case 'board/nudge': return a.ids.length === 1 ? `Moved “${seg(a.ids[0])}”` : `Moved ${a.ids.length} cards`;
    case 'board/place': return a.label ?? 'Moved cards on the board';
    case 'board/layout': return 'Tidied the board';
    case 'board/apply-times': return `Scheduled ${a.times.length} ${a.times.length === 1 ? 'card' : 'cards'}`;
    case 'segment/pin': return a.pinned ? 'Pinned the time' : 'Unpinned the time';
    case 'link/add': return 'Connected two cards';
    case 'link/delete': return a.ids.length === 1 ? 'Removed a connector' : `Removed ${a.ids.length} connectors`;
    case 'link/patch': return 'Edited a connector';
    case 'sticky/add': return 'Added a note';
    case 'sticky/patch': return 'Edited a note';
    case 'sticky/delete': return 'Deleted a note';
    case 'frame/add': return `Added the frame “${a.frame.title}”`;
    case 'frame/patch': return 'Edited a frame';
    case 'frame/delete': return 'Removed a frame';
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
      return {
        ...trip,
        segments: trip.segments.filter((s) => s.id !== a.id),
        links: trip.links.filter((l) => l.fromId !== a.id && l.toId !== a.id),
      };

    case 'segment/duplicate': {
      const src = trip.segments.find((s) => s.id === a.id);
      if (!src) return trip;
      const copy: Segment = {
        ...src, id: uid('seg'), title: `${src.title} (copy)`,
        at: src.at ? { x: src.at.x + 28, y: src.at.y + 28 } : undefined,
      };
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
        branches: trip.branches.map((b) => ({ ...b, memberIds: b.memberIds.filter((m) => m !== a.id) })),
        segments: trip.segments.map((s) => ({
          ...s,
          attendeeIds: s.attendeeIds.filter((x) => x !== a.id),
          ownerId: s.ownerId === a.id ? undefined : s.ownerId,
        })),
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

    case 'branch/add': {
      const ids = new Set(a.segmentIds ?? []);
      return {
        ...trip,
        branches: [...trip.branches, a.branch],
        segments: ids.size
          ? trip.segments.map((s) => (ids.has(s.id) ? { ...s, branchId: a.branch.id } : s))
          : trip.segments,
      };
    }

    case 'branch/patch':
      return { ...trip, branches: trip.branches.map((b) => (b.id === a.id ? { ...b, ...a.patch } : b)) };

    case 'branch/delete': {
      const doomed = trip.branches.find((b) => b.id === a.id);
      if (!doomed) return trip;
      // Children are re-parented rather than orphaned, so a nested side trip
      // survives its parent being dissolved.
      const branches = trip.branches
        .filter((b) => b.id !== a.id)
        .map((b) => (b.parentId === a.id ? { ...b, parentId: doomed.parentId } : b));
      const dropped = a.keep ? [] : trip.segments.filter((s) => s.branchId === a.id).map((s) => s.id);
      return {
        ...trip,
        branches,
        frames: trip.frames.filter((f) => f.branchId !== a.id),
        segments: a.keep
          ? trip.segments.map((s) => (s.branchId === a.id ? { ...s, branchId: doomed.parentId } : s))
          : trip.segments.filter((s) => s.branchId !== a.id),
        links: trip.links.filter((l) => !dropped.includes(l.fromId) && !dropped.includes(l.toId)),
      };
    }

    case 'branch/set-members': {
      const branch = trip.branches.find((b) => b.id === a.id);
      if (!branch) return trip;
      const next = { ...trip, branches: trip.branches.map((b) => (b.id === a.id ? { ...b, memberIds: a.memberIds } : b)) };
      if (!a.syncSegments) return next;
      // Membership is the intent; pushing it onto the branch's own segments is
      // what makes adding someone to a side trip actually put them on it.
      return {
        ...next,
        segments: next.segments.map((s) =>
          s.branchId === a.id ? { ...s, everyone: false, attendeeIds: a.memberIds } : s),
      };
    }

    case 'segment/set-branch': {
      const ids = new Set(a.ids);
      return { ...trip, segments: trip.segments.map((s) => (ids.has(s.id) ? { ...s, branchId: a.branchId } : s)) };
    }

    case 'segments/add':
      return {
        ...trip,
        places: a.places?.length ? [...trip.places, ...a.places] : trip.places,
        segments: [...trip.segments, ...a.segments],
      };

    case 'board/nudge': {
      const ids = new Set(a.ids);
      return {
        ...trip,
        segments: trip.segments.map((s) =>
          ids.has(s.id) ? { ...s, at: { x: (s.at?.x ?? 0) + a.dx, y: (s.at?.y ?? 0) + a.dy } } : s),
      };
    }

    case 'board/place': {
      const next = new Map(a.positions);
      return {
        ...trip,
        segments: trip.segments.map((s) => (next.has(s.id) ? { ...s, at: next.get(s.id)! } : s)),
      };
    }

    case 'board/layout': {
      const next = new Map(a.positions);
      // Frames are matched by id so a tidy keeps whatever the planner renamed
      // or recoloured, rather than replacing their work with defaults.
      const kept = trip.frames.filter((f) => !a.frames.some((n) => n.id === f.id));
      return {
        ...trip,
        segments: trip.segments.map((s) => (next.has(s.id) ? { ...s, at: next.get(s.id)! } : s)),
        frames: [...kept, ...a.frames],
      };
    }

    case 'board/apply-times': {
      const next = new Map(a.times.map((t) => [t.id, t.start]));
      return {
        ...trip,
        segments: trip.segments.map((s) => {
          const start = next.get(s.id);
          return start === undefined ? s : { ...s, start, end: start + (s.end - s.start) };
        }),
      };
    }

    case 'segment/pin': {
      const ids = new Set(a.ids);
      return {
        ...trip,
        segments: trip.segments.map((s) => (ids.has(s.id) ? { ...s, pinned: a.pinned || undefined } : s)),
      };
    }

    case 'link/add': {
      // One connector per ordered pair, and never one that simply reverses an
      // existing edge — that is a cycle of length two, and always a mistake.
      const exists = trip.links.some(
        (l) => (l.fromId === a.link.fromId && l.toId === a.link.toId) ||
          (l.fromId === a.link.toId && l.toId === a.link.fromId),
      );
      if (exists || a.link.fromId === a.link.toId) return trip;
      return { ...trip, links: [...trip.links, a.link] };
    }

    case 'link/patch':
      return { ...trip, links: trip.links.map((l) => (l.id === a.id ? { ...l, ...a.patch } : l)) };

    case 'link/delete': {
      const ids = new Set(a.ids);
      return { ...trip, links: trip.links.filter((l) => !ids.has(l.id)) };
    }

    case 'sticky/add': return { ...trip, stickies: [...trip.stickies, a.sticky] };
    case 'sticky/patch':
      return { ...trip, stickies: trip.stickies.map((n) => (n.id === a.id ? { ...n, ...a.patch } : n)) };
    case 'sticky/delete':
      return { ...trip, stickies: trip.stickies.filter((n) => n.id !== a.id) };

    case 'frame/add': return { ...trip, frames: [...trip.frames, a.frame] };
    case 'frame/patch':
      return { ...trip, frames: trip.frames.map((f) => (f.id === a.id ? { ...f, ...a.patch } : f)) };
    case 'frame/delete':
      return { ...trip, frames: trip.frames.filter((f) => f.id !== a.id) };

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

import { Suspense, lazy, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type {
  ClockMode, Density, Filters, Frame, ID, LaneMode, Link, Person, Rect, Segment,
  Sticky, ThemeMode, Trip, ViewId,
} from './core/types';
import { MIN, addDays, dateKey, dateKeyToEpoch, fmtDate } from './core/time';
import { analyse, applyFilters, attendeesOf, issueSummary } from './core/schedule';
import { ZOOMS, KIND_LABEL, openingDay, tripDayKeys } from './core/layout';
import { axisZone } from './core/clock';
import { downloadIcs } from './core/ics';
import { clearShareFromLocation, readShareFromLocation, exportJson } from './core/share';
import { initialState, loadPrefs, reducer, savePrefs, uid } from './core/store';
import { writeTrip } from './core/library';
import { makeBranch } from './core/library';
import { nextBranchColor } from './core/branch';
import { layoutFromSchedule } from './core/board';
import { describeResolution, resolveBoard } from './core/resolve';
import { conferenceTrip } from './data/conference';
import { useAnnouncer, useHotkeys, useIsMobile, useNow, usePersistedState, useToasts } from './hooks/useUi';

import { TopBar, VIEWS } from './components/TopBar';
import { Rail } from './components/Rail';
import { Inspector } from './components/Inspector';
import { TimelineView } from './components/TimelineView';
import { DayView } from './components/DayView';
import { WeekView } from './components/WeekView';
import { AgendaView, agendaText } from './components/AgendaView';
// Leaflet and its tiles are only needed on the map, so they load on demand.
const MapView = lazy(() => import('./components/MapView').then((m) => ({ default: m.MapView })));
import { PeopleView } from './components/PeopleView';
import { PersonSheet } from './components/PersonSheet';
import { CanvasView, type BoardHandlers } from './components/CanvasView';
import { BoardView } from './components/BoardView';
import { CommandPalette, type Command } from './components/CommandPalette';
import { ShareDialog } from './components/ShareDialog';
import { KeyboardHelp } from './components/KeyboardHelp';
import { Tour, hasSeenTour, markTourSeen } from './components/Tour';
import { ViewHint } from './components/ViewHint';
import {
  IconClose, IconCopy, IconLeft, IconPlus, IconRight, IconTarget, IconTrash, IconZoomIn, IconZoomOut,
} from './components/Icons';
import { Tip } from './components/Tooltip';

interface Prefs {
  view: ViewId; laneMode: LaneMode; density: Density; theme: ThemeMode;
  zoomIndex: number; hourHeight: number; contrast: 'normal' | 'more';
  /** Bumped when a default changes in a way a saved preference should not
   *  outlive. Only the changed field is reset; the rest is kept. */
  v?: number;
}

/** The timeline is the front door: it is the view that answers "who is doing
 *  what, and when", and every other view is a way of asking that differently. */
const PREFS_VERSION = 2;

const DEFAULT_PREFS: Prefs = {
  view: 'timeline', laneMode: 'person', density: 'comfortable', theme: 'dark',
  zoomIndex: 3, hourHeight: 62, contrast: 'normal', v: PREFS_VERSION,
};

const EMPTY_FILTERS: Filters = {
  personIds: [], groupIds: [], kinds: [], tags: [], query: '', hideCancelled: false, branchIds: [],
};

export default function App({
  tripId, initialTrip, onExit, onSaved, onAdopt,
}: {
  /** Null when the plan came from a share link rather than the library. */
  tripId: ID | null;
  initialTrip: Trip | null;
  onExit: () => void;
  /** Lets the library page refresh its cards after a save. */
  onSaved: () => void;
  /** Take a plan that arrived in a link and give it a home in the library.
   *  Without this a copy made from a share link lives only in the tab, and a
   *  reload throws away everything done to it. */
  onAdopt: (trip: Trip) => void;
}) {
  /* ---------- boot ---------- */
  const boot = useMemo<{ trip: Trip; readOnly: boolean; focus?: ID }>(() => {
    const shared = readShareFromLocation();
    if (shared) return { trip: shared.trip, readOnly: shared.mode === 'view', focus: shared.focus as ID | undefined };
    if (initialTrip) return { trip: initialTrip, readOnly: false };
    return { trip: conferenceTrip(), readOnly: false };
  }, [initialTrip]);

  const [state, dispatch] = useReducer(reducer, boot.trip, initialState);
  const trip = state.present;
  const [readOnly, setReadOnly] = useState(boot.readOnly);

  const [prefs, setPrefs] = useState<Prefs>(() => {
    const saved = loadPrefs(DEFAULT_PREFS);
    // An older build opened on the board. A preference file from it is nudged
    // back to the timeline once, and left alone in every other respect.
    return saved.v === PREFS_VERSION ? saved : { ...saved, view: DEFAULT_PREFS.view, v: PREFS_VERSION };
  });
  const setPref = useCallback(<K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    setPrefs((p) => { const next = { ...p, [k]: v }; savePrefs(next); return next; });
  }, []);

  const [filters, setFiltersState] = useState<Filters>(EMPTY_FILTERS);
  const setFilters = useCallback((f: Partial<Filters>) => setFiltersState((prev) => ({ ...prev, ...f })), []);

  const [clock, setClock] = useState<ClockMode>({ type: 'event' });
  const [selectedId, setSelectedId] = useState<ID | null>(null);
  const [focusPersonId, setFocusPersonId] = useState<ID | null>(boot.focus ?? null);
  // The rail is a persistent column on a desktop and a temporary sheet on a
  // phone, so the two remember their state separately — a phone should never
  // open behind a full-screen panel.
  const [railPinned, setRailPinned] = usePersistedState('planit.rail', true);
  const [railSheet, setRailSheet] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  /** 'new' opens a blank sheet; an id opens that person's. */
  const [personSheet, setPersonSheet] = useState<ID | 'new' | null>(null);
  // The walkthrough opens by itself exactly once, and only for someone who
  // arrived at the app rather than at somebody else's shared link.
  const [tourOpen, setTourOpen] = useState(() => !boot.readOnly && !hasSeenTour());
  const [hintsOn, setHintsOn] = usePersistedState('planit.hints', true);

  const now = useNow();
  const isMobile = useIsMobile();
  const railOpen = isMobile ? railSheet : railPinned;
  const setRailOpen = useCallback(
    (v: boolean | ((p: boolean) => boolean)) => (isMobile ? setRailSheet(v) : setRailPinned(v)),
    [isMobile, setRailSheet, setRailPinned],
  );
  const { toasts, push, dismiss } = useToasts();
  const { message: liveMessage, announce } = useAnnouncer();
  const mainRef = useRef<HTMLDivElement>(null);
  /** Filled in by the board while it is on screen: only it knows where the
   *  middle of the view is, and a card added anywhere else would be invisible. */
  const boardAddRef = useRef<(() => void) | null>(null);

  /* ---------- day cursor ---------- */
  const zone = axisZone(clock, trip);
  // The trip's own dates, widened by anything scheduled outside them — never
  // "this week", which is not where the trip is. See `tripSpan`.
  const tripDays = useMemo(() => tripDayKeys(trip, zone, now), [trip, zone, now]);

  /* The day cursor opens on the trip, not on today — and it is also where the
     Add button puts a new block, so anchoring it to today is how a plan ends
     up with three stray blocks a fortnight before the trip. */
  const [dayKey, setDayKey] = useState<string>(() => '');
  useEffect(() => {
    if (dayKey && tripDays.includes(dayKey)) return;
    setDayKey(openingDay(trip, zone, now));
  }, [trip, tripDays, dayKey, now, zone]);

  useEffect(() => { if (!isMobile) setRailSheet(false); }, [isMobile]);

  /* A share link pasted into the address bar of an already-open tab only
     changes the fragment, so there is no reload to hang the boot logic on. */
  useEffect(() => {
    const onHash = () => {
      const shared = readShareFromLocation();
      if (!shared) return;
      dispatch({ type: 'trip/replace', trip: shared.trip, label: 'Opened a shared plan' });
      setReadOnly(shared.mode === 'view');
      setFocusPersonId((shared.focus as ID | undefined) ?? null);
      setSelectedId(null);
      push(
        shared.mode === 'view' ? 'Opened a shared plan, read only.' : 'Opened a shared plan you can edit.',
        { tone: 'ok' },
      );
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [push]);

  /* ---------- theme ---------- */
  useEffect(() => {
    const root = document.documentElement;
    const resolved = prefs.theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : prefs.theme;
    root.dataset.theme = resolved;
    root.dataset.density = prefs.density;
    root.dataset.contrast = prefs.contrast;
  }, [prefs.theme, prefs.density, prefs.contrast]);

  /* ---------- persistence ----------
     A trip opened from a share link has no home in the library until someone
     asks for one, so it is deliberately not written here.

     A save that fails says so. It used to fail in silence, which is the worst
     of both worlds: the plan looks saved, the tab keeps working, and the loss
     only shows up on a reload hours later. */
  const saveWarned = useRef(false);
  useEffect(() => {
    if (readOnly || !tripId) return;
    const h = window.setTimeout(() => {
      const saved = writeTrip(trip);
      onSaved();
      if (saved === 'ok') { saveWarned.current = false; return; }
      if (saveWarned.current) return;      // once per spell of trouble, not per keystroke
      saveWarned.current = true;
      push(
        saved === 'quota'
          ? 'This browser is out of room, so that change is not saved. Delete a trip you have finished with, or take a JSON backup.'
          : 'This browser will not let the page save anything — a private window, or site data blocked. Take a JSON backup before you close the tab.',
        { tone: 'danger', action: { label: 'Back up', run: () => setShareOpen(true) } },
      );
    }, 400);
    return () => clearTimeout(h);
  }, [trip, readOnly, tripId, onSaved, push]);

  /* ---------- derived ---------- */
  /* The board can be wrong in ways the calendar cannot — a loop of connectors,
     or a pin that contradicts what runs into it — so the resolver's findings
     join the analyser's in the same list. */
  const issues = useMemo(() => [...analyse(trip), ...resolveBoard(trip).issues], [trip]);
  const filtered = useMemo(() => {
    const base = applyFilters(trip, filters);
    return focusPersonId ? base.filter((s) => attendeesOf(s, trip).includes(focusPersonId)) : base;
  }, [trip, filters, focusPersonId]);

  /** Lanes follow the focus: asking for "just Tom" should not leave seven
   *  empty columns behind, nor a lane for everyone who happens to share a
   *  session with him. */
  const laneFilter = useMemo(
    () => (focusPersonId ? [focusPersonId] : filters.personIds),
    [focusPersonId, filters.personIds],
  );

  const selected = useMemo(() => trip.segments.find((s) => s.id === selectedId) ?? null, [trip.segments, selectedId]);

  /* ---------- mutations ---------- */
  const guard = useCallback((fn: () => void) => {
    if (readOnly) { push('This is a read-only link. Make an editable copy to change anything.'); return; }
    fn();
  }, [readOnly, push]);

  const onMove = useCallback((id: ID, deltaMs: number, snapMin: number) =>
    guard(() => dispatch({ type: 'segment/move', id, deltaMs, snapMin })), [guard]);

  const onResize = useCallback((id: ID, edge: 'start' | 'end', deltaMs: number, snapMin: number) =>
    guard(() => dispatch({ type: 'segment/resize', id, edge, deltaMs, snapMin })), [guard]);

  const onShiftDays = useCallback((id: ID, days: number) => guard(() => {
    const seg = trip.segments.find((s) => s.id === id);
    if (!seg) return;
    const start = addDays(seg.start, days, seg.timezone);
    dispatch({ type: 'segment/set-time', id, start, end: start + (seg.end - seg.start) });
  }), [guard, trip.segments]);

  const onReassign = useCallback((id: ID, fromPersonId: string, toPersonId: string) => guard(() => {
    if (fromPersonId === toPersonId) return;
    dispatch({ type: 'segment/assign', id, personId: fromPersonId, on: false });
    dispatch({ type: 'segment/assign', id, personId: toPersonId, on: true });
    const to = trip.people.find((p) => p.id === toPersonId);
    if (to) push(`Reassigned to ${to.name}.`, { action: { label: 'Undo', run: () => { dispatch({ type: 'history/undo' }); dispatch({ type: 'history/undo' }); } } });
  }), [guard, trip.people, push]);

  const addSegment = useCallback((partial: Partial<Segment> = {}) => guard(() => {
    const start = partial.start ?? dateKeyToEpoch(dayKey, zone) + 10 * 60 * MIN;
    const seg: Segment = {
      id: uid('seg'),
      title: partial.title ?? 'New block',
      kind: partial.kind ?? 'activity',
      start,
      end: partial.end ?? start + 90 * MIN,
      timezone: partial.timezone ?? trip.baseTimezone,
      attendeeIds: partial.attendeeIds ?? (focusPersonId ? [focusPersonId] : []),
      groupIds: [],
      status: 'tentative',
      tags: [],
      ...partial,
    };
    dispatch({ type: 'segment/add', segment: seg });
    setSelectedId(seg.id);
    announce(`Added ${seg.title}. Details panel open.`);
  }), [guard, dayKey, zone, trip.baseTimezone, focusPersonId, announce]);

  /** What a lane means when you draw a new block in it.
   *
   *  Both the timeline and the day grid let you draw straight onto a lane, and
   *  the lane is the answer to "whose is this?" — a person lane assigns them, a
   *  group lane assigns the group, a type lane sets the type, a place lane sets
   *  the place. One lane, one meaning, in one place. */
  const draftForLane = useCallback((laneId: string): Partial<Segment> => {
    switch (prefs.laneMode) {
      case 'person': return { attendeeIds: [laneId] };
      case 'group': return { groupIds: [laneId] };
      case 'kind': return { kind: laneId as Segment['kind'] };
      case 'place': return { placeId: laneId, title: trip.places.find((p) => p.id === laneId)?.name };
      default: return {};
    }
  }, [prefs.laneMode, trip.places]);

  /** Add something to a named day — what the whole-trip grid and the agenda
   *  need, since neither of them has an hour to point at. Ten in the morning
   *  is a placeholder you will move; an empty day with no way in is not. */
  const addOnDay = useCallback((key: string) => {
    setDayKey(key);
    addSegment({ start: dateKeyToEpoch(key, zone) + 10 * 60 * MIN });
  }, [addSegment, zone]);

  /** What the app-wide Add button does in the view you are actually in.
   *  Same button, same place, same keystroke — the board just needs to be
   *  asked where to put the card. */
  const addHere = useCallback(() => {
    if (prefs.view === 'canvas' && boardAddRef.current) { boardAddRef.current(); return; }
    addSegment();
  }, [prefs.view, addSegment]);

  /** Add into a named lane or column — the "+" that sits on every lane head.
   *  Drawing on the grid is faster once you know you can; this is how you
   *  find out that you can. */
  const addInLane = useCallback((laneId: string) => {
    addSegment(draftForLane(laneId));
  }, [addSegment, draftForLane]);

  /** Add something for one person, from their card on the people page. */
  const addForPerson = useCallback((personId: ID) => {
    addSegment({ attendeeIds: [personId] });
  }, [addSegment]);

  const duplicateSegment = useCallback((id: ID) => guard(() => {
    dispatch({ type: 'segment/duplicate', id });
    push('Duplicated. The copy starts where the original ends.', {
      action: { label: 'Undo', run: () => dispatch({ type: 'history/undo' }) },
    });
  }), [guard, push]);

  const onPatch = useCallback((id: ID, patch: Partial<Segment>, label?: string) =>
    guard(() => dispatch({ type: 'segment/patch', id, patch, label })), [guard]);

  const onDelete = useCallback((id: ID) => guard(() => {
    const seg = trip.segments.find((s) => s.id === id);
    dispatch({ type: 'segment/delete', id });
    setSelectedId(null);
    push(`Deleted “${seg?.title ?? 'block'}”.`, { action: { label: 'Undo', run: () => dispatch({ type: 'history/undo' }) } });
  }), [guard, trip.segments, push]);

  /* ---------- people ---------- */

  const savePerson = useCallback((person: Person) => guard(() => {
    const exists = trip.people.some((p) => p.id === person.id);
    dispatch(exists
      ? { type: 'person/patch', id: person.id, patch: person }
      : { type: 'person/add', person });
    setPersonSheet(null);
    push(exists ? `Saved ${person.name}.` : `${person.name} added to the trip.`, { tone: 'ok' });
  }), [guard, trip.people, push]);

  const removePerson = useCallback((id: ID) => guard(() => {
    const person = trip.people.find((p) => p.id === id);
    dispatch({ type: 'person/delete', id });
    setPersonSheet(null);
    if (focusPersonId === id) setFocusPersonId(null);
    push(`${person?.name ?? 'They'} removed from the trip.`, {
      action: { label: 'Undo', run: () => dispatch({ type: 'history/undo' }) },
    });
  }), [guard, trip.people, focusPersonId, push]);

  /* ---------- canvas ---------- */

  const boardHandlers = useMemo<BoardHandlers>(() => ({
    onSelect: (id) => setSelectedId(id),

    onMoveCards: (ids, dx, dy) => guard(() => dispatch({ type: 'board/nudge', ids, dx, dy })),

    onCreateCard: (at, draft, place) => guard(() => {
      const start = draft?.start ?? dateKeyToEpoch(dayKey || trip.startDate, zone) + 10 * 60 * MIN;
      const seg: Segment = {
        id: uid('seg'),
        title: draft?.title ?? 'New card',
        kind: draft?.kind ?? 'activity',
        start,
        end: draft?.end ?? start + (place?.dwellMin ?? 90) * MIN,
        timezone: place?.timezone ?? trip.baseTimezone,
        placeId: draft?.placeId ?? place?.id,
        attendeeIds: focusPersonId ? [focusPersonId] : [],
        groupIds: [],
        status: 'tentative',
        tags: [],
        at,
        ...draft,
      };
      const isNewPlace = !!place && !trip.places.some((p) => p.id === place.id);
      dispatch({
        type: 'segments/add',
        segments: [seg],
        places: isNewPlace ? [place] : undefined,
        label: `Added “${seg.title}”`,
      });
      setSelectedId(seg.id);
    }),

    onDeleteCards: (ids) => guard(() => {
      if (!ids.length) return;
      for (const id of ids) dispatch({ type: 'segment/delete', id });
      setSelectedId(null);
      push(`Deleted ${ids.length} ${ids.length === 1 ? 'card' : 'cards'}.`, {
        action: { label: 'Undo', run: () => ids.forEach(() => dispatch({ type: 'history/undo' })) },
      });
    }),

    onPin: (ids, pinned) => guard(() => dispatch({ type: 'segment/pin', ids, pinned })),

    onSetTime: (id, start, end) => guard(() => dispatch({ type: 'segment/set-time', id, start, end })),

    onAssign: (segmentId, personId, on) =>
      guard(() => dispatch({ type: 'segment/assign', id: segmentId, personId, on })),

    onLink: (fromId, toId, kind) => guard(() => {
      const link: Link = { id: uid('lnk'), fromId, toId, kind };
      dispatch({ type: 'link/add', link });
    }),

    onPatchLink: (id, patch) => guard(() => dispatch({ type: 'link/patch', id, patch })),
    onUnlink: (ids) => guard(() => dispatch({ type: 'link/delete', ids })),

    onAddSticky: (sticky: Sticky) => guard(() => dispatch({ type: 'sticky/add', sticky })),
    onPatchSticky: (id, patch) => guard(() => dispatch({ type: 'sticky/patch', id, patch })),
    onDeleteSticky: (id) => guard(() => dispatch({ type: 'sticky/delete', id })),

    onAddFrame: (frame: Frame) => guard(() => dispatch({ type: 'frame/add', frame })),
    onPatchFrame: (id, patch) => guard(() => dispatch({ type: 'frame/patch', id, patch })),
    onDeleteFrame: (id) => guard(() => dispatch({ type: 'frame/delete', id })),

    onCreateBranch: (name, memberIds, segmentIds, rect: Rect) => guard(() => {
      const branch = makeBranch(name, memberIds, nextBranchColor(trip));
      dispatch({ type: 'branch/add', branch, segmentIds });
      dispatch({ type: 'branch/set-members', id: branch.id, memberIds, syncSegments: true });
      // The frame is the sub-trip's presence on the board: drop a card in later
      // and it joins, which is the whole point of doing this spatially.
      dispatch({
        type: 'frame/add',
        frame: { id: uid('frm'), title: branch.name, rect, color: branch.color, branchId: branch.id },
      });
      push(`“${branch.name}” split off with ${memberIds.length} ${memberIds.length === 1 ? 'person' : 'people'}.`, { tone: 'ok' });
    }),

    onDeleteBranch: (id, keep) => guard(() => {
      const branch = trip.branches.find((b) => b.id === id);
      dispatch({ type: 'branch/delete', id, keep });
      push(
        keep
          ? `“${branch?.name ?? 'Sub-trip'}” dissolved — its cards stay on the board.`
          : `“${branch?.name ?? 'Sub-trip'}” deleted.`,
        { action: { label: 'Undo', run: () => dispatch({ type: 'history/undo' }) } },
      );
    }),

    onTidy: () => guard(() => {
      const { positions, frames } = layoutFromSchedule(trip, trip.baseTimezone);
      if (!positions.size) { push('There is nothing scheduled to lay out yet.'); return; }
      dispatch({ type: 'board/layout', positions: [...positions], frames });
      push(`Laid out ${positions.size} cards across ${frames.length} days.`, {
        tone: 'ok', action: { label: 'Undo', run: () => dispatch({ type: 'history/undo' }) },
      });
    }),

    onResolve: () => guard(() => {
      const result = resolveBoard(trip);
      if (!result.moves.length) {
        push(describeResolution(result, trip, zone));
        return;
      }
      dispatch({ type: 'board/apply-times', times: result.moves.map((m) => ({ id: m.id, start: m.to })) });
      push(describeResolution(result, trip, zone), {
        tone: 'ok', action: { label: 'Undo', run: () => dispatch({ type: 'history/undo' }) },
      });
      announce(`Scheduled ${result.moves.length} cards from the board.`);
    }),

    onAnnounce: announce,
  }), [guard, trip, focusPersonId, dayKey, zone, push, announce]);

  /** "Make my own copy" has to end with the copy *in the library*, under its
   *  own identity — the library page is the only thing that can survive a
   *  reload, and the link's fragment is not a home. */
  const makeEditable = useCallback(() => {
    setReadOnly(false);
    clearShareFromLocation();
    onAdopt({ ...trip, name: `${trip.name} (my copy)` });
  }, [trip, onAdopt]);

  const showIssues = useCallback(() => {
    setRailOpen(true);
    requestAnimationFrame(() => {
      document.getElementById('sec-issues')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    const s = issueSummary(issues);
    announce(
      s.total === 0
        ? 'Nothing wrong with the plan.'
        : `${s.error} blocking, ${s.warning} risky, ${s.info} suggestions. Listed in the panel on the left.`,
    );
  }, [issues, setRailOpen, announce]);

  /* ---------- navigation ---------- */
  const stepDay = useCallback((delta: number) => {
    const i = tripDays.indexOf(dayKey);
    const next = tripDays[Math.max(0, Math.min(tripDays.length - 1, i + delta))];
    if (next && next !== dayKey) {
      setDayKey(next);
      announce(fmtDate(dateKeyToEpoch(next, zone), zone, 'long'));
    }
  }, [tripDays, dayKey, zone, announce]);

  const jumpToSegment = useCallback((id: ID) => {
    setSelectedId(id);
    const seg = trip.segments.find((s) => s.id === id);
    if (seg) setDayKey(dateKey(seg.start, zone));
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-seg-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    });
  }, [trip.segments, zone]);

  /** Pick the zoom that makes the whole trip fit the available width.
   *
   *  A long trip cannot fit at any zoom that still leaves a block readable, and
   *  squeezing it into coloured slivers is not a view of anything. When that
   *  happens, say so and point at the view that genuinely does show a whole
   *  trip at once. */
  const fitZoom = useCallback(() => {
    const width = (mainRef.current?.clientWidth ?? 1200) - 208 - 24;
    const hours = Math.max(1, tripDays.length * 24);
    const target = width / hours;
    let idx = 0;
    for (let i = ZOOMS.length - 1; i >= 0; i--) if (ZOOMS[i] <= target) { idx = i; break; }
    setPref('zoomIndex', idx);

    const fits = ZOOMS[idx] <= target;
    announce(
      fits
        ? `Zoomed to fit all ${tripDays.length} days.`
        : `Zoomed out as far as it stays readable; ${tripDays.length} days still need scrolling.`,
    );
    if (!fits) {
      push(`${tripDays.length} days will not fit here and stay readable.`, {
        action: { label: 'Open the Trip view', run: () => setPref('view', 'week') },
      });
    }
  }, [tripDays.length, setPref, announce, push]);

  /** Printing always produces the agenda: it is the only view that reflows
   *  onto paper without losing information. */
  const printItinerary = useCallback(() => {
    setPref('view', 'agenda');
    setSelectedId(null);
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
  }, [setPref]);

  /* ---------- commands ---------- */
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    VIEWS.forEach((v, i) => list.push({
      id: `view-${v.id}`, group: 'Go to', label: `${v.label} view`, hint: String(i + 1),
      run: () => setPref('view', v.id),
    }));
    (['person', 'group', 'place', 'kind', 'unified'] as LaneMode[]).forEach((m) => list.push({
      id: `lane-${m}`, group: 'Timeline', label: `Group lanes by ${m}`,
      run: () => { setPref('laneMode', m); setPref('view', 'timeline'); },
    }));
    trip.people.forEach((p) => {
      list.push({
        id: `focus-${p.id}`, group: 'People', label: `Show only ${p.name}`, keywords: p.homeCity,
        run: () => { setFocusPersonId(p.id); announce(`Showing only ${p.name}.`); },
      });
      list.push({
        id: `clock-${p.id}`, group: 'People', label: `Show times in ${p.name}’s clock`,
        run: () => setClock({ type: 'person', personId: p.id }),
      });
      list.push({
        id: `ics-${p.id}`, group: 'Export', label: `Calendar file for ${p.name}`,
        run: () => { downloadIcs(trip, { personId: p.id }); push(`${p.name}’s calendar downloaded.`, { tone: 'ok' }); },
      });
    });
    list.push(
      { id: 'focus-clear', group: 'People', label: 'Show everyone again', run: () => setFocusPersonId(null) },
      { id: 'clock-event', group: 'Clock', label: 'Times local to each item', run: () => setClock({ type: 'event' }) },
      { id: 'clock-base', group: 'Clock', label: 'Times in trip time', run: () => setClock({ type: 'base' }) },
      { id: 'clock-device', group: 'Clock', label: 'Times on my device clock', run: () => setClock({ type: 'device' }) },
      { id: 'add', group: 'Edit', label: 'Add a block', hint: 'N', run: addHere },
      {
        id: 'board-tidy', group: 'Board', label: 'Tidy the board — a frame per day, in time order',
        run: () => { setPref('view', 'canvas'); boardHandlers.onTidy(); },
      },
      {
        id: 'board-resolve', group: 'Board', label: 'Resolve the board onto the timeline', hint: '⌘⏎',
        run: () => { setPref('view', 'canvas'); boardHandlers.onResolve(); },
      },
      { id: 'add-person', group: 'Edit', label: 'Add someone to the trip', run: () => setPersonSheet('new') },
      { id: 'library', group: 'Go to', label: 'All my trips', run: onExit },
      { id: 'undo', group: 'Edit', label: 'Undo', hint: '⌘Z', run: () => dispatch({ type: 'history/undo' }) },
      { id: 'redo', group: 'Edit', label: 'Redo', hint: '⌘⇧Z', run: () => dispatch({ type: 'history/redo' }) },
      { id: 'share', group: 'Export', label: 'Share this plan', run: () => setShareOpen(true) },
      { id: 'ics-all', group: 'Export', label: 'Calendar file for the whole trip', run: () => downloadIcs(trip) },
      { id: 'json', group: 'Export', label: 'Download a JSON backup', run: () => exportJson(trip) },
      { id: 'print', group: 'Export', label: 'Print or save as PDF', run: printItinerary },
      { id: 'theme', group: 'Appearance', label: 'Toggle light and dark', run: () => setPref('theme', prefs.theme === 'dark' ? 'light' : 'dark') },
      { id: 'density', group: 'Appearance', label: `Switch to ${prefs.density === 'compact' ? 'comfortable' : 'compact'} density`, run: () => setPref('density', prefs.density === 'compact' ? 'comfortable' : 'compact') },
      { id: 'contrast', group: 'Appearance', label: `Turn ${prefs.contrast === 'more' ? 'off' : 'on'} higher contrast`, run: () => setPref('contrast', prefs.contrast === 'more' ? 'normal' : 'more') },
      { id: 'tour', group: 'Help', label: 'Take the tour — what each view is for', run: () => setTourOpen(true) },
      { id: 'help', group: 'Help', label: 'Keyboard shortcuts', hint: '?', run: () => setHelpOpen(true) },
      { id: 'hints', group: 'Help', label: `${hintsOn ? 'Hide' : 'Show'} the one-line view descriptions`, run: () => setHintsOn(!hintsOn) },
      { id: 'reset', group: 'Danger', label: 'Reload the example conference', run: () => { dispatch({ type: 'trip/replace', trip: conferenceTrip(), label: 'Reloaded the example' }); push('Example trip reloaded.'); } },
    );
    trip.segments.forEach((s) => list.push({
      id: `seg-${s.id}`, group: 'Jump to', label: s.title,
      keywords: `${KIND_LABEL[s.kind]} ${s.tags.join(' ')}`,
      run: () => jumpToSegment(s.id),
    }));
    return list;
  }, [trip, prefs, setPref, addHere, boardHandlers, push, announce, jumpToSegment, printItinerary, hintsOn, setHintsOn, onExit]);

  /* ---------- hotkeys ---------- */
  useHotkeys([
    { combo: 'mod+k', description: 'Command palette', run: () => setPaletteOpen(true) },
    { combo: 'mod+z', description: 'Undo', run: () => dispatch({ type: 'history/undo' }) },
    { combo: 'mod+shift+z', description: 'Redo', run: () => dispatch({ type: 'history/redo' }) },
    { combo: 'shift+?', description: 'Help', run: () => setHelpOpen(true) },
    { combo: '?', description: 'Help', run: () => setHelpOpen(true) },
    // The board claims the bare letters for its tools — N is the note tool
    // there, and C drops a card — so the global "new block" stands aside.
    {
      combo: 'n', description: 'New block',
      when: () => prefs.view !== 'canvas',
      run: addHere,
    },
    { combo: '/', description: 'Search', run: () => document.getElementById('rail-q')?.focus() },
    { combo: '\\', description: 'Toggle rail', run: () => setRailOpen((r) => !r) },
    { combo: '[', description: 'Previous day', run: () => stepDay(-1) },
    { combo: ']', description: 'Next day', run: () => stepDay(1) },
    { combo: 'Escape', description: 'Close', run: () => { setSelectedId(null); setPaletteOpen(false); } },
    // Removing a block was Inspector-only, which meant three clicks from a
    // view you were already pointing at it in. The board runs its own delete
    // (it can also delete notes, frames and connectors), so it stands aside.
    {
      combo: 'Backspace', description: 'Delete the selected block',
      when: () => prefs.view !== 'canvas' && !!selectedId,
      run: () => { if (selectedId) onDelete(selectedId); },
    },
    {
      combo: 'Delete', description: 'Delete the selected block',
      when: () => prefs.view !== 'canvas' && !!selectedId,
      run: () => { if (selectedId) onDelete(selectedId); },
    },
    ...VIEWS.map((v, i) => ({
      combo: String(i + 1), description: `${v.label} view`, run: () => setPref('view', v.id),
    })),
  ]);

  /* ---------- shared handlers ---------- */
  const viewProps = {
    trip, segments: filtered, clock, issues, selectedId, now,
    onSelect: (id: ID | null) => setSelectedId(id),
    onAnnounce: announce,
  };

  const inspectorOpen = selectedId !== null;
  const summary = issueSummary(issues);

  return (
    <div className="app">
      <a className="skip-link" href="#view-panel">Skip to the itinerary</a>

      <div className="print-only print-head">
        <h2>{trip.name}</h2>
        <p>
          {trip.subtitle}
          {focusPersonId ? ` — itinerary for ${trip.people.find((p) => p.id === focusPersonId)?.name}` : ''}
        </p>
        <p>
          All times in {zone.replace(/_/g, ' ')}. Printed {fmtDate(now, zone, 'long')}.
          {issues.some((i) => i.severity === 'error') && ' Unresolved clashes remain — check the app before relying on this.'}
        </p>
      </div>


      <TopBar
        trip={trip} view={prefs.view} clock={clock} issues={issues}
        onExit={onExit}
        canUndo={state.past.length > 0} canRedo={state.future.length > 0}
        theme={prefs.theme === 'light' ? 'light' : 'dark'} railOpen={railOpen}
        onView={(v) => setPref('view', v)}
        onClock={setClock}
        onUndo={() => { dispatch({ type: 'history/undo' }); announce('Undone.'); }}
        onRedo={() => { dispatch({ type: 'history/redo' }); announce('Redone.'); }}
        onShare={() => setShareOpen(true)}
        onTheme={() => setPref('theme', prefs.theme === 'dark' ? 'light' : 'dark')}
        onToggleRail={() => setRailOpen((r) => !r)}
        onOpenIssues={showIssues}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenTour={() => setTourOpen(true)}
      />

      {readOnly && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--s-3)', padding: 'var(--s-2) var(--s-4)',
          background: 'var(--warn-soft)', borderBottom: '1px solid var(--line-1)', fontSize: 'var(--step--1)',
        }}>
          <strong>Read-only link.</strong>
          <span className="grow">Someone shared this plan with you. Nothing you change here is saved.</span>
          <button className="btn btn--sm btn--primary" onClick={makeEditable}>Make my own copy</button>
        </div>
      )}

      <div className="shell" data-rail={railOpen ? 'open' : 'closed'} data-inspector={inspectorOpen ? 'open' : 'closed'}>
        <aside className="rail" data-open={railOpen} hidden={isMobile && !railOpen}>
          <Rail
            trip={trip} filters={filters} issues={issues} focusPersonId={focusPersonId}
            onFilters={setFilters}
            onFocusPerson={setFocusPersonId}
            onSelectSegment={jumpToSegment}
            onJumpIssue={(i) => { if (i.personIds[0]) setFocusPersonId(null); if (i.segmentIds[0]) jumpToSegment(i.segmentIds[0]); }}
            onAddPerson={() => setPersonSheet('new')}
          />
        </aside>

        {isMobile && railOpen && <div className="scrim" onClick={() => setRailOpen(false)} aria-hidden="true" />}

        <main className="main" ref={mainRef} aria-label="Itinerary">
          <ViewBar
            view={prefs.view} trip={trip} dayKey={dayKey} tripDays={tripDays} zone={zone}
            laneMode={prefs.laneMode} zoomIndex={prefs.zoomIndex} hourHeight={prefs.hourHeight}
            focusPersonId={focusPersonId} filtered={filtered.length} total={trip.segments.length}
            summary={summary} selected={selected} readOnly={readOnly}
            onDay={setDayKey} onStepDay={stepDay}
            onLaneMode={(m) => setPref('laneMode', m)}
            onZoom={(i) => setPref('zoomIndex', i)}
            onHourHeight={(h) => setPref('hourHeight', h)}
            onAdd={addHere}
            onClearFocus={() => setFocusPersonId(null)}
            onFocusPerson={setFocusPersonId}
            onToday={() => { const t = dateKey(now, zone); setDayKey(tripDays.includes(t) ? t : tripDays[0]); }}
            onFit={fitZoom}
            onShowIssues={showIssues}
            onDuplicate={duplicateSegment}
            onRemove={onDelete}
          />

          {hintsOn && <ViewHint view={prefs.view} onDismiss={() => {
            setHintsOn(false);
            push('View descriptions hidden. Turn them back on from the command palette.');
          }} />}

          <div className="view-body" id="view-panel" role="tabpanel" aria-labelledby={`tab-${prefs.view}`} tabIndex={-1}>
            {prefs.view === 'canvas' && (
              <CanvasView
                trip={trip} segments={filtered} clock={clock} issues={issues}
                selectedId={selectedId} now={now} handlers={boardHandlers}
                addCardRef={boardAddRef}
              />
            )}
            {prefs.view === 'timeline' && (
              <TimelineView
                {...viewProps}
                laneMode={prefs.laneMode} density={prefs.density} zoomIndex={prefs.zoomIndex}
                personFilter={laneFilter}
                onSelect={(id) => setSelectedId(id)}
                onMove={onMove} onResize={onResize} onReassign={onReassign}
                onZoom={(i) => setPref('zoomIndex', i)}
                onCreateRange={(start, end, laneId) => addSegment({
                  start, end, timezone: zone, ...draftForLane(laneId),
                })}
                onAddInLane={addInLane}
                dayName={dayKey ? fmtDate(dateKeyToEpoch(dayKey, zone), zone, 'medium') : ''}
                onAddPerson={() => setPersonSheet('new')}
              />
            )}
            {prefs.view === 'day' && dayKey && (
              <DayView
                {...viewProps}
                dayKey={dayKey} laneMode={prefs.laneMode} hourHeight={prefs.hourHeight}
                personFilter={laneFilter}
                onMove={onMove} onResize={onResize} onReassign={onReassign}
                onCreateRange={(start, end, laneId) => addSegment({
                  start, end, timezone: zone, ...draftForLane(laneId),
                })}
                onAddInLane={addInLane}
              />
            )}
            {prefs.view === 'week' && (
              <WeekView
                {...viewProps}
                onSelect={(id) => setSelectedId(id)}
                onShiftDays={onShiftDays}
                onOpenDay={(k) => { setDayKey(k); setPref('view', 'day'); }}
                onAddOnDay={addOnDay}
              />
            )}
            {prefs.view === 'agenda' && (
              <AgendaView
                {...viewProps} focusPersonId={focusPersonId}
                onSelect={(id) => setSelectedId(id)}
                onAddOnDay={addOnDay}
                onDelete={onDelete}
                onAddFirst={() => addOnDay(dayKey || trip.startDate)}
                readOnly={readOnly}
              />
            )}
            {prefs.view === 'map' && (
              <Suspense fallback={<div className="empty"><p className="empty__body">Loading the map…</p></div>}>
                <MapView
                  trip={trip} segments={filtered} clock={clock} dayKey={dayKey}
                  focusPersonId={focusPersonId} selectedId={selectedId}
                  onSelect={(id) => setSelectedId(id)}
                  onAddStop={readOnly ? undefined : () => addOnDay(dayKey || trip.startDate)}
                  onRemoveStop={readOnly ? undefined : onDelete}
                />
              </Suspense>
            )}
            {prefs.view === 'people' && (
              <PeopleView
                trip={trip} clock={clock} focusPersonId={focusPersonId} issues={issues}
                onFocusPerson={setFocusPersonId}
                onExport={(id) => { downloadIcs(trip, { personId: id }); push('Calendar file downloaded.', { tone: 'ok' }); }}
                onOpenPerson={(id) => { setFocusPersonId(id); setPref('view', 'canvas'); }}
                onAddPerson={() => setPersonSheet('new')}
                onAddBlockFor={addForPerson}
                onEditPerson={(id) => setPersonSheet(id)}
                onSharePerson={(id) => { setFocusPersonId(id); setShareOpen(true); }}
              />
            )}
            {prefs.view === 'board' && (
              <BoardView
                trip={trip} clock={clock}
                onPromote={(ideaId, start, tz) => guard(() => dispatch({ type: 'idea/promote', id: ideaId, start, timezone: tz }))}
                onAddIdea={(title) => guard(() => dispatch({
                  type: 'idea/add',
                  idea: { id: uid('idea'), title, kind: 'activity', durationMin: 120, attendeeIds: [], tags: [], votes: [] },
                }))}
                onDeleteIdea={(id) => guard(() => dispatch({ type: 'idea/delete', id }))}
                onVote={(id, personId) => guard(() => {
                  const idea = trip.ideas.find((i) => i.id === id);
                  if (!idea) return;
                  const votes = idea.votes.includes(personId)
                    ? idea.votes.filter((v) => v !== personId)
                    : [...idea.votes, personId];
                  dispatch({ type: 'idea/patch', id, patch: { votes } });
                })}
                onAnnounce={announce}
              />
            )}
          </div>
        </main>

        <aside className="inspector" data-open={inspectorOpen} hidden={!inspectorOpen} aria-label="Block details">
          <Inspector
            seg={selected} trip={trip} clock={clock} issues={issues}
            onPatch={onPatch}
            onDelete={onDelete}
            onDuplicate={duplicateSegment}
            onClose={() => setSelectedId(null)}
            onToggleAttendee={(id, personId, on) => guard(() => dispatch({ type: 'segment/assign', id, personId, on }))}
            onSelect={jumpToSegment}
          />
        </aside>

        {isMobile && inspectorOpen && <div className="scrim" onClick={() => setSelectedId(null)} aria-hidden="true" />}
      </div>

      {isMobile && (
        <nav className="tabbar" role="tablist" aria-label="View">
          {VIEWS.slice(0, 6).map(({ id, label, hint, Icon }) => (
            <button key={id} role="tab" className="tabbar__btn" aria-selected={prefs.view === id}
              title={`${label}\n${hint}`}
              onClick={() => setPref('view', id)}>
              <Icon size={19} />
              {label}
            </button>
          ))}
        </nav>
      )}

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      <ShareDialog
        open={shareOpen} trip={trip}
        onClose={() => setShareOpen(false)}
        onImport={(t) => dispatch({ type: 'trip/replace', trip: t, label: 'Imported a trip' })}
        onToast={(m, tone) => push(m, { tone })}
        onCopyText={(pid) => agendaText(trip, pid ? filtered.filter((s) => attendeesOf(s, trip).includes(pid)) : filtered, zone, pid ?? undefined)}
        onPrint={printItinerary}
      />
      {personSheet && (
        <PersonSheet
          trip={trip}
          person={personSheet === 'new' ? undefined : trip.people.find((p) => p.id === personSheet)}
          onSave={savePerson}
          onDelete={removePerson}
          onClose={() => setPersonSheet(null)}
        />
      )}
      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Tour
        open={tourOpen} trip={trip}
        onClose={() => { markTourSeen(); setTourOpen(false); }}
        onView={(v) => setPref('view', v)}
      />

      <div className="toasts">
        {toasts.map((t) => (
          <div className="toast" key={t.id} data-tone={t.tone} role="status">
            <span className="grow">{t.message}</span>
            {t.action && <button className="btn btn--sm" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
            <button
              className="btn btn--icon btn--sm btn--ghost" onClick={() => dismiss(t.id)}
              title="Dismiss this message" aria-label="Dismiss"
            >
              <IconClose size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="announcer" role="status" aria-live="polite" aria-atomic="true">{liveMessage}</div>
      <div className="sr-only" aria-live="polite">
        {state.lastLabel ?? ''}
      </div>
    </div>
  );
}

/* ============================================================ */


/** The bar under the tabs: what this view is showing, and the two things every
 *  view must let you do — put something into the plan, and take it out again.
 *
 *  Add and Remove sit in the same place in every view on purpose. Each view
 *  also has its own quicker way in (draw on a lane, "+" on a day, the card
 *  tool on the board) but none of those is discoverable from a standing start,
 *  and a plan you can only add to from one screen is a plan you edit in one
 *  screen. Every control here carries a `Tip` saying what it does. */
function ViewBar({
  view, trip, dayKey, tripDays, zone, laneMode, zoomIndex, hourHeight, focusPersonId,
  filtered, total, summary, selected, readOnly,
  onDay, onStepDay, onLaneMode, onZoom, onHourHeight, onAdd, onClearFocus, onToday, onFit, onFocusPerson,
  onShowIssues, onDuplicate, onRemove,
}: {
  view: ViewId; trip: Trip; dayKey: string; tripDays: string[]; zone: string;
  laneMode: LaneMode; zoomIndex: number; hourHeight: number; focusPersonId: ID | null;
  filtered: number; total: number; summary: { error: number; warning: number; info: number; total: number };
  /** What Remove and Duplicate act on. Null when nothing is selected. */
  selected: Segment | null;
  readOnly: boolean;
  onDay: (k: string) => void; onStepDay: (d: number) => void;
  onLaneMode: (m: LaneMode) => void; onZoom: (i: number) => void; onHourHeight: (h: number) => void;
  onAdd: () => void; onClearFocus: () => void; onToday: () => void; onFit: () => void;
  onFocusPerson: (id: ID | null) => void;
  onShowIssues: () => void;
  onDuplicate: (id: ID) => void;
  onRemove: (id: ID) => void;
}) {
  const person = trip.people.find((p) => p.id === focusPersonId);
  const showDayNav = view === 'day' || view === 'map';
  const showLanes = view === 'timeline' || view === 'day';
  const meta = VIEWS.find((v) => v.id === view);
  const dayName = dayKey ? fmtDate(dateKeyToEpoch(dayKey, zone), zone, 'medium') : '';

  return (
    <div className="viewbar">
      {showDayNav && (
        <>
          <Tip label="The day before" keys="[" hint="Step the whole view back one day.">
            <button className="btn btn--icon" onClick={() => onStepDay(-1)} aria-label="Previous day">
              <IconLeft />
            </button>
          </Tip>
          <label className="sr-only" htmlFor="daypick">Day</label>
          <Tip label="Which day you are looking at" hint="Also the day a new block lands on when you press Add.">
            <select
              id="daypick" className="input" style={{ width: 'auto' }} value={dayKey}
              onChange={(e) => onDay(e.target.value)}
            >
              {tripDays.map((d) => (
                <option key={d} value={d}>{fmtDate(dateKeyToEpoch(d, zone), zone, 'long')}</option>
              ))}
            </select>
          </Tip>
          <Tip label="The day after" keys="]" hint="Step the whole view on one day.">
            <button className="btn btn--icon" onClick={() => onStepDay(1)} aria-label="Next day">
              <IconRight />
            </button>
          </Tip>
          <Tip label="Today" hint="Jump to today, if today falls inside the trip. Otherwise the first day.">
            <button className="btn btn--sm" onClick={onToday}>
              <IconTarget size={14} /> Today
            </button>
          </Tip>
        </>
      )}

      <label className="sr-only" htmlFor="whopick">Whose plan</label>
      <Tip
        label="Whose plan to show"
        hint="Walk in one person’s shoes — every view narrows to what they actually do, and new blocks are theirs."
      >
        <select
          id="whopick" className="input" style={{ width: 'auto' }}
          value={focusPersonId ?? ''}
          onChange={(e) => onFocusPerson(e.target.value ? (e.target.value as ID) : null)}
        >
          <option value="">Everyone</option>
          {trip.people.map((p) => <option key={p.id} value={p.id}>Just {p.name}</option>)}
        </select>
      </Tip>

      {showLanes && (
        <>
          <label className="sr-only" htmlFor="lanepick">Group lanes by</label>
          <Tip
            label="What each lane stands for"
            hint="It also decides what a block you draw — or add with the lane’s +  — belongs to."
          >
            <select
              id="lanepick" className="input" style={{ width: 'auto' }} value={laneMode}
              onChange={(e) => onLaneMode(e.target.value as LaneMode)}
            >
              <option value="person">Lane per person</option>
              <option value="group">Lane per group</option>
              <option value="place">Lane per place</option>
              <option value="kind">Lane per type</option>
              <option value="unified">One lane</option>
            </select>
          </Tip>
        </>
      )}

      {view === 'timeline' && (
        <div className="row" style={{ gap: 2 }}>
          <Tip label="Show more days at once" keys="⌘ + scroll" hint="Zooms the timeline out. Blocks get narrower and lose their detail.">
            <button
              className="btn btn--icon" onClick={() => onZoom(Math.max(0, zoomIndex - 1))}
              disabled={zoomIndex === 0} aria-label="Zoom out"
            >
              <IconZoomOut />
            </button>
          </Tip>
          <Tip label="Timeline zoom" hint="How much width one hour of the trip gets.">
            <span
              className="mono"
              style={{ fontSize: 'var(--step--2)', color: 'var(--ink-3)', width: '3.4rem', textAlign: 'center' }}
            >
              {ZOOMS[zoomIndex]}px/h
            </span>
          </Tip>
          <Tip label="Show fewer days, in more detail" keys="⌘ + scroll" hint="Zooms the timeline in, until each block can show its place and times.">
            <button
              className="btn btn--icon" onClick={() => onZoom(Math.min(ZOOMS.length - 1, zoomIndex + 1))}
              disabled={zoomIndex === ZOOMS.length - 1} aria-label="Zoom in"
            >
              <IconZoomIn />
            </button>
          </Tip>
          <Tip label="Fit the trip" hint="Picks the zoom that puts the whole trip on screen, as long as it stays readable.">
            <button className="btn btn--sm" onClick={onFit}>Fit trip</button>
          </Tip>
        </div>
      )}

      {view === 'day' && (
        <div className="row" style={{ gap: 2 }}>
          <Tip label="Squeeze the hours" hint="Shorter rows, so more of the day fits on screen at once.">
            <button
              className="btn btn--icon" onClick={() => onHourHeight(Math.max(34, hourHeight - 14))}
              aria-label="Shorter hours"
            >
              <IconZoomOut />
            </button>
          </Tip>
          <Tip label="Stretch the hours" hint="Taller rows, so there is room for the detail inside each block.">
            <button
              className="btn btn--icon" onClick={() => onHourHeight(Math.min(140, hourHeight + 14))}
              aria-label="Taller hours"
            >
              <IconZoomIn />
            </button>
          </Tip>
        </div>
      )}

      <div className="grow" />

      {/* The right-hand end never scrolls away: Add and Remove are the two
          controls that must be reachable at any window width, and the bar
          scrolls sideways on a narrow one. */}
      <div className="viewbar__end">
      {person && (
        <Tip label={`Showing only ${person.name}`} hint="Click to go back to everybody.">
          <button className="chip chip--accent" onClick={onClearFocus}>
            Only {person.name} · clear
          </button>
        </Tip>
      )}
      <Tip
        label={filtered === total ? `${total} blocks in the plan` : `${filtered} of ${total} blocks shown`}
        hint={filtered === total
          ? 'Everything in the trip is visible.'
          : 'The rest are hidden by the filters in the side panel, or by whose plan you are showing.'}
      >
        <span className="chip">
          {filtered === total ? `${total} blocks` : `${filtered} of ${total} shown`}
        </span>
      </Tip>
      {/* Telling someone their plan is broken without giving them a way to
          reach the break is worse than not telling them. */}
      {summary.error > 0 && (
        <Tip
          label={`${summary.error} ${summary.error === 1 ? 'problem' : 'problems'}`}
          hint="Clashes and impossible journeys. Opens the list in the side panel, each one linked to the block it is about."
        >
          <button type="button" className="chip chip--danger chip--action" onClick={onShowIssues}>
            {summary.error} {summary.error === 1 ? 'problem' : 'problems'} →
          </button>
        </Tip>
      )}

      {/* The selection's own actions. They live here, in the same place in
          every view, so "how do I get rid of this" has one answer. */}
      {selected && !readOnly && (
        <span className="viewbar__sel">
          <span className="viewbar__selname" title={selected.title}>{selected.title}</span>
          <Tip label="Duplicate this block" hint="A copy of everything about it, starting where this one ends.">
            <button
              className="btn btn--icon btn--sm btn--ghost"
              onClick={() => onDuplicate(selected.id)}
              aria-label={`Duplicate ${selected.title}`}
            >
              <IconCopy size={13} />
            </button>
          </Tip>
          <Tip
            label="Remove this block" keys="⌫"
            hint="Takes it out of the plan. You get an undo in the message that follows."
            side="left"
          >
            <button
              className="btn btn--icon btn--sm btn--ghost viewbar__del"
              onClick={() => onRemove(selected.id)}
              aria-label={`Remove ${selected.title} from the trip`}
            >
              <IconTrash size={13} />
            </button>
          </Tip>
        </span>
      )}

      <Tip
        label={
          view === 'canvas' ? 'Add a card here'
            : dayKey ? `Add a block on ${dayName}` : 'Add a block'
        }
        keys={view === 'canvas' ? 'C' : 'N'}
        hint={
          view === 'canvas'
            ? 'Drops a card in the middle of the board and opens its details. Or pick the card tool and click exactly where you want it.'
            : meta ? `${meta.adds}. Its details open straight away, so you can say what it is.` : undefined
        }
        side="left"
      >
        <button className="btn btn--primary btn--sm" onClick={onAdd}>
          <IconPlus size={14} /> Add
        </button>
      </Tip>
      </div>
    </div>
  );
}

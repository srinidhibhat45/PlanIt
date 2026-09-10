import { Suspense, lazy, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type {
  ClockMode, Density, Filters, Frame, ID, LaneMode, Link, Person, Rect, Segment,
  Sticky, ThemeMode, Trip, ViewId,
} from './core/types';
import { DAY, MIN, addDays, dateKey, dateKeyToEpoch, eachDay, fmtDate } from './core/time';
import { analyse, applyFilters, attendeesOf, issueSummary } from './core/schedule';
import { ZOOMS, KIND_LABEL } from './core/layout';
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
import { IconClose, IconLeft, IconPlus, IconRight, IconTarget, IconZoomIn, IconZoomOut } from './components/Icons';

interface Prefs {
  view: ViewId; laneMode: LaneMode; density: Density; theme: ThemeMode;
  zoomIndex: number; hourHeight: number; contrast: 'normal' | 'more';
}

const DEFAULT_PREFS: Prefs = {
  view: 'canvas', laneMode: 'person', density: 'comfortable', theme: 'dark',
  zoomIndex: 3, hourHeight: 62, contrast: 'normal',
};

const EMPTY_FILTERS: Filters = {
  personIds: [], groupIds: [], kinds: [], tags: [], query: '', hideCancelled: false, branchIds: [],
};

export default function App({
  tripId, initialTrip, onExit, onSaved,
}: {
  /** Null when the plan came from a share link rather than the library. */
  tripId: ID | null;
  initialTrip: Trip | null;
  onExit: () => void;
  /** Lets the library page refresh its cards after a save. */
  onSaved: () => void;
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

  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(DEFAULT_PREFS));
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

  /* ---------- day cursor ---------- */
  const zone = axisZone(clock, trip);
  const tripDays = useMemo(() => {
    if (!trip.segments.length) return eachDay(now, now + 6 * DAY, zone);
    const lo = Math.min(...trip.segments.map((s) => s.start));
    const hi = Math.max(...trip.segments.map((s) => s.end));
    return eachDay(lo, hi, zone);
  }, [trip.segments, zone, now]);

  const [dayKey, setDayKey] = useState<string>(() => '');
  useEffect(() => {
    if (dayKey && tripDays.includes(dayKey)) return;
    const today = dateKey(now, zone);
    setDayKey(tripDays.includes(today) ? today : tripDays[0] ?? today);
  }, [tripDays, dayKey, now, zone]);

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
     asks for one, so it is deliberately not written here. */
  useEffect(() => {
    if (readOnly || !tripId) return;
    const h = window.setTimeout(() => { writeTrip(trip); onSaved(); }, 400);
    return () => clearTimeout(h);
  }, [trip, readOnly, tripId, onSaved]);

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

  const makeEditable = useCallback(() => {
    setReadOnly(false);
    clearShareFromLocation();
    dispatch({ type: 'trip/patch', patch: { id: uid('trip'), name: `${trip.name} (my copy)` }, label: 'Made an editable copy' });
    push('You now have your own editable copy. It saves in this browser.', { tone: 'ok' });
  }, [trip.name, push]);

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
      { id: 'add', group: 'Edit', label: 'Add a block', hint: 'N', run: () => addSegment() },
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
  }, [trip, prefs, setPref, addSegment, push, announce, jumpToSegment, printItinerary, hintsOn, setHintsOn, onExit]);

  /* ---------- hotkeys ---------- */
  useHotkeys([
    { combo: 'mod+k', description: 'Command palette', run: () => setPaletteOpen(true) },
    { combo: 'mod+z', description: 'Undo', run: () => dispatch({ type: 'history/undo' }) },
    { combo: 'mod+shift+z', description: 'Redo', run: () => dispatch({ type: 'history/redo' }) },
    { combo: 'shift+?', description: 'Help', run: () => setHelpOpen(true) },
    { combo: '?', description: 'Help', run: () => setHelpOpen(true) },
    { combo: 'n', description: 'New block', run: () => addSegment() },
    { combo: '/', description: 'Search', run: () => document.getElementById('rail-q')?.focus() },
    { combo: '\\', description: 'Toggle rail', run: () => setRailOpen((r) => !r) },
    { combo: '[', description: 'Previous day', run: () => stepDay(-1) },
    { combo: ']', description: 'Next day', run: () => stepDay(1) },
    { combo: 'Escape', description: 'Close', run: () => { setSelectedId(null); setPaletteOpen(false); } },
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
          />
        </aside>

        {isMobile && railOpen && <div className="scrim" onClick={() => setRailOpen(false)} aria-hidden="true" />}

        <main className="main" ref={mainRef} aria-label="Itinerary">
          <ViewBar
            view={prefs.view} trip={trip} dayKey={dayKey} tripDays={tripDays} zone={zone}
            laneMode={prefs.laneMode} zoomIndex={prefs.zoomIndex} hourHeight={prefs.hourHeight}
            focusPersonId={focusPersonId} filtered={filtered.length} total={trip.segments.length}
            summary={summary}
            onDay={setDayKey} onStepDay={stepDay}
            onLaneMode={(m) => setPref('laneMode', m)}
            onZoom={(i) => setPref('zoomIndex', i)}
            onHourHeight={(h) => setPref('hourHeight', h)}
            onAdd={() => addSegment()}
            onClearFocus={() => setFocusPersonId(null)}
            onFocusPerson={setFocusPersonId}
            onToday={() => { const t = dateKey(now, zone); setDayKey(tripDays.includes(t) ? t : tripDays[0]); }}
            onFit={fitZoom}
            onShowIssues={showIssues}
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
              />
            )}
            {prefs.view === 'day' && dayKey && (
              <DayView
                {...viewProps}
                dayKey={dayKey} laneMode={prefs.laneMode} hourHeight={prefs.hourHeight}
                personFilter={laneFilter}
                onMove={onMove} onResize={onResize} onReassign={onReassign}
                onCreateAt={(start, laneId) => addSegment({
                  start, end: start + 60 * MIN, timezone: zone,
                  attendeeIds: prefs.laneMode === 'person' ? [laneId] : [],
                })}
              />
            )}
            {prefs.view === 'week' && (
              <WeekView
                {...viewProps}
                onSelect={(id) => setSelectedId(id)}
                onShiftDays={onShiftDays}
                onOpenDay={(k) => { setDayKey(k); setPref('view', 'day'); }}
              />
            )}
            {prefs.view === 'agenda' && (
              <AgendaView {...viewProps} focusPersonId={focusPersonId} onSelect={(id) => setSelectedId(id)} />
            )}
            {prefs.view === 'map' && (
              <Suspense fallback={<div className="empty"><p className="empty__body">Loading the map…</p></div>}>
                <MapView
                  trip={trip} segments={filtered} clock={clock} dayKey={dayKey}
                  focusPersonId={focusPersonId} selectedId={selectedId}
                  onSelect={(id) => setSelectedId(id)}
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
            onDuplicate={(id) => guard(() => { dispatch({ type: 'segment/duplicate', id }); push('Duplicated.'); })}
            onClose={() => setSelectedId(null)}
            onToggleAttendee={(id, personId, on) => guard(() => dispatch({ type: 'segment/assign', id, personId, on }))}
            onSelect={jumpToSegment}
          />
        </aside>

        {isMobile && inspectorOpen && <div className="scrim" onClick={() => setSelectedId(null)} aria-hidden="true" />}
      </div>

      {isMobile && (
        <nav className="tabbar" role="tablist" aria-label="View">
          {VIEWS.slice(0, 6).map(({ id, label, Icon }) => (
            <button key={id} role="tab" className="tabbar__btn" aria-selected={prefs.view === id}
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
            <button className="btn btn--icon btn--sm btn--ghost" onClick={() => dismiss(t.id)} aria-label="Dismiss"><IconClose size={14} /></button>
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

function ViewBar({
  view, trip, dayKey, tripDays, zone, laneMode, zoomIndex, hourHeight, focusPersonId,
  filtered, total, summary,
  onDay, onStepDay, onLaneMode, onZoom, onHourHeight, onAdd, onClearFocus, onToday, onFit, onFocusPerson,
  onShowIssues,
}: {
  view: ViewId; trip: Trip; dayKey: string; tripDays: string[]; zone: string;
  laneMode: LaneMode; zoomIndex: number; hourHeight: number; focusPersonId: ID | null;
  filtered: number; total: number; summary: { error: number; warning: number; info: number; total: number };
  onDay: (k: string) => void; onStepDay: (d: number) => void;
  onLaneMode: (m: LaneMode) => void; onZoom: (i: number) => void; onHourHeight: (h: number) => void;
  onAdd: () => void; onClearFocus: () => void; onToday: () => void; onFit: () => void;
  onFocusPerson: (id: ID | null) => void;
  onShowIssues: () => void;
}) {
  const person = trip.people.find((p) => p.id === focusPersonId);
  const showDayNav = view === 'day' || view === 'map';
  const showLanes = view === 'timeline' || view === 'day';

  return (
    <div className="viewbar">
      {showDayNav && (
        <>
          <button className="btn btn--icon" onClick={() => onStepDay(-1)} aria-label="Previous day"><IconLeft /></button>
          <label className="sr-only" htmlFor="daypick">Day</label>
          <select id="daypick" className="input" style={{ width: 'auto' }} value={dayKey} onChange={(e) => onDay(e.target.value)}>
            {tripDays.map((d) => (
              <option key={d} value={d}>{fmtDate(dateKeyToEpoch(d, zone), zone, 'long')}</option>
            ))}
          </select>
          <button className="btn btn--icon" onClick={() => onStepDay(1)} aria-label="Next day"><IconRight /></button>
          <button className="btn btn--sm" onClick={onToday}><IconTarget size={14} /> Today</button>
        </>
      )}

      <label className="sr-only" htmlFor="whopick">Whose plan</label>
      <select
        id="whopick" className="input" style={{ width: 'auto' }}
        value={focusPersonId ?? ''}
        onChange={(e) => onFocusPerson(e.target.value ? (e.target.value as ID) : null)}
      >
        <option value="">Everyone</option>
        {trip.people.map((p) => <option key={p.id} value={p.id}>Just {p.name}</option>)}
      </select>

      {showLanes && (
        <>
          <label className="sr-only" htmlFor="lanepick">Group lanes by</label>
          <select id="lanepick" className="input" style={{ width: 'auto' }} value={laneMode}
            onChange={(e) => onLaneMode(e.target.value as LaneMode)}>
            <option value="person">Lane per person</option>
            <option value="group">Lane per group</option>
            <option value="place">Lane per place</option>
            <option value="kind">Lane per type</option>
            <option value="unified">One lane</option>
          </select>
        </>
      )}

      {view === 'timeline' && (
        <div className="row" style={{ gap: 2 }}>
          <button className="btn btn--icon" onClick={() => onZoom(Math.max(0, zoomIndex - 1))}
            disabled={zoomIndex === 0} aria-label="Zoom out"><IconZoomOut /></button>
          <span className="mono" style={{ fontSize: 'var(--step--2)', color: 'var(--ink-3)', width: '3.4rem', textAlign: 'center' }}>
            {ZOOMS[zoomIndex]}px/h
          </span>
          <button className="btn btn--icon" onClick={() => onZoom(Math.min(ZOOMS.length - 1, zoomIndex + 1))}
            disabled={zoomIndex === ZOOMS.length - 1} aria-label="Zoom in"><IconZoomIn /></button>
          <button className="btn btn--sm" onClick={onFit}>Fit trip</button>
        </div>
      )}

      {view === 'day' && (
        <div className="row" style={{ gap: 2 }}>
          <button className="btn btn--icon" onClick={() => onHourHeight(Math.max(34, hourHeight - 14))} aria-label="Shorter hours"><IconZoomOut /></button>
          <button className="btn btn--icon" onClick={() => onHourHeight(Math.min(140, hourHeight + 14))} aria-label="Taller hours"><IconZoomIn /></button>
        </div>
      )}

      <div className="grow" />

      {person && (
        <button className="chip chip--accent" onClick={onClearFocus}>
          Only {person.name} · clear
        </button>
      )}
      <span className="chip" title={`${filtered} of ${total} blocks visible`}>
        {filtered === total ? `${total} blocks` : `${filtered} of ${total} shown`}
      </span>
      {/* Telling someone their plan is broken without giving them a way to
          reach the break is worse than not telling them. */}
      {summary.error > 0 && (
        <button
          type="button" className="chip chip--danger chip--action" onClick={onShowIssues}
          title="Open the list of problems"
        >
          {summary.error} {summary.error === 1 ? 'problem' : 'problems'} →
        </button>
      )}

      <button className="btn btn--primary btn--sm" onClick={onAdd}>
        <IconPlus size={14} /> Add
      </button>
    </div>
  );
}

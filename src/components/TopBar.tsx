import type { ReactElement } from 'react';
import type { ClockMode, Trip, ViewId } from '../core/types';
import { clockLabel } from '../core/clock';
import { ClockMenu } from './ClockMenu';
import { issueSummary } from '../core/schedule';
import type { Issue } from '../core/types';
import { Tip } from './Tooltip';
import {
  IconAgenda, IconBoard, IconCanvas, IconDay, IconLeft, IconMap, IconMenu, IconPeople,
  IconRedo, IconSearch, IconShare, IconSparkle, IconSun, IconMoon, IconTimeline, IconUndo,
  IconWarn, IconWeek,
} from './Icons';

/** The views, in tab order — and therefore in number-key order too.
 *
 *  The timeline leads because it is the view the app opens on and the one that
 *  answers the ordinary question ("who is doing what, when"); the board is a
 *  way of *thinking* about a plan and comes after the plan itself.
 *
 *  `hint` is what the tab says on hover and `adds` is how you put something
 *  into the plan from there — a view you cannot add to is a dead end, and a
 *  tab strip you have to click through to understand is a puzzle, not a UI. */
export const VIEWS: {
  id: ViewId; label: string; hint: string; adds: string;
  Icon: (p: { size?: number }) => ReactElement;
}[] = [
  { id: 'timeline', label: 'Timeline', Icon: IconTimeline,
    hint: 'Everyone at once, time running left to right',
    adds: 'Drag across an empty stretch of a lane, or use + on a lane' },
  { id: 'day', label: 'Day', Icon: IconDay,
    hint: 'One day, hour by hour, a column per person',
    adds: 'Drag down an empty stretch of a column, or use + on a column' },
  { id: 'week', label: 'Trip', Icon: IconWeek,
    hint: 'The whole trip as a calendar — drag a block to another day',
    adds: 'Use + in the corner of any day' },
  { id: 'agenda', label: 'Agenda', Icon: IconAgenda,
    hint: 'The plan as a readable list, day by day — the printable one',
    adds: 'Use Add at the head of any day' },
  { id: 'map', label: 'Map', Icon: IconMap,
    hint: 'Where one day happens, in order, with the journeys drawn',
    adds: 'Use Add a stop, then give it a place' },
  { id: 'canvas', label: 'Canvas', Icon: IconCanvas,
    hint: 'The board — arrange cards by hand, then resolve them onto the calendar',
    adds: 'Press C or pick the card tool, then click the board' },
  { id: 'people', label: 'People', Icon: IconPeople,
    hint: 'Who is on the trip, where they are coming from, and what each does',
    adds: 'Use Add a block on somebody’s card' },
  { id: 'board', label: 'Ideas', Icon: IconBoard,
    hint: 'The backlog — things somebody suggested that are not on the plan yet',
    adds: 'Type an idea in the box, then drop it on a day to schedule it' },
];

export function TopBar({
  trip, view, clock, issues, canUndo, canRedo, theme, railOpen,
  onView, onClock, onUndo, onRedo, onShare, onTheme, onToggleRail, onOpenIssues, onOpenPalette,
  onOpenTour, onExit,
}: {
  trip: Trip; view: ViewId; clock: ClockMode; issues: Issue[];
  canUndo: boolean; canRedo: boolean; theme: 'dark' | 'light'; railOpen: boolean;
  onView: (v: ViewId) => void;
  onClock: (c: ClockMode) => void;
  onUndo: () => void; onRedo: () => void;
  onShare: () => void; onTheme: () => void;
  onToggleRail: () => void; onOpenIssues: () => void; onOpenPalette: () => void;
  onOpenTour: () => void;
  /** Back to the library of trips. */
  onExit: () => void;
}) {
  const s = issueSummary(issues);

  return (
    <header className="topbar">
      <div className="brand">
        <Tip
          label={railOpen ? 'Hide the side panel' : 'Show the side panel'} keys="\"
          hint="People, filters and the list of everything wrong with the plan"
        >
          <button
            className="btn btn--icon btn--ghost" onClick={onToggleRail}
            aria-label={railOpen ? 'Hide filters panel' : 'Show filters panel'}
            aria-expanded={railOpen}
          >
            <IconMenu />
          </button>
        </Tip>
        <Tip label="All my trips" hint="Leave this plan and go back to the library. Everything is saved as you go.">
          <button
            className="btn btn--icon btn--ghost" onClick={onExit}
            aria-label="Back to all my trips"
          >
            <IconLeft />
          </button>
        </Tip>
        <span className="brand__mark" aria-hidden="true">P</span>
        <span style={{ minWidth: 0 }}>
          <h1 className="brand__name">{trip.name}</h1>
          <p className="brand__sub">{trip.subtitle}</p>
        </span>
      </div>

      <div className="switcher" role="tablist" aria-label="View">
        {VIEWS.map(({ id, label, hint, adds, Icon }, i) => (
          <Tip key={id} label={`${label} view`} keys={String(i + 1)} hint={`${hint}. Add: ${adds.toLowerCase()}.`}>
            <button
              role="tab"
              className="switcher__btn"
              aria-selected={view === id}
              aria-controls="view-panel"
              id={`tab-${id}`}
              tabIndex={view === id ? 0 : -1}
              onClick={() => onView(id)}
              onKeyDown={(e) => {
                const idx = VIEWS.findIndex((v) => v.id === view);
                if (e.key === 'ArrowRight') { e.preventDefault(); onView(VIEWS[(idx + 1) % VIEWS.length].id); }
                if (e.key === 'ArrowLeft') { e.preventDefault(); onView(VIEWS[(idx - 1 + VIEWS.length) % VIEWS.length].id); }
              }}
            >
              <Icon size={15} />
              <span className="switcher__label">{label}</span>
            </button>
          </Tip>
        ))}
      </div>

      <div className="topbar__right">
        <ClockMenu trip={trip} clock={clock} onClock={onClock} />
        <span className="sr-only" aria-live="polite">Times shown: {clockLabel(clock, trip)}</span>

        <Tip label="What each view is for" hint="A short walkthrough of the eight views and when to reach for each one.">
          <button
            className="btn btn--icon btn--ghost desktop-only" onClick={onOpenTour}
            aria-label="What each view is for"
          >
            <IconSparkle />
          </button>
        </Tip>
        <Tip label="Find any action" keys="⌘K" hint="Search every command, person and block by name.">
          <button
            className="btn btn--icon btn--ghost desktop-only" onClick={onOpenPalette}
            aria-label="Find any action (Cmd K)"
          >
            <IconSearch />
          </button>
        </Tip>
        <Tip label="Undo" keys="⌘Z" hint="Step back through every change to the plan.">
          <button
            className="btn btn--icon btn--ghost desktop-only" onClick={onUndo} disabled={!canUndo}
            aria-label="Undo"
          >
            <IconUndo />
          </button>
        </Tip>
        <Tip label="Redo" keys="⌘⇧Z" hint="Put back a change you just undid.">
          <button
            className="btn btn--icon btn--ghost desktop-only" onClick={onRedo} disabled={!canRedo}
            aria-label="Redo"
          >
            <IconRedo />
          </button>
        </Tip>

        <Tip
          label={s.total === 0 ? 'Nothing wrong with the plan' : `${s.total} to look at`}
          hint={
            s.total === 0
              ? 'Clashes, impossible journeys and people in two places at once all show up here.'
              : `${s.error} blocking, ${s.warning} risky, ${s.info} to consider — opens the list in the side panel.`
          }
        >
          <button
            className="btn btn--icon btn--ghost issue-badge" onClick={onOpenIssues}
            aria-label={`${s.total} issues found: ${s.error} blocking, ${s.warning} risky, ${s.info} suggestions`}
          >
            <IconWarn />
            {s.total > 0 && (
              <span className="issue-badge__count" data-sev={s.error ? 'error' : 'warning'}>
                {s.error || s.warning || s.info}
              </span>
            )}
          </button>
        </Tip>

        <Tip
          label={`Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`}
          hint="Both themes are contrast-checked; pick whichever reads better where you are."
        >
          <button className="btn btn--icon btn--ghost" onClick={onTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
        </Tip>

        <Tip label="Share this plan" hint="A link that carries the whole plan, a calendar file, a print-out or a JSON backup." side="left">
          <button className="btn btn--primary" onClick={onShare}>
            <IconShare size={15} /> <span className="desktop-only">Share</span>
          </button>
        </Tip>
      </div>
    </header>
  );
}

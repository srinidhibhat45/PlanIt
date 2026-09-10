import type { ReactElement } from 'react';
import type { ClockMode, Trip, ViewId } from '../core/types';
import { clockLabel } from '../core/clock';
import { ClockMenu } from './ClockMenu';
import { issueSummary } from '../core/schedule';
import type { Issue } from '../core/types';
import {
  IconAgenda, IconBoard, IconCanvas, IconDay, IconLeft, IconMap, IconMenu, IconPeople,
  IconRedo, IconSearch, IconShare, IconSparkle, IconSun, IconMoon, IconTimeline, IconUndo,
  IconWarn, IconWeek,
} from './Icons';

export const VIEWS: { id: ViewId; label: string; Icon: (p: { size?: number }) => ReactElement }[] = [
  { id: 'canvas', label: 'Canvas', Icon: IconCanvas },
  { id: 'timeline', label: 'Timeline', Icon: IconTimeline },
  { id: 'day', label: 'Day', Icon: IconDay },
  { id: 'week', label: 'Trip', Icon: IconWeek },
  { id: 'agenda', label: 'Agenda', Icon: IconAgenda },
  { id: 'map', label: 'Map', Icon: IconMap },
  { id: 'people', label: 'People', Icon: IconPeople },
  { id: 'board', label: 'Ideas', Icon: IconBoard },
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
        <button
          className="btn btn--icon btn--ghost" onClick={onToggleRail}
          title={`${railOpen ? 'Hide' : 'Show'} the people and filters panel · \\`}
          aria-label={railOpen ? 'Hide filters panel' : 'Show filters panel'}
          aria-expanded={railOpen}
        >
          <IconMenu />
        </button>
        <button
          className="btn btn--icon btn--ghost" onClick={onExit}
          aria-label="Back to all my trips" title="All my trips"
        >
          <IconLeft />
        </button>
        <span className="brand__mark" aria-hidden="true">P</span>
        <span style={{ minWidth: 0 }}>
          <h1 className="brand__name">{trip.name}</h1>
          <p className="brand__sub">{trip.subtitle}</p>
        </span>
      </div>

      <div className="switcher" role="tablist" aria-label="View">
        {VIEWS.map(({ id, label, Icon }) => (
          <button
            key={id}
            role="tab"
            className="switcher__btn"
            aria-selected={view === id}
            aria-controls="view-panel"
            id={`tab-${id}`}
            tabIndex={view === id ? 0 : -1}
            onClick={() => onView(id)}
            onKeyDown={(e) => {
              const i = VIEWS.findIndex((v) => v.id === view);
              if (e.key === 'ArrowRight') { e.preventDefault(); onView(VIEWS[(i + 1) % VIEWS.length].id); }
              if (e.key === 'ArrowLeft') { e.preventDefault(); onView(VIEWS[(i - 1 + VIEWS.length) % VIEWS.length].id); }
            }}
          >
            <Icon size={15} />
            <span className="switcher__label">{label}</span>
          </button>
        ))}
      </div>

      <div className="topbar__right">
        <ClockMenu trip={trip} clock={clock} onClock={onClock} />
        <span className="sr-only" aria-live="polite">Times shown: {clockLabel(clock, trip)}</span>

        <button
          className="btn btn--icon btn--ghost desktop-only" onClick={onOpenTour}
          aria-label="What each view is for" title="What each view is for"
        >
          <IconSparkle />
        </button>
        <button
          className="btn btn--icon btn--ghost desktop-only" onClick={onOpenPalette}
          aria-label="Find any action (Cmd K)" title="Find any action  ⌘K"
        >
          <IconSearch />
        </button>
        <button
          className="btn btn--icon btn--ghost desktop-only" onClick={onUndo} disabled={!canUndo}
          title="Undo · ⌘Z" aria-label="Undo"
        >
          <IconUndo />
        </button>
        <button
          className="btn btn--icon btn--ghost desktop-only" onClick={onRedo} disabled={!canRedo}
          title="Redo · ⌘⇧Z" aria-label="Redo"
        >
          <IconRedo />
        </button>

        <button
          className="btn btn--icon btn--ghost issue-badge" onClick={onOpenIssues}
          title={
            s.total === 0
              ? 'Nothing wrong with the plan'
              : `${s.error} blocking, ${s.warning} risky, ${s.info} to consider — open the list`
          }
          aria-label={`${s.total} issues found: ${s.error} blocking, ${s.warning} risky, ${s.info} suggestions`}
        >
          <IconWarn />
          {s.total > 0 && (
            <span className="issue-badge__count" data-sev={s.error ? 'error' : 'warning'}>
              {s.error || s.warning || s.info}
            </span>
          )}
        </button>

        <button className="btn btn--icon btn--ghost" onClick={onTheme}
          title={`Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
          {theme === 'dark' ? <IconSun /> : <IconMoon />}
        </button>

        <button className="btn btn--primary" onClick={onShare}>
          <IconShare size={15} /> <span className="desktop-only">Share</span>
        </button>
      </div>
    </header>
  );
}

/** Left rail: who to show, what to show, and everything the analyser found. */

import { useState } from 'react';
import type { Filters, ID, Issue, SegmentKind, Trip } from '../core/types';
import { KIND_LABEL } from '../core/layout';
import { issueSummary } from '../core/schedule';
import { branchStats } from '../core/branch';
import { zoneAbbr, zoneCity } from '../core/time';
import { initials } from './SegmentChrome';
import { IconChevron, IconSearch } from './Icons';

const ALL_KINDS: SegmentKind[] = ['flight', 'transfer', 'checkin', 'checkout', 'session', 'workshop', 'meal', 'activity', 'free', 'rest', 'buffer', 'note'];

export function Rail({
  trip, filters, issues, focusPersonId, onFilters, onFocusPerson, onSelectSegment, onJumpIssue,
}: {
  trip: Trip; filters: Filters; issues: Issue[]; focusPersonId: ID | null;
  onFilters: (f: Partial<Filters>) => void;
  onFocusPerson: (id: ID | null) => void;
  onSelectSegment: (id: ID) => void;
  onJumpIssue: (i: Issue) => void;
}) {
  const summary = issueSummary(issues);
  const tags = [...new Set(trip.segments.flatMap((s) => s.tags))].sort();

  return (
    <nav className="rail__inner" aria-label="Filters and issues">
      <div className="field">
        <label htmlFor="rail-q" className="sr-only">Search the itinerary</label>
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)', pointerEvents: 'none' }}>
            <IconSearch size={15} />
          </span>
          <input
            id="rail-q" className="input" type="search" placeholder="Search titles, places, tags…"
            style={{ paddingLeft: '2.1rem' }}
            value={filters.query}
            onChange={(e) => onFilters({ query: e.target.value })}
          />
        </div>
      </div>

      <Section title="People" count={trip.people.length} defaultOpen>
        <ul style={{ display: 'grid', gap: 1 }}>
          {trip.people.map((p) => {
            const on = filters.personIds.includes(p.id);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className="person-row"
                  style={{ ['--c' as string]: p.color }}
                  aria-pressed={on}
                  onClick={() => onFilters({
                    personIds: on ? filters.personIds.filter((x) => x !== p.id) : [...filters.personIds, p.id],
                  })}
                >
                  <span className="avatar avatar--sm" style={{ ['--c' as string]: p.color }} aria-hidden="true">{initials(p.name)}</span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="person-row__name truncate">{p.name}</span><span className="person-row__meta">
                      {zoneCity(p.homeTimezone)} · {zoneAbbr(Date.now(), p.homeTimezone)}
                    </span>
                  </span>
                  <span className="person-row__dot" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
        <div className="row" style={{ marginTop: 'var(--s-2)' }}>
          <button className="btn btn--sm btn--ghost" onClick={() => onFilters({ personIds: [] })}
            disabled={filters.personIds.length === 0}>
            Clear
          </button>
          <button className="btn btn--sm btn--ghost"
            aria-pressed={!!focusPersonId}
            onClick={() => onFocusPerson(focusPersonId ? null : (filters.personIds[0] ?? trip.people[0]?.id ?? null))}>
            {focusPersonId ? `Solo: ${trip.people.find((p) => p.id === focusPersonId)?.name.split(' ')[0]}` : 'Solo view'}
          </button>
        </div>
      </Section>

      <Section title="Groups" count={trip.groups.length}>
        <ul style={{ display: 'grid', gap: 1 }}>
          {trip.groups.map((g) => {
            const on = filters.groupIds.includes(g.id);
            return (
              <li key={g.id}>
                <button
                  type="button" className="person-row" style={{ ['--c' as string]: g.color }} aria-pressed={on}
                  onClick={() => onFilters({
                    groupIds: on ? filters.groupIds.filter((x) => x !== g.id) : [...filters.groupIds, g.id],
                  })}
                >
                  <span className="person-row__dot" aria-hidden="true" />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="person-row__name truncate">{g.name}</span><span className="person-row__meta">{g.kind} · {g.memberIds.length} people</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Section>

      {trip.branches.length > 0 && (
        <Section title="Sub-trips" count={trip.branches.length} defaultOpen>
          <ul style={{ display: 'grid', gap: 1 }}>
            {/* The main line is a filter option in its own right: "show me only
                what the whole group is doing" is the other half of "show me
                only the beach group". */}
            {[{ id: 'main', name: 'Main timeline', color: 'var(--ink-3)', memberIds: trip.people.map((p) => p.id) },
              ...trip.branches].map((b) => {
              const on = filters.branchIds.includes(b.id);
              const stats = b.id === 'main'
                ? { members: trip.people.length, segments: trip.segments.filter((s) => !s.branchId).length }
                : branchStats(trip, trip.branches.find((x) => x.id === b.id)!);
              return (
                <li key={b.id}>
                  <button
                    type="button" className="person-row" style={{ ['--c' as string]: b.color }} aria-pressed={on}
                    onClick={() => onFilters({
                      branchIds: on
                        ? filters.branchIds.filter((x) => x !== b.id)
                        : [...filters.branchIds, b.id],
                    })}
                  >
                    <span className="person-row__dot" aria-hidden="true" />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="person-row__name truncate">{b.name}</span>
                      <span className="person-row__meta">
                        {stats.members} {stats.members === 1 ? 'person' : 'people'} · {stats.segments} blocks
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      <Section title="Type" count={filters.kinds.length || undefined}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          {ALL_KINDS.map((k) => {
            const on = filters.kinds.includes(k);
            const n = trip.segments.filter((s) => s.kind === k).length;
            if (n === 0) return null;
            return (
              <button
                key={k} type="button" className="chip" aria-pressed={on}
                data-kind={k}
                style={on ? { background: 'var(--c)', color: 'var(--ink-invert)', borderColor: 'var(--c)' } : undefined}
                onClick={() => onFilters({ kinds: on ? filters.kinds.filter((x) => x !== k) : [...filters.kinds, k] })}
              >
                {KIND_LABEL[k]} <span style={{ opacity: 0.65 }}>{n}</span>
              </button>
            );
          })}
        </div>
      </Section>

      {tags.length > 0 && (
        <Section title="Tags" count={filters.tags.length || undefined}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
            {tags.map((t) => {
              const on = filters.tags.includes(t);
              return (
                <button key={t} type="button" className="chip" aria-pressed={on}
                  style={on ? { background: 'var(--brand-soft)', borderColor: 'var(--brand-line)', color: 'var(--brand-ink)' } : undefined}
                  onClick={() => onFilters({ tags: on ? filters.tags.filter((x) => x !== t) : [...filters.tags, t] })}>
                  #{t}
                </button>
              );
            })}
          </div>
        </Section>
      )}

      <Section
        title="Issues"
        count={summary.total}
        badge={summary.error > 0 ? 'danger' : summary.warning > 0 ? 'warn' : 'ok'}
        defaultOpen
      >
        {issues.length === 0 ? (
          <p style={{ fontSize: 'var(--step--1)', color: 'var(--ok-ink)' }}>
            No clashes, no impossible journeys. The plan holds together.
          </p>
        ) : (
          <>
            <div className="row" style={{ gap: 4, marginBottom: 'var(--s-2)' }}>
              {summary.error > 0 && <span className="chip chip--danger">{summary.error} blocking</span>}
              {summary.warning > 0 && <span className="chip chip--warn">{summary.warning} risky</span>}
              {summary.info > 0 && <span className="chip chip--accent">{summary.info} to consider</span>}
            </div>
            <ul className="issues">
              {issues.slice(0, 40).map((i) => (
                <li key={i.id}>
                  <button
                    type="button" className="issue" data-sev={i.severity}
                    onClick={() => { onJumpIssue(i); if (i.segmentIds[0]) onSelectSegment(i.segmentIds[0]); }}
                  >
                    <span className="issue__dot" aria-hidden="true" />
                    <span>
                      <span className="issue__title">{i.title}</span>
                      <br />
                      <span className="issue__detail">{i.detail}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {issues.length > 40 && (
              <p style={{ fontSize: 'var(--step--2)', color: 'var(--ink-3)' }}>
                …and {issues.length - 40} more.
              </p>
            )}
          </>
        )}
      </Section>
    </nav>
  );
}

function Section({
  title, count, children, defaultOpen = false, badge,
}: {
  title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean;
  badge?: 'danger' | 'warn' | 'ok';
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = `sec-${title.toLowerCase()}`;
  return (
    <section className="rail-section">
      <button
        type="button" className="rail-section__head" aria-expanded={open} aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="eyebrow">{title}</span>
        <span className="row" style={{ gap: 4 }}>
          {count !== undefined && count > 0 && (
            <span className={`chip${badge === 'danger' ? ' chip--danger' : badge === 'warn' ? ' chip--warn' : badge === 'ok' ? ' chip--ok' : ''}`}>
              {count}
            </span>
          )}
          <span className="rail-section__chev" aria-hidden="true"><IconChevron size={14} /></span>
        </span>
      </button>
      <div id={id} hidden={!open}>{children}</div>
    </section>
  );
}

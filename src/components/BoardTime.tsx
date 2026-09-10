/** The board's time layer, on screen.
 *
 *  The three pieces that make the clock legible on a whiteboard without
 *  turning it into a calendar. `core/timelayer.ts` works out *what* they say;
 *  this file is only how they look:
 *
 *    · `DayRibbon` — the shape of one day, hanging under its frame
 *    · `GapChip`   — how long the board leaves between two stacked cards
 *    · `TimePop`   — the one place the clock flows back the other way
 *
 *  All three are leaves: props in, nothing shared, no board state.
 */

import type { Epoch, ID, Segment } from '../core/types';
import { MIN, dateKey, fmtDuration, fmtTime, pad } from '../core/time';
import {
  DURATION_PRESETS, compactDuration, describeGap, gapTone, setDuration, setTimeOfDay, shiftBy,
  type DaySummary, type StackGap,
} from '../core/timelayer';
import { IconWarn } from './Icons';

/** The shape of one day, under its frame.
 *
 *  A readout, not a grid: the blocks are where the cards' *times* fall in the
 *  24 hours, which has nothing to do with where the cards sit on the board.
 *  It answers the questions a date alone cannot — when the day starts and
 *  ends, how much of it is spoken for, where the free afternoon is, and
 *  whether anything is double-booked. */
export function DayRibbon({
  summary, zone, onPick,
}: {
  summary: DaySummary; zone: string; onPick: (id: ID) => void;
}) {
  if (!summary.count || summary.first === undefined || summary.last === undefined) return null;
  const free = summary.gapFrom !== undefined && summary.gapTo !== undefined
    ? { from: summary.gapFrom, to: summary.gapTo }
    : null;

  // Deliberately transparent to board gestures: only the blocks below claim
  // the pointer, so panning or marquee-dragging across the strip under a frame
  // still works.
  return (
    <div className="bdr" data-clash={summary.clashes > 0 || undefined}>
      <div className="bdr__row">
        <span className="bdr__span mono">
          {fmtTime(summary.first, { zone })}–{fmtTime(summary.last, { zone })}
          {dateKey(summary.last, zone) !== dateKey(summary.first, zone) && (
            <span className="bdr__plus" title="The day runs past midnight">+1</span>
          )}
        </span>
        <span className="bdr__busy" title="How much of the day has something in it, two things at once counted once">
          {compactDuration(summary.busyMs)} busy
        </span>
        {free && (
          <span className="bdr__free" title="The longest clear stretch inside the day">
            {compactDuration(free.to - free.from)} clear from {fmtTime(free.from, { zone })}
          </span>
        )}
        {summary.clashes > 0 && (
          <span
            className="bdr__flag bdr__flag--clash"
            title="Somebody is in two places at once. Two parallel tracks for two different people do not count."
          >
            <IconWarn size={10} /> {summary.clashes} double-booked
          </span>
        )}
        {summary.offDay > 0 && (
          <span className="bdr__flag bdr__flag--off" title="Sitting in this frame but still timed for another date — resolving moves them here">
            {summary.offDay} on another date
          </span>
        )}
      </div>

      <div className="bdr__track">
        {[6, 12, 18].map((h) => (
          <span key={h} className="bdr__tick" style={{ left: `${(h / 24) * 100}%` }} aria-hidden="true">
            <span className="bdr__ticklabel mono">{pad(h)}</span>
          </span>
        ))}
        {summary.blocks.map((b) => (
          <button
            key={b.id}
            className="bdr__block"
            data-board-item="ribbon-block"
            data-kind={b.kind}
            data-clash={b.clash || undefined}
            data-off={b.offDay || undefined}
            data-wraps={b.wraps || undefined}
            style={{ left: `${b.from * 100}%`, width: `${Math.max(0.7, (b.to - b.from) * 100)}%` }}
            title={
              `${fmtTime(b.start, { zone })}–${fmtTime(b.end, { zone })} · ${b.title}` +
              `${b.clash ? ' · overlaps something else' : ''}` +
              `${b.wraps ? ' · runs past midnight' : ''}` +
              `${b.offDay ? ' · currently timed for another date' : ''}`
            }
            onClick={() => onPick(b.id)}
          >
            <span className="sr-only">
              {b.title}, {fmtTime(b.start, { zone })} to {fmtTime(b.end, { zone })}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** What the board is leaving between two cards stacked in one column.
 *
 *  The stack already says *after*; this says *how long after*, which is the
 *  thing you cannot get from a date. It reads the same columns the resolver
 *  reads, so a chip saying "20 m" is a promise about what resolving will do.
 *  Decorative for a screen reader — both cards already announce their own
 *  start and end. */
export function GapChip({ gap }: { gap: StackGap }) {
  return (
    <div
      className="bdg" data-tone={gapTone(gap)}
      style={{ left: gap.at.x, top: gap.at.y }}
      aria-hidden="true"
    >
      {describeGap(gap)}
    </div>
  );
}

/** Setting a time without leaving the board.
 *
 *  The one place the clock flows back the other way. It edits the *card*, not
 *  the board: the time is read and written in whatever zone the board is being
 *  shown in, the date never moves, and nothing about the arrangement changes.
 *  A card whose time you typed here is still framed and still stacked, so
 *  resolving can still push it later — pin it if that is not what you want. */
export function TimePop({
  seg, zone, offDay, onSet, onClose,
}: {
  seg: Segment; zone: string; offDay: boolean;
  onSet: (start: Epoch, end: Epoch) => void;
  onClose: () => void;
}) {
  const minutes = Math.round((seg.end - seg.start) / MIN);
  const lengths = DURATION_PRESETS.includes(minutes as (typeof DURATION_PRESETS)[number])
    ? [...DURATION_PRESETS]
    : [...DURATION_PRESETS, minutes].sort((a, b) => a - b);

  const commit = (t: { start: Epoch; end: Epoch }) => onSet(t.start, t.end);

  return (
    <div
      className="bdt"
      role="group"
      aria-label={`Time for ${seg.title}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.stopPropagation(); onClose(); } }}
    >
      <div className="bdt__row">
        <label className="bdt__label" htmlFor={`bdt-s-${seg.id}`}>Starts</label>
        <input
          id={`bdt-s-${seg.id}`} className="bdt__in mono" type="time" step={300}
          value={fmtTime(seg.start, { zone })} autoFocus
          onChange={(e) => { if (e.target.value) commit(setTimeOfDay(seg, e.target.value, zone)); }}
        />
      </div>
      <div className="bdt__row">
        <label className="bdt__label" htmlFor={`bdt-d-${seg.id}`}>Lasts</label>
        <select
          id={`bdt-d-${seg.id}`} className="bdt__in"
          value={minutes}
          onChange={(e) => commit(setDuration(seg, Number(e.target.value)))}
        >
          {lengths.map((m) => <option key={m} value={m}>{fmtDuration(m * MIN)}</option>)}
        </select>
      </div>
      <div className="bdt__row bdt__row--acts">
        <button className="bdt__nudge mono" onClick={() => commit(shiftBy(seg, -15))} title="Fifteen minutes earlier">
          −15
        </button>
        <button className="bdt__nudge mono" onClick={() => commit(shiftBy(seg, 15))} title="Fifteen minutes later">
          +15
        </button>
        <span className="grow" />
        <span className="bdt__end mono">ends {fmtTime(seg.end, { zone })}</span>
      </div>
      {offDay && (
        <p className="bdt__note">
          This card is in a frame for another day. Resolve moves it there and keeps this time of day.
        </p>
      )}
    </div>
  );
}

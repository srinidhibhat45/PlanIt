/** First-run walkthrough.
 *
 *  The app puts seven views, a filter rail, an analyser and a details panel on
 *  screen at once. That is a lot to meet cold, so this explains the shape of
 *  the job before the shape of the UI: what you are looking at, the four steps
 *  you actually take, and then one card per view — each of which switches the
 *  view behind the dialog so the words have something to point at. */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Trip, ViewId } from '../core/types';
import { useFocusTrap } from '../hooks/useUi';
import { IconClose } from './Icons';
import { VIEWS } from './TopBar';

export const TOUR_SEEN_KEY = 'planit.tour.v1';

export function hasSeenTour(): boolean {
  try { return localStorage.getItem(TOUR_SEEN_KEY) === '1'; } catch { return false; }
}
export function markTourSeen() {
  try { localStorage.setItem(TOUR_SEEN_KEY, '1'); } catch { /* private mode — it just shows again */ }
}

interface Step {
  /** Switching to this view as the step opens is what makes the card concrete. */
  view?: ViewId;
  eyebrow: string;
  title: string;
  body: ReactNode;
}

function steps(trip: Trip): Step[] {
  const n = trip.people.length;
  const days = trip.segments.length
    ? new Set(trip.segments.map((s) => new Date(s.start).toISOString().slice(0, 10))).size
    : 0;

  return [
    {
      eyebrow: 'What this is',
      title: 'One plan for people who are not doing the same thing',
      body: (
        <>
          <p>
            Most planners assume everyone travels together. This one does not. Each person
            has their own arrivals, their own sessions and their own free evenings, and
            PlanIt keeps all of it in a single plan you can look at from any angle.
          </p>
          <p className="tour__note">
            {n === 0
              ? 'This trip is empty. Add the people first — everything else hangs off who is coming. It saves in this browser only, and nothing is sent anywhere.'
              : `You are looking at ${n} ${n === 1 ? 'person' : 'people'} across ${days} ${days === 1 ? 'day' : 'days'}. Change anything you like. It saves in this browser only, and nothing is sent anywhere.`}
          </p>
        </>
      ),
    },
    {
      eyebrow: 'The flow',
      title: 'The order that works',
      body: (
        <ol className="tour__flow">
          <li><span>
            <b>Add who is coming.</b> Open <i>People</i> and put in each traveller, where
            they are coming from and when they can be there.
          </span></li>
          <li><span>
            <b>Sketch it on the board.</b> The <i>Canvas</i> is a whiteboard — arrange
            cards by hand, then <i>Resolve</i> turns the arrangement into a schedule.
          </span></li>
          <li><span>
            <b>Fix what cannot happen.</b> PlanIt reads the plan back to you and flags
            clashes, journeys that do not fit the gap, and people booked before they land.
          </span></li>
          <li><span>
            <b>Fill the empty evenings.</b> Collect suggestions in <i>Ideas</i> and drop one
            onto a day; it finds a slot that works.
          </span></li>
          <li><span>
            <b>Hand it out.</b> A share link, a calendar file, or a printed page — per
            person or for the whole trip.
          </span></li>
        </ol>
      ),
    },
    {
      view: 'canvas',
      eyebrow: 'Step 2 · Plan',
      title: 'Canvas — think here first',
      body: (
        <>
          <p>
            A whiteboard, not a calendar. Put cards anywhere, drag a card’s dot onto another
            to say what follows what, and drop a note or a frame wherever it helps. Nothing
            touches the clock until you ask it to.
          </p>
          <p>
            Position earns its meaning from frames. A card inside a <b>day frame</b> happens
            that day; inside a frame, top to bottom is the order of the day and side by side
            means at the same time. A card inside a <b>sub-trip frame</b> belongs to that
            group.
          </p>
          <p className="tour__note">
            <b>Tidy</b> lays the existing plan out for you — a frame per day, in time order.
            <b> Resolve</b> reads the board back and gives every framed or wired card a
            time, journeys between places costed in. Pin a card to hold its time and let
            everything else schedule around it.
          </p>
        </>
      ),
    },
    {
      view: 'timeline',
      eyebrow: 'Step 1 · See',
      title: 'Timeline — everybody, side by side',
      body: (
        <>
          <p>
            One lane per person, time running left to right. This is the view that answers
            <i> “where is everyone on Thursday evening?”</i> at a glance.
          </p>
          <p>
            Drag a block to move it, drag its edges to change the length, drag it into
            another lane to hand it to someone else. Dashed ribbons between two stops are
            the journey between them, with the time it actually takes in traffic.
          </p>
        </>
      ),
    },
    {
      view: 'day',
      eyebrow: 'Step 1 · See',
      title: 'Day — one day, hour by hour',
      body: (
        <p>
          Hours down the side, a column per person. Use this when the timeline gets crowded
          and you need to know exactly who is where at 14:00 — or to drop a new block onto
          an empty slot by clicking it.
        </p>
      ),
    },
    {
      view: 'week',
      eyebrow: 'Step 1 · See',
      title: 'Trip — the whole thing at arm’s length',
      body: (
        <p>
          Every day as a card. Good for the coarse moves: spotting the day nobody has
          anything planned, or dragging an activity from one day to another. Click a date to
          open it in the day view.
        </p>
      ),
    },
    {
      view: 'agenda',
      eyebrow: 'Step 2 · Check',
      title: 'Agenda — the plan as plain sentences',
      body: (
        <p>
          Every block written out in order, with the journeys between them spelled out. This
          is the version that prints, that a screen reader reads, and that you paste into a
          message. If something looks wrong anywhere else, read it here.
        </p>
      ),
    },
    {
      view: 'map',
      eyebrow: 'Step 2 · Check',
      title: 'Map — how far apart these places really are',
      body: (
        <p>
          Stops numbered in the order they happen, on real roads. A conference venue and a
          hotel can look adjacent on a schedule and be an hour apart at 18:00. Travel times
          here account for the time of day.
        </p>
      ),
    },
    {
      view: 'people',
      eyebrow: 'Step 2 · Check',
      title: 'People — who is here, and how hard their day is',
      body: (
        <p>
          Arrivals, departures, hotel and interests for each person, plus how loaded each of
          their days is. Use <b>Focus on them</b> to strip the whole app down to one person’s
          trip, which is also how you send someone just their own days.
        </p>
      ),
    },
    {
      view: 'board',
      eyebrow: 'Step 3 · Fill',
      title: 'Ideas — things somebody wants to do',
      body: (
        <p>
          A backlog, not a schedule. Add a suggestion, let people register interest, and when
          it earns its place, drop it on a day — PlanIt puts it in a free evening rather than
          on top of something else.
        </p>
      ),
    },
    {
      eyebrow: 'Step 4 · Hand it out',
      title: 'Sharing, and the two shortcuts worth knowing',
      body: (
        <>
          <p>
            <b>Share</b> packs the entire plan into the link itself. There is no server and
            no account — the link works offline and is private to whoever holds it. You can
            make it read-only, or narrow it to one person.
          </p>
          <p className="tour__note">
            <kbd className="palette__kbd">⌘K</kbd> opens a command palette with every action
            by name — it is the fastest way to find anything here.{' '}
            <kbd className="palette__kbd">?</kbd> lists the keyboard shortcuts, including the
            ones for moving blocks without a mouse.
          </p>
        </>
      ),
    },
  ];
}

export function Tour({
  open, trip, onClose, onView,
}: {
  open: boolean;
  trip: Trip;
  onClose: () => void;
  onView: (v: ViewId) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const trapRef = useFocusTrap(open);
  const [i, setI] = useState(0);
  const list = steps(trip);
  const step = list[i];
  const last = i === list.length - 1;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setI(0); d.showModal(); }
    if (!open && d.open) d.close();
  }, [open]);

  /* Each card that names a view brings it up behind the dialog, so the
     description and the thing being described are on screen together. */
  useEffect(() => {
    if (open && step?.view) onView(step.view);
  }, [open, i, step?.view, onView]);

  const finish = () => { markTourSeen(); onClose(); };

  if (!step) return null;

  return (
    <dialog
      ref={ref} className="modal tour" aria-labelledby="tour-title"
      onClose={finish} onCancel={(e) => { e.preventDefault(); finish(); }}
    >
      <div ref={trapRef as React.RefObject<HTMLDivElement>}>
        <header className="modal__head">
          <span className="eyebrow">{step.eyebrow}</span>
          <button className="btn btn--icon btn--ghost" onClick={finish} aria-label="Close the tour">
            <IconClose />
          </button>
        </header>

        <div className="modal__body tour__body">
          <h2 id="tour-title" className="tour__title">{step.title}</h2>
          <div className="tour__prose">{step.body}</div>

          {step.view && (
            <p className="tour__pointer">
              <ViewIcon id={step.view} />
              Showing the <b>{VIEWS.find((v) => v.id === step.view)?.label}</b> view behind
              this box — close the tour any time to try it.
            </p>
          )}
        </div>

        <footer className="modal__foot tour__foot">
          <ol className="tour__dots" aria-label={`Step ${i + 1} of ${list.length}`}>
            {list.map((s, n) => (
              <li key={s.title}>
                <button
                  type="button" className="tour__dot" aria-current={n === i}
                  aria-label={`Step ${n + 1}: ${s.title}`}
                  onClick={() => setI(n)}
                />
              </li>
            ))}
          </ol>
          <span className="grow" />
          <button className="btn btn--ghost" onClick={finish}>
            {last ? 'Close' : 'Skip'}
          </button>
          <button className="btn" onClick={() => setI((v) => Math.max(0, v - 1))} disabled={i === 0}>
            Back
          </button>
          <button
            className="btn btn--primary"
            onClick={() => (last ? finish() : setI((v) => v + 1))}
          >
            {last ? 'Start planning' : 'Next'}
          </button>
        </footer>
      </div>
    </dialog>
  );
}

function ViewIcon({ id }: { id: ViewId }) {
  const V = VIEWS.find((v) => v.id === id)?.Icon;
  return V ? <V size={15} /> : null;
}

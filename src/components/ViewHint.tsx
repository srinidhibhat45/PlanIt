/** One plain sentence under the view bar saying what this view is for.
 *
 *  Seven views that all render the same data need to explain how they differ,
 *  and they need to do it where the choice is made rather than in a manual
 *  nobody opens. Anyone who no longer needs the reminder turns it off once. */

import type { ViewId } from '../core/types';
import { IconClose } from './Icons';

const HINTS: Record<ViewId, { lead: string; rest: string }> = {
  timeline: {
    lead: 'Everyone at once.',
    rest: 'One lane per person, time running left to right. Drag a block to move it, drag its edges to resize, drag it into another lane to reassign it.',
  },
  day: {
    lead: 'One day, hour by hour.',
    rest: 'A column per person. Click an empty slot to add something there.',
  },
  week: {
    lead: 'The whole trip at arm’s length.',
    rest: 'Each card is a day. Drag a block onto another day, or click a date to open it in detail.',
  },
  agenda: {
    lead: 'The plan as plain sentences.',
    rest: 'Every block in order, with the journeys between them. This is the version that prints and that a screen reader reads.',
  },
  map: {
    lead: 'How far apart these places actually are.',
    rest: 'Stops numbered in the order they happen, on real roads, with travel times that account for the time of day.',
  },
  people: {
    lead: 'Who is here and when.',
    rest: 'Arrivals, departures, hotels and how loaded each person’s days are. Focus on someone to strip the app down to their trip alone.',
  },
  board: {
    lead: 'Things somebody wants to do, not yet scheduled.',
    rest: 'Add an idea, let people register interest, then drop it on a day to find it a free slot.',
  },
};

export function ViewHint({
  view, onDismiss,
}: {
  view: ViewId;
  onDismiss: () => void;
}) {
  const hint = HINTS[view];
  if (!hint) return null;

  return (
    <p className="hint">
      <span className="hint__text">
        <b>{hint.lead}</b> <span className="hint__long">{hint.rest}</span>
      </span>
      <span className="hint__actions">
        <button
          className="btn btn--icon btn--sm btn--ghost"
          onClick={onDismiss}
          aria-label="Hide these view descriptions"
          title="Hide these view descriptions"
        >
          <IconClose size={13} />
        </button>
      </span>
    </p>
  );
}

import { useEffect, useRef } from 'react';
import { useFocusTrap } from '../hooks/useUi';
import { IconClose } from './Icons';

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Anywhere',
    rows: [
      ['⌘K / Ctrl K', 'Command palette — every action by name'],
      ['?', 'This help'],
      ['1 – 7', 'Jump to a view'],
      ['⌘Z / ⌘⇧Z', 'Undo / redo'],
      ['/', 'Search the itinerary'],
      ['[ / ]', 'Previous / next day'],
      ['\\', 'Show or hide the filters rail'],
      ['Esc', 'Close whatever is open'],
    ],
  },
  {
    title: 'The board',
    rows: [
      ['V H C N F L', 'Tools: select, pan, card, note, frame, connect'],
      ['Space (held)', 'Pan with any tool'],
      ['⌘A / Ctrl A', 'Select every card'],
      ['← → ↑ ↓', 'Move the selection one grid step'],
      ['⇧ + arrows', 'Fine — four pixels, for lining two cards up'],
      ['⌫ / Del', 'Delete what is selected — cards, a note, a frame, a connector'],
      ['P', 'Pin or unpin the selection'],
      ['T', 'Set the time on the selected card'],
      ['+ / −', 'Zoom in and out'],
      ['0', 'Fit the whole board on screen'],
      ['⌘⏎ / Ctrl ⏎', 'Resolve the board onto the timeline'],
      ['Esc', 'Drop the selection, back to the select tool'],
    ],
  },
  {
    title: 'Timeline and day grid',
    rows: [
      ['Tab', 'Enter the grid'],
      ['← → ↑ ↓', 'Move between blocks'],
      ['Space', 'Pick a block up'],
      ['← →  while held', 'Move it by one snap step'],
      ['⇧ + arrows', 'Fine — 5 minutes'],
      ['⌥ + arrows', 'Coarse — one hour'],
      ['↑ ↓  while held', 'Move it to another person'],
      ['Enter', 'Drop it'],
      ['Esc', 'Put it back'],
      ['Enter (not held)', 'Open the details panel'],
      ['⌘ + scroll', 'Zoom the time axis'],
    ],
  },
  {
    title: 'Trip grid',
    rows: [['⇧ ← / ⇧ →', 'Move a block one day earlier or later']],
  },
];

export function KeyboardHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const trapRef = useFocusTrap(open);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className="modal" aria-labelledby="kb-title" onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div ref={trapRef as React.RefObject<HTMLDivElement>}>
        <header className="modal__head">
          <h2 id="kb-title" style={{ fontSize: 'var(--step-1)' }}>Keyboard</h2>
          <button className="btn btn--icon btn--ghost" onClick={onClose} title="Close · Esc" aria-label="Close"><IconClose /></button>
        </header>
        <div className="modal__body">
          <p style={{ fontSize: 'var(--step--1)', color: 'var(--ink-2)' }}>
            Everything you can do with a pointer, you can do from the keyboard — including
            dragging blocks around the timeline and moving cards about the board, both of
            which are announced as you go. Every icon says what it does, and its key, if you
            rest the pointer on it.
          </p>
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="eyebrow" style={{ marginBottom: 'var(--s-2)' }}>{g.title}</h3>
              <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--s-2) var(--s-4)', margin: 0 }}>
                {g.rows.map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt><kbd className="palette__kbd">{k}</kbd></dt>
                    <dd style={{ margin: 0, fontSize: 'var(--step--1)', color: 'var(--ink-2)' }}>{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <footer className="modal__foot"><button className="btn" onClick={onClose}>Close</button></footer>
      </div>
    </dialog>
  );
}

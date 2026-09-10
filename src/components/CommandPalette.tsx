/** ⌘K. Every action in the app is reachable from here, by name, by keyboard. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from '../hooks/useUi';

export interface Command {
  id: string;
  label: string;
  group: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

export function CommandPalette({
  open, commands, onClose,
}: { open: boolean; commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const trapRef = useFocusTrap(open);
  const listId = 'palette-list';

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands.slice(0, 40);
    const scored = commands
      .map((c) => {
        const hay = `${c.label} ${c.group} ${c.keywords ?? ''}`.toLowerCase();
        const idx = hay.indexOf(needle);
        return { c, score: idx === -1 ? Infinity : idx };
      })
      .filter((x) => x.score !== Infinity)
      .sort((a, b) => a.score - b.score);
    return scored.slice(0, 40).map((x) => x.c);
  }, [q, commands]);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) { d.showModal(); setQ(''); setActive(0); }
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => { setActive(0); }, [q]);

  const grouped = useMemo(() => {
    const m = new Map<string, Command[]>();
    for (const c of results) m.set(c.group, [...(m.get(c.group) ?? []), c]);
    return [...m.entries()];
  }, [results]);

  let flat = 0;

  return (
    <dialog
      ref={dialogRef}
      className="modal palette"
      aria-label="Command palette"
      onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
    >
      <div ref={trapRef as React.RefObject<HTMLDivElement>}>
        <input
          className="palette__input"
          placeholder="Type a command… (try “export”, “Aarti”, “temple”)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
          aria-autocomplete="list"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            if (e.key === 'Enter') { e.preventDefault(); results[active]?.run(); onClose(); }
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
        />
        <ul className="palette__list" id={listId} role="listbox" aria-label="Commands">
          {grouped.map(([group, items]) => (
            <li key={group}>
              <p className="eyebrow palette__group">{group}</p>
              <ul>
                {items.map((c) => {
                  const i = flat++;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        id={`cmd-${c.id}`}
                        role="option"
                        aria-selected={i === active}
                        className="palette__item"
                        onMouseEnter={() => setActive(i)}
                        onClick={() => { c.run(); onClose(); }}
                      >
                        <span>{c.label}</span>
                        {c.hint && <span className="palette__kbd">{c.hint}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
          {results.length === 0 && (
            <li style={{ padding: 'var(--s-4)', color: 'var(--ink-3)' }}>No command matches “{q}”.</li>
          )}
        </ul>
      </div>
    </dialog>
  );
}

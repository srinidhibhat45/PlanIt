/** Share and export. The link carries the whole trip in its fragment, so it
 *  works with no backend; the fragment is never sent to a server. */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ID, Trip } from '../core/types';
import { SHARE_LINK_COMFORTABLE, shareUrl } from '../core/share';
import { exportJson, importJson } from '../core/share';
import { downloadIcs } from '../core/ics';
import { useFocusTrap } from '../hooks/useUi';
import { IconClose, IconDownload, IconLink, IconPrint, IconUpload } from './Icons';

export function ShareDialog({
  open, trip, onClose, onImport, onToast, onCopyText, onPrint,
}: {
  open: boolean; trip: Trip;
  onClose: () => void;
  onImport: (t: Trip) => void;
  onToast: (m: string, tone?: 'ok' | 'danger') => void;
  onCopyText: (personId: ID | null) => string;
  onPrint: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const trapRef = useFocusTrap(open);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [focus, setFocus] = useState<ID | ''>('');
  const [alarm, setAlarm] = useState(30);
  const fileRef = useRef<HTMLInputElement>(null);

  const url = useMemo(
    () => shareUrl(trip, mode, focus || undefined),
    [trip, mode, focus],
  );
  const tooLong = url.length > SHARE_LINK_COMFORTABLE;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast(`${what} copied to the clipboard.`, 'ok');
    } catch {
      onToast('Could not reach the clipboard — select the text and copy it manually.', 'danger');
    }
  };

  return (
    <dialog ref={ref} className="modal" aria-labelledby="share-title" onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div ref={trapRef as React.RefObject<HTMLDivElement>}>
        <header className="modal__head">
          <h2 id="share-title" style={{ fontSize: 'var(--step-1)' }}>Share this plan</h2>
          <button className="btn btn--icon btn--ghost" onClick={onClose} aria-label="Close"><IconClose /></button>
        </header>

        <div className="modal__body">
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ paddingBottom: 'var(--s-2)' }}>Link</legend>
            <div className="row" style={{ marginBottom: 'var(--s-3)' }}>
              <button className="btn btn--sm" aria-pressed={mode === 'view'} onClick={() => setMode('view')}>
                Read only
              </button>
              <button className="btn btn--sm" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>
                Editable copy
              </button>
            </div>

            <div className="field" style={{ marginBottom: 'var(--s-3)' }}>
              <label htmlFor="share-focus">Send just one person’s itinerary</label>
              <select id="share-focus" className="input" value={focus} onChange={(e) => setFocus(e.target.value as ID)}>
                <option value="">Everyone — the full plan</option>
                {trip.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>

            <div className="row">
              <input className="input mono" readOnly value={url} aria-label="Share link"
                onFocus={(e) => e.currentTarget.select()} style={{ fontSize: 'var(--step--2)' }} />
              <button className="btn btn--primary" onClick={() => copy(url, 'Link')}>
                <IconLink size={15} /> Copy
              </button>
            </div>
            <p style={{ fontSize: 'var(--step--2)', color: tooLong ? 'var(--warn-ink)' : 'var(--ink-3)', marginTop: 'var(--s-2)' }}>
              {tooLong
                ? `This link is ${url.length.toLocaleString()} characters — long enough that some chat apps will truncate it. Send the JSON file instead.`
                : `${url.length.toLocaleString()} characters. The whole plan travels inside the link, after the “#”, which browsers never send to a server — so there is nothing to sign in to and nothing stored anywhere.`}
            </p>
          </fieldset>

          <hr className="divider" />

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ paddingBottom: 'var(--s-2)' }}>Calendar</legend>
            <div className="field" style={{ marginBottom: 'var(--s-3)' }}>
              <label htmlFor="share-alarm">Reminder before each item</label>
              <select id="share-alarm" className="input" value={alarm} onChange={(e) => setAlarm(Number(e.target.value))}>
                <option value={0}>No reminder</option>
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={60}>1 hour</option>
                <option value={120}>2 hours</option>
              </select>
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => { downloadIcs(trip, { alarmMin: alarm }); onToast('Calendar file for the whole trip downloaded.', 'ok'); }}>
                <IconDownload size={15} /> Whole trip (.ics)
              </button>
              {focus && (
                <button className="btn" onClick={() => { downloadIcs(trip, { personId: focus, alarmMin: alarm }); onToast('Personal calendar file downloaded.', 'ok'); }}>
                  <IconDownload size={15} /> {trip.people.find((p) => p.id === focus)?.name}’s calendar
                </button>
              )}
            </div>
            <p style={{ fontSize: 'var(--step--2)', color: 'var(--ink-3)', marginTop: 'var(--s-2)' }}>
              Times are written in UTC, so Google Calendar, Outlook and Apple Calendar all show them
              correctly in whatever zone the reader is standing in.
            </p>
          </fieldset>

          <hr className="divider" />

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ paddingBottom: 'var(--s-2)' }}>Other formats</legend>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => copy(onCopyText(focus || null), 'Itinerary text')}>
                Copy as text
              </button>
              <button className="btn" onClick={() => exportJson(trip)}>
                <IconDownload size={15} /> JSON backup
              </button>
              <button className="btn" onClick={() => { onClose(); setTimeout(onPrint, 140); }}>
                <IconPrint size={15} /> Print / PDF
              </button>
              <button className="btn" onClick={() => fileRef.current?.click()}>
                <IconUpload size={15} /> Import JSON
              </button>
              <input
                ref={fileRef} type="file" accept="application/json,.json" className="sr-only"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    onImport(await importJson(f));
                    onToast(`Loaded ${f.name}.`, 'ok');
                    onClose();
                  } catch (err) {
                    onToast(err instanceof Error ? err.message : 'That file could not be read.', 'danger');
                  } finally {
                    e.target.value = '';
                  }
                }}
              />
            </div>
          </fieldset>
        </div>

        <footer className="modal__foot">
          <button className="btn" onClick={onClose}>Done</button>
        </footer>
      </div>
    </dialog>
  );
}

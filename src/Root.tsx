/** Two screens: the library of trips, and one trip open in the planner.
 *
 *  Routing lives in the fragment so the whole app stays a static file:
 *    #/            the library
 *    #/t/<id>      a trip in this browser
 *    #/s/<blob>    somebody else's trip, carried in the link itself
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ID, Trip } from './core/types';
import {
  activeTripId, deleteTrip, duplicateTrip, importLegacyTrip, listTrips, migrate,
  readTrip, reidentify, setActiveTrip, storageWorks, writeTrip, type TripMeta,
} from './core/library';
import { conferenceTrip } from './data/conference';
import { TripsView } from './components/TripsView';
import App from './App';

type Route =
  | { kind: 'library' }
  | { kind: 'trip'; id: ID }
  | { kind: 'share' };

function readRoute(): Route {
  const hash = location.hash;
  if (/^#\/s\//.test(hash)) return { kind: 'share' };
  const t = /^#\/t\/([\w-]+)$/.exec(hash);
  if (t) return { kind: 'trip', id: t[1] };
  return { kind: 'library' };
}

function go(path: string) {
  if (location.hash === path) return;
  location.hash = path;
}

export default function Root() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [trips, setTrips] = useState<TripMeta[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => setTrips(listTrips()), []);

  // A trip saved by the single-trip build is adopted once, silently, so an
  // existing user's plan is where they left it rather than gone.
  useEffect(() => {
    importLegacyTrip();
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onHash = () => { setRoute(readRoute()); refresh(); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [refresh]);

  // Land straight back in whatever was open last, but only from a bare URL —
  // never override a link somebody actually followed.
  useEffect(() => {
    if (location.hash && location.hash !== '#/') return;
    const last = activeTripId();
    if (last && readTrip(last)) go(`#/t/${last}`);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const h = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(h);
  }, [notice]);

  const openTrip = useCallback((id: ID) => { setActiveTrip(id); go(`#/t/${id}`); }, []);

  /** A plan that arrived in a link becomes a trip of this browser's own:
   *  written to the library under fresh ids, made active, and opened at its
   *  own address so a reload lands back on it. */
  const adopt = useCallback((trip: Trip) => {
    const owned = adoptSharedTrip(trip);
    refresh();
    go(`#/t/${owned.id}`);
    if (!storageWorks()) {
      setNotice('This browser is not letting the page store anything — a private window, or site data blocked. '
        + 'The copy is open, but it will not be here after a reload. Export a JSON backup from Share.');
    }
  }, [refresh]);

  const create = useCallback((trip: Trip) => {
    writeTrip(trip);
    refresh();
    openTrip(trip.id);
  }, [refresh, openTrip]);

  const loadExample = useCallback(() => {
    // A fresh identity every time, so opening the example twice gives two
    // independent trips rather than one that overwrites the other.
    const trip = reidentify(conferenceTrip());
    writeTrip(trip);
    refresh();
    openTrip(trip.id);
  }, [refresh, openTrip]);

  const importFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Trip;
      if (!Array.isArray(parsed?.segments)) throw new Error('not a trip');
      const trip = reidentify(migrate(parsed));
      writeTrip(trip);
      refresh();
      openTrip(trip.id);
    } catch {
      setNotice('That file is not a PlanIt trip. Export one from the share dialog to see the shape it expects.');
    }
  }, [refresh, openTrip]);

  const initial = useMemo(() => {
    if (route.kind === 'trip') return readTrip(route.id);
    return null;
  }, [route]);

  if (route.kind === 'share') {
    return <App tripId={null} initialTrip={null} onExit={() => go('#/')} onSaved={refresh} onAdopt={adopt} />;
  }

  if (route.kind === 'trip') {
    if (!initial) {
      // The id in the URL is stale — a deleted trip, or another browser's link.
      return (
        <div className="library">
          <div className="library__body">
            <div className="library__empty">
              <h2 className="library__emptytitle">That trip is not in this browser</h2>
              <p className="library__emptybody">
                Trips are stored on the device that made them. If somebody sent you this link,
                ask them for a share link instead — those carry the plan inside the URL.
              </p>
              <button className="btn btn--primary" onClick={() => go('#/')}>Back to my trips</button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <App
        key={initial.id}
        tripId={initial.id}
        initialTrip={initial}
        onExit={() => { setActiveTrip(null); go('#/'); }}
        onSaved={refresh}
        onAdopt={adopt}
      />
    );
  }

  return (
    <>
      <TripsView
        trips={trips}
        onOpen={openTrip}
        onCreate={create}
        onDuplicate={(id) => { const copy = duplicateTrip(id); refresh(); if (copy) openTrip(copy.id); }}
        onDelete={(id) => { deleteTrip(id); refresh(); }}
        onLoadExample={loadExample}
        onImport={importFile}
      />
      {notice && (
        <div className="toasts">
          <div className="toast" data-tone="warn" role="status">
            <span className="grow">{notice}</span>
            <button className="btn btn--sm btn--ghost" onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        </div>
      )}
    </>
  );
}

/** Shared by the share flow: a link's trip is adopted into the library the
 *  moment someone chooses to edit it, so it stops living only in a URL. */
export function adoptSharedTrip(trip: Trip): Trip {
  const owned = reidentify(trip);
  writeTrip(owned);
  setActiveTrip(owned.id);
  return owned;
}

/** Geography: where everything is, and how long it actually takes to get
 *  between the stops on a given day.
 *
 *  Routes come from OSRM when the network allows, which gives real road
 *  geometry and a free-flow duration; the congestion model is then applied on
 *  top for the departure time in question. If OSRM is unreachable the straight
 *  line and the offline estimate are used, and the card says so. */

import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import type { ClockMode, ID, Place, Segment, Trip } from '../core/types';
import { MIN, dateKey, dateKeyToEpoch, fmtDate, fmtDuration, fmtTime } from '../core/time';
import { attendeesOf } from '../core/schedule';
import { estimateTravel, greatCircle, overheadMinutes, routeVia, trafficLabel, travelMinutes } from '../core/travel';
import { axisZone } from '../core/clock';
import { iconFor } from '../core/ics';
import { IconPlus, IconTrash } from './Icons';
import { Tip } from './Tooltip';

const KIND_COLOR: Record<string, string> = {
  airport: '#4cc9f0', hotel: '#9d8cff', venue: '#ff6b35', restaurant: '#ffb020',
  bar: '#2dd4a7', temple: '#ff9f1c', landmark: '#14d4c4', transit: '#8a93ab',
  office: '#ff3b8e', other: '#b0b8cc',
};

interface Hop {
  key: string;
  from: Place; to: Place;
  departAt: number;
  needMin: number;
  distanceKm: number;
  factor: number;
  source: 'estimate' | 'osrm';
  geometry: [number, number][];
  personColor: string;
}

export function MapView({
  trip, segments, clock, dayKey, focusPersonId, selectedId, onSelect, onAddStop, onRemoveStop,
}: {
  trip: Trip; segments: Segment[]; clock: ClockMode; dayKey: string | null;
  focusPersonId: ID | null; selectedId: ID | null; onSelect: (id: ID) => void;
  /** The map is a view of the plan, not a read-out of it: a day with a hole in
   *  it should be fixable from here. Absent on a read-only share link. */
  onAddStop?: () => void;
  onRemoveStop?: (id: ID) => void;
}) {
  const zone = axisZone(clock, trip);
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const [hops, setHops] = useState<Hop[]>([]);
  const [live, setLive] = useState<'pending' | 'osrm' | 'offline'>('pending');

  /* which segments are on screen */
  const visible = useMemo(() => {
    let list = segments;
    if (dayKey) list = list.filter((s) => dateKey(s.start, zone) === dayKey);
    if (focusPersonId) list = list.filter((s) => attendeesOf(s, trip).includes(focusPersonId));
    return list.sort((a, b) => a.start - b.start);
  }, [segments, dayKey, focusPersonId, zone, trip]);

  const stops = useMemo(() => {
    const out: { seg: Segment; place: Place }[] = [];
    for (const s of visible) {
      const id = s.placeId ?? s.toPlaceId ?? s.fromPlaceId;
      const p = trip.places.find((x) => x.id === id);
      if (p && out[out.length - 1]?.place.id !== p.id) out.push({ seg: s, place: p });
    }
    return out;
  }, [visible, trip.places]);

  /* ---- build the map once ---- */
  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = L.map(hostRef.current, {
      zoomControl: true,
      attributionControl: true,
      preferCanvas: true,
    }).setView([12.97, 77.6], 12);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // Leaflet needs a nudge when it is created inside a flex/grid parent.
    setTimeout(() => map.invalidateSize(), 60);
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  /* ---- resolve routes ---- */
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();

    (async () => {
      const built: Hop[] = [];
      let anyLive = false;

      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i];
        const b = stops[i + 1];
        if (a.place.id === b.place.id) continue;

        const mode = a.place.kind === 'airport' && b.place.kind === 'airport' ? 'plane' : 'taxi';
        const est = estimateTravel({ from: a.place, to: b.place, mode, departAt: a.seg.end });
        const person = focusPersonId
          ? trip.people.find((p) => p.id === focusPersonId)
          : trip.people.find((p) => attendeesOf(a.seg, trip).includes(p.id));

        let geometry: [number, number][] = [[a.place.lat, a.place.lon], [b.place.lat, b.place.lon]];
        let distanceKm = est.distanceKm;
        let baseMin = est.baseMin;
        let source: 'estimate' | 'osrm' = 'estimate';

        if (mode === 'plane') {
          geometry = greatCircle(a.place, b.place);
        } else {
          const r = await routeVia(a.place, b.place, 'car', ac.signal);
          if (r && r.geometry.length > 1) {
            geometry = r.geometry;
            distanceKm = r.distanceKm;
            baseMin = r.baseMin;
            source = 'osrm';
            anyLive = true;
          }
        }

        built.push({
          key: `${a.seg.id}-${b.seg.id}`,
          from: a.place, to: b.place,
          departAt: a.seg.end,
          needMin: Math.round(baseMin * est.trafficFactor) + (mode === 'plane' ? 0 : overheadMinutes('taxi', a.place.kind, b.place.kind)),
          distanceKm, factor: est.trafficFactor, source, geometry,
          personColor: person?.color ?? 'var(--brand)',
        });
      }

      if (!cancelled) {
        setHops(built);
        setLive(built.length === 0 ? 'pending' : anyLive ? 'osrm' : 'offline');
      }
    })();

    return () => { cancelled = true; ac.abort(); };
  }, [stops, trip, focusPersonId]);

  /* ---- draw ---- */
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    const shown = dayKey || focusPersonId
      ? trip.places.filter((p) => stops.some((s) => s.place.id === p.id))
      : trip.places;

    for (const p of shown) {
      const isStop = stops.some((s) => s.place.id === p.id);
      const order = stops.findIndex((s) => s.place.id === p.id);
      const icon = L.divIcon({
        className: '',
        html: `<div class="map-pin" style="--c:${KIND_COLOR[p.kind] ?? '#b0b8cc'}"><span>${isStop && order >= 0 ? order + 1 : ''}</span></div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 24],
      });
      const segsHere = visible.filter((s) => s.placeId === p.id || s.toPlaceId === p.id);
      const marker = L.marker([p.lat, p.lon], { icon, keyboard: true, title: p.name }).addTo(layer);
      marker.bindPopup(
        `<strong>${escapeHtml(p.name)}</strong><br>` +
        `<span style="opacity:.7">${escapeHtml(p.kind)}${p.address ? ` · ${escapeHtml(p.address)}` : ''}</span>` +
        (segsHere.length
          ? `<hr style="border:0;border-top:1px solid rgba(128,128,128,.3);margin:.5rem 0">` +
            segsHere.map((s) => `${iconFor(s)} ${fmtTime(s.start, { zone })} ${escapeHtml(s.title)}`).join('<br>')
          : ''),
      );
      if (segsHere[0]) marker.on('click', () => onSelect(segsHere[0].id));
    }

    for (const h of hops) {
      const isFlight = h.from.kind === 'airport' && h.to.kind === 'airport';
      L.polyline(h.geometry, {
        color: h.personColor,
        weight: isFlight ? 2 : 4,
        opacity: 0.9,
        dashArray: isFlight ? '6 8' : h.source === 'estimate' ? '10 6' : undefined,
        lineCap: 'round',
      })
        .bindTooltip(
          `${h.from.name} → ${h.to.name}<br>${h.needMin} min · ${h.distanceKm} km · ${trafficLabel(h.factor).text}` +
          `<br><small>${h.source === 'osrm' ? 'road route' : 'straight-line estimate'}</small>`,
          { sticky: true },
        )
        .addTo(layer);
    }

    const pts = shown.map((p) => [p.lat, p.lon] as [number, number]);
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.18), { animate: false });
    else if (pts.length === 1) map.setView(pts[0], 14, { animate: false });
  }, [hops, stops, trip.places, visible, dayKey, focusPersonId, zone, onSelect]);

  /* pan to whatever is selected elsewhere in the app */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedId) return;
    const seg = segments.find((s) => s.id === selectedId);
    const place = trip.places.find((p) => p.id === (seg?.placeId ?? seg?.toPlaceId ?? seg?.fromPlaceId));
    if (place) map.panTo([place.lat, place.lon], { animate: true, duration: 0.4 });
  }, [selectedId, segments, trip.places]);

  const totalMin = hops.reduce((a, h) => a + h.needMin, 0);
  const totalKm = Math.round(hops.reduce((a, h) => a + h.distanceKm, 0));
  const dayName = dayKey ? fmtDate(dateKeyToEpoch(dayKey, zone), zone, 'medium') : '';

  return (
    <div className="mapwrap">
      <div ref={hostRef} style={{ height: '100%' }} role="application" aria-label="Map of the itinerary" />

      <div className="map-overlay">
        <div className="map-route-card">
          <strong style={{ fontSize: 'var(--step--1)' }}>
            {focusPersonId ? trip.people.find((p) => p.id === focusPersonId)?.name : 'All stops'}
            {dayName ? ` · ${dayName}` : ''}
          </strong>
          <span className="mono">
            {stops.length} {stops.length === 1 ? 'stop' : 'stops'}
            {hops.length > 0 ? ` · ${totalKm} km · ${fmtDuration(totalMin * MIN)} moving` : ''}
          </span>
          <span style={{ color: 'var(--ink-3)' }}>
            {live === 'osrm' ? 'Road routes from OSRM, traffic modelled for departure time.'
              : live === 'offline' ? 'Routing unavailable — straight-line estimates shown.'
              : 'No journeys to route.'}
          </span>

          {/* The stops in order, each one removable. A map you can only read
              sends you back to another view to change what it is showing. */}
          {stops.length > 0 && (
            <ol className="map-stops">
              {stops.map((s, i) => (
                <li key={s.seg.id} className="map-stop" data-active={s.seg.id === selectedId}>
                  <Tip
                    label={s.seg.title}
                    hint={`${fmtTime(s.seg.start, { zone })} at ${s.place.name}. Click to open its details and centre the map on it.`}
                    side="left"
                  >
                    <button type="button" className="map-stop__go" onClick={() => onSelect(s.seg.id)}>
                      <span className="map-stop__n">{i + 1}</span>
                      <span className="map-stop__name">{s.seg.title}</span>
                      <span className="mono map-stop__t">{fmtTime(s.seg.start, { zone })}</span>
                    </button>
                  </Tip>
                  {onRemoveStop && (
                    <Tip
                      label="Remove this stop" keys="⌫"
                      hint={`Takes “${s.seg.title}” out of the plan, and the journeys either side of it off the map.`}
                      side="left"
                    >
                      <button
                        type="button" className="map-stop__del"
                        onClick={() => onRemoveStop(s.seg.id)}
                        aria-label={`Remove ${s.seg.title} from the trip`}
                      >
                        <IconTrash size={13} />
                      </button>
                    </Tip>
                  )}
                </li>
              ))}
            </ol>
          )}

          {/* When there is nothing here at all, the card in the middle of the
              map is the one making this offer — two Add buttons on one screen
              is a choice nobody has. */}
          {onAddStop && stops.length > 0 && (
            <Tip
              label={dayName ? `Add a stop on ${dayName}` : 'Add a stop'}
              hint="Drops a new block on this day and opens its details, where you can search for the place it happens at."
              side="left"
            >
              <button type="button" className="btn btn--sm btn--primary" onClick={onAddStop}>
                <IconPlus size={13} /> Add a stop
              </button>
            </Tip>
          )}
        </div>
      </div>

      <div className="map-legend">
        <p className="eyebrow">Legend</p>
        {Object.entries(KIND_COLOR).slice(0, 7).map(([k, c]) => (
          <span key={k} className="row" style={{ fontSize: 'var(--step--2)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: c, flex: 'none' }} aria-hidden="true" />
            {k}
          </span>
        ))}
        <span className="row" style={{ fontSize: 'var(--step--2)', color: 'var(--ink-3)' }}>
          <span style={{ width: 18, borderTop: '2px dashed currentColor', flex: 'none' }} aria-hidden="true" />
          estimate
        </span>
      </div>

      {/* The accessible equivalent of the map: an ordered list of stops. */}
      <div className="sr-only">
        <h2>Stops in order</h2>
        <ol>
          {stops.map((s, i) => {
            const hop = hops[i];
            return (
              <li key={s.seg.id}>
                {fmtTime(s.seg.start, { zone })} {s.seg.title} at {s.place.name}
                {hop ? `. Then ${hop.needMin} minutes to ${hop.to.name}, ${hop.distanceKm} kilometres, ${trafficLabel(hop.factor).text}.` : '.'}
              </li>
            );
          })}
        </ol>
      </div>

      {stops.length === 0 && (
        <div className="map-overlay map-overlay--middle">
          <div className="map-route-card">
            <strong>Nothing mapped for this day</strong>
            <span style={{ color: 'var(--ink-3)' }}>
              A block appears here once it has a place. Add one, then set its place in the
              details panel.
            </span>
            {onAddStop && (
              <Tip
                label={dayName ? `Add a stop on ${dayName}` : 'Add a stop'}
                hint="Drops a new block on this day and opens its details, where you can search for the place it happens at."
              >
                <button type="button" className="btn btn--sm btn--primary" onClick={onAddStop}>
                  <IconPlus size={13} /> Add a stop
                </button>
              </Tip>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

export function segmentTravelSummary(seg: Segment, trip: Trip): string | null {
  const from = trip.places.find((p) => p.id === seg.fromPlaceId);
  const to = trip.places.find((p) => p.id === seg.toPlaceId);
  if (!from || !to) return null;
  const est = estimateTravel({ from, to, mode: seg.travel?.mode ?? 'taxi', departAt: seg.start });
  return `${est.distanceKm} km · ~${travelMinutes(est)} min · ${trafficLabel(est.trafficFactor).text}`;
}

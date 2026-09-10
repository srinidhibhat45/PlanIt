/** Distance, routing and a time-of-day traffic model.
 *
 *  Two layers:
 *   1. `estimateTravel` — instant, offline, deterministic. Haversine distance
 *      inflated by a road-circuity factor, divided by a mode speed, then
 *      multiplied by a congestion curve calibrated per metro area.
 *   2. `routeVia` — asks a real routing service (OSRM) for road geometry and
 *      free-flow duration, then applies the same congestion curve on top.
 *
 *  Layer 2 upgrades layer 1 in place when the network answers; the UI always
 *  labels which one produced a number, so nobody mistakes a model for a
 *  live traffic feed. */

import type { Epoch, Place, TravelMode, TravelDetail, Zone } from './types';
import { toParts } from './time';

const EARTH_KM = 6371.0088;

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Straight-line distance under-reads road distance. Circuity rises for short
 *  urban hops (one-ways, rivers) and falls on long inter-city runs. */
function circuity(km: number): number {
  if (km < 2) return 1.45;
  if (km < 8) return 1.35;
  if (km < 25) return 1.28;
  if (km < 100) return 1.2;
  return 1.12;
}

/** Free-flow speeds in km/h. */
const SPEED: Record<TravelMode, (km: number) => number> = {
  walk: () => 4.6,
  car: (km) => (km < 5 ? 24 : km < 20 ? 34 : km < 80 ? 55 : 78),
  taxi: (km) => (km < 5 ? 22 : km < 20 ? 32 : km < 80 ? 52 : 75),
  transit: (km) => (km < 5 ? 14 : km < 20 ? 24 : km < 80 ? 40 : 62),
  train: (km) => (km < 50 ? 55 : 95),
  ferry: () => 30,
  plane: (km) => (km < 800 ? 480 : 780),
};

/** How badly a metro jams at peak. 1.0 = free-flowing at all hours. */
export interface TrafficProfile {
  /** Multiplier at the worst point of the day. */
  peak: number;
  /** Multiplier during the daytime inter-peak trough. */
  midday: number;
  /** Morning and evening peak centres, in local hours. */
  amPeak: number;
  pmPeak: number;
  /** How wide each peak is, in hours. */
  spread: number;
  /** Weekend multiplier applied to the *excess* over free flow. */
  weekend: number;
  label: string;
}

const DEFAULT_PROFILE: TrafficProfile = {
  peak: 1.55, midday: 1.15, amPeak: 8.75, pmPeak: 18, spread: 2.1, weekend: 0.6,
  label: 'Generic urban',
};

/** Calibrated from typical published congestion indices. Keyed by IANA zone,
 *  with a city override list for zones that cover very different metros. */
export const TRAFFIC_PROFILES: Record<string, TrafficProfile> = {
  'Asia/Kolkata:delhi':   { peak: 2.05, midday: 1.35, amPeak: 9.25, pmPeak: 18.5, spread: 2.4, weekend: 0.55, label: 'Delhi NCR — severe' },
  'Asia/Kolkata:goa':     { peak: 1.30, midday: 1.08, amPeak: 9.5,  pmPeak: 18.5, spread: 1.8, weekend: 0.85, label: 'Goa — light, seasonal' },
  'Asia/Kolkata':         { peak: 1.85, midday: 1.28, amPeak: 9.25, pmPeak: 18.5, spread: 2.3, weekend: 0.6,  label: 'Indian metro — heavy' },
  'Asia/Taipei':          { peak: 1.55, midday: 1.15, amPeak: 8.25, pmPeak: 18,   spread: 1.9, weekend: 0.65, label: 'Taipei — moderate' },
  'Asia/Manila':          { peak: 2.20, midday: 1.45, amPeak: 8.0,  pmPeak: 18,   spread: 2.6, weekend: 0.7,  label: 'Metro Manila — extreme' },
  'Europe/London':        { peak: 1.70, midday: 1.25, amPeak: 8.5,  pmPeak: 17.5, spread: 2.0, weekend: 0.6,  label: 'London — heavy' },
  'Asia/Singapore':       { peak: 1.40, midday: 1.10, amPeak: 8.5,  pmPeak: 18.5, spread: 1.7, weekend: 0.55, label: 'Singapore — managed' },
  'Asia/Dubai':           { peak: 1.60, midday: 1.15, amPeak: 8.0,  pmPeak: 18,   spread: 2.0, weekend: 0.7,  label: 'Dubai — heavy' },
};

export function profileFor(zone: Zone, cityHint?: string): TrafficProfile {
  if (cityHint) {
    const keyed = TRAFFIC_PROFILES[`${zone}:${cityHint.toLowerCase()}`];
    if (keyed) return keyed;
  }
  return TRAFFIC_PROFILES[zone] ?? DEFAULT_PROFILE;
}

/** Gaussian bump used for each rush-hour peak. */
function bump(h: number, centre: number, spread: number): number {
  // wrap around midnight so a 23:30 departure sees the tail of the pm peak
  let d = Math.abs(h - centre);
  if (d > 12) d = 24 - d;
  return Math.exp(-((d / spread) ** 2));
}

/** Congestion multiplier at a given instant. Never below 1. */
export function trafficFactor(at: Epoch, zone: Zone, profile: TrafficProfile): number {
  const p = toParts(at, zone);
  const h = p.hour + p.minute / 60;
  const isWeekend = p.weekday === 0 || p.weekday === 6;

  // Overnight lull: 23:00–05:30 runs essentially free.
  const night = h >= 23 || h < 5.5 ? 1 - Math.min(1, (h >= 23 ? h - 23 : 5.5 - h) / 2.5) : 1;

  const peakness = Math.max(bump(h, profile.amPeak, profile.spread), bump(h, profile.pmPeak, profile.spread));
  const daytime = h >= 6 && h <= 22 ? 1 : 0.25;

  const excessMid = (profile.midday - 1) * daytime;
  const excessPeak = (profile.peak - profile.midday) * peakness;
  let excess = (excessMid + excessPeak) * night;
  if (isWeekend) excess *= profile.weekend;

  return Math.max(1, 1 + excess);
}

export interface EstimateInput {
  from: Pick<Place, 'lat' | 'lon' | 'timezone' | 'name'>;
  to: Pick<Place, 'lat' | 'lon' | 'timezone' | 'name'>;
  mode: TravelMode;
  departAt: Epoch;
  cityHint?: string;
}

/** Offline estimate. Deterministic — same inputs always give the same answer. */
export function estimateTravel(input: EstimateInput): TravelDetail {
  const { from, to, mode, departAt, cityHint } = input;
  const straight = haversineKm(from.lat, from.lon, to.lat, to.lon);
  const distanceKm = mode === 'plane' ? straight : straight * circuity(straight);
  const speed = SPEED[mode](distanceKm);
  const baseMin = (distanceKm / speed) * 60;

  const congestible = mode === 'car' || mode === 'taxi' || mode === 'transit';
  const profile = profileFor(from.timezone, cityHint);
  const factor = congestible ? trafficFactor(departAt, from.timezone, profile) : 1;

  return {
    mode,
    distanceKm: round(distanceKm, 1),
    baseMin: Math.round(baseMin),
    trafficFactor: round(factor, 2),
    source: 'estimate',
  };
}

export function travelMinutes(t: TravelDetail): number {
  return Math.round(t.baseMin * t.trafficFactor);
}

/** Fixed overheads either side of a journey — parking, hailing, queueing,
 *  security. Added by the gap analyser, not by the raw estimate. */
export function overheadMinutes(mode: TravelMode, fromKind?: string, toKind?: string): number {
  let m = mode === 'walk' ? 0 : mode === 'transit' ? 8 : 6;
  if (toKind === 'airport') m += 120;        // check-in + security for departures
  if (fromKind === 'airport') m += 35;       // deplane, immigration, bags
  return m;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/* ---------- live routing ---------- */

const routeCache = new Map<string, { geometry: [number, number][]; baseMin: number; distanceKm: number }>();
let routingEnabled = true;

export function setRoutingEnabled(on: boolean) { routingEnabled = on; }
export function isRoutingEnabled() { return routingEnabled; }

/** Ask OSRM for real road geometry. Falls back silently to the estimate.
 *  OSRM returns free-flow durations, so we still layer the congestion model. */
export async function routeVia(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  mode: TravelMode,
  signal?: AbortSignal,
): Promise<{ geometry: [number, number][]; baseMin: number; distanceKm: number } | null> {
  if (!routingEnabled) return null;
  if (mode === 'plane') return { geometry: greatCircle(from, to), baseMin: 0, distanceKm: 0 };

  const profile = mode === 'walk' ? 'foot' : 'driving';
  const key = `${profile}|${from.lat.toFixed(4)},${from.lon.toFixed(4)}|${to.lat.toFixed(4)},${to.lon.toFixed(4)}`;
  const hit = routeCache.get(key);
  if (hit) return hit;

  const url =
    `https://router.project-osrm.org/route/v1/${profile}/` +
    `${from.lon},${from.lat};${to.lon},${to.lat}` +
    `?overview=full&geometries=geojson&alternatives=false&steps=false`;

  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      code: string;
      routes?: { duration: number; distance: number; geometry: { coordinates: [number, number][] } }[];
    };
    const r = json.routes?.[0];
    if (json.code !== 'Ok' || !r) return null;
    const out = {
      geometry: r.geometry.coordinates.map(([lon, lat]) => [lat, lon] as [number, number]),
      baseMin: Math.round(r.duration / 60),
      distanceKm: round(r.distance / 1000, 1),
    };
    routeCache.set(key, out);
    return out;
  } catch {
    return null;   // offline, blocked, rate-limited — the estimate still stands
  }
}

/** Interpolated great-circle path for flight legs. */
export function greatCircle(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  steps = 48,
): [number, number][] {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const [lat1, lon1, lat2, lon2] = [toRad(a.lat), toRad(a.lon), toRad(b.lat), toRad(b.lon)];
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
  ));
  if (d === 0) return [[a.lat, a.lon], [b.lat, b.lon]];
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    pts.push([toDeg(Math.atan2(z, Math.hypot(x, y))), toDeg(Math.atan2(y, x))]);
  }
  return pts;
}

/** Human sentence for a traffic factor. */
export function trafficLabel(f: number): { text: string; level: 'free' | 'light' | 'heavy' | 'severe' } {
  if (f < 1.08) return { text: 'clear roads', level: 'free' };
  if (f < 1.3) return { text: 'light traffic', level: 'light' };
  if (f < 1.7) return { text: 'heavy traffic', level: 'heavy' };
  return { text: 'severe congestion', level: 'severe' };
}

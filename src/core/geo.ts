/** Finding places, and working out what time it is there.
 *
 *  Three ways in, in the order a planner actually reaches for them:
 *    1. Type a name  → `searchPlaces`, which answers instantly from a built-in
 *       gazetteer and then upgrades with live results if the network allows.
 *    2. Paste a map link → `parseMapLink` pulls the coordinates straight out.
 *    3. Paste coordinates → same function, same result.
 *
 *  The offline path is the important one. A planning session on a plane, on a
 *  train, or behind a firewall still has to be able to add "Goa airport". */

import type { Place, PlaceKind, Zone } from './types';
import { uid } from './store';

export interface PlaceHit {
  name: string;
  /** Second line: state, country, or whatever disambiguates two Springfields. */
  context: string;
  lat: number;
  lon: number;
  kind: PlaceKind;
  timezone: Zone;
  code?: string;
  /** Where the row came from, so the UI can say so. */
  source: 'builtin' | 'osm' | 'link' | 'coords';
  /** Higher sorts first. */
  score: number;
}

/* ---------- timezone from coordinates ----------
   A full tz-boundary shapefile is megabytes. These boxes are coarse but they
   are right for the places people plan trips to, and every one of them is
   checked most-specific-first. Anything unmatched falls back to a whole-hour
   zone derived from longitude, which is never more than 30 min out at sea. */

interface ZoneBox { zone: Zone; s: number; n: number; w: number; e: number }

const ZONE_BOXES: ZoneBox[] = [
  // South Asia
  { zone: 'Asia/Kolkata',   s: 6.5,  n: 35.7, w: 68.0,  e: 89.9 },
  { zone: 'Asia/Colombo',   s: 5.8,  n: 10.0, w: 79.5,  e: 82.0 },
  { zone: 'Asia/Kathmandu', s: 26.3, n: 30.5, w: 80.0,  e: 88.3 },
  { zone: 'Asia/Dhaka',     s: 20.5, n: 26.7, w: 88.0,  e: 92.7 },
  { zone: 'Asia/Thimphu',   s: 26.7, n: 28.4, w: 88.7,  e: 92.2 },
  { zone: 'Asia/Karachi',   s: 23.5, n: 37.1, w: 60.8,  e: 77.9 },
  { zone: 'Indian/Maldives', s: -1.0, n: 7.2, w: 72.5,  e: 74.0 },
  // East & South-East Asia
  { zone: 'Asia/Bangkok',   s: 5.5,  n: 20.5, w: 97.3,  e: 105.7 },
  { zone: 'Asia/Ho_Chi_Minh', s: 8.4, n: 23.4, w: 102.1, e: 109.5 },
  { zone: 'Asia/Singapore', s: 1.1,  n: 1.5,  w: 103.6, e: 104.1 },
  { zone: 'Asia/Kuala_Lumpur', s: 0.8, n: 7.4, w: 99.6, e: 119.3 },
  { zone: 'Asia/Jakarta',   s: -8.8, n: 6.1,  w: 95.0,  e: 115.0 },
  { zone: 'Asia/Manila',    s: 4.6,  n: 21.1, w: 116.9, e: 126.6 },
  { zone: 'Asia/Hong_Kong', s: 22.1, n: 22.6, w: 113.8, e: 114.5 },
  { zone: 'Asia/Taipei',    s: 21.9, n: 25.4, w: 119.5, e: 122.1 },
  { zone: 'Asia/Tokyo',     s: 24.0, n: 45.6, w: 122.9, e: 146.0 },
  { zone: 'Asia/Seoul',     s: 33.1, n: 38.7, w: 125.9, e: 129.7 },
  { zone: 'Asia/Shanghai',  s: 18.1, n: 53.6, w: 73.5,  e: 135.1 },
  // Middle East
  { zone: 'Asia/Dubai',     s: 22.6, n: 26.1, w: 51.5,  e: 56.4 },
  { zone: 'Asia/Qatar',     s: 24.4, n: 26.2, w: 50.7,  e: 51.7 },
  { zone: 'Asia/Riyadh',    s: 16.3, n: 32.2, w: 34.5,  e: 55.7 },
  { zone: 'Asia/Jerusalem', s: 29.4, n: 33.4, w: 34.2,  e: 35.9 },
  { zone: 'Europe/Istanbul', s: 35.8, n: 42.1, w: 25.6, e: 44.8 },
  // Europe
  { zone: 'Europe/London',  s: 49.8, n: 61.0, w: -8.7,  e: 1.8 },
  { zone: 'Europe/Dublin',  s: 51.4, n: 55.4, w: -10.6, e: -5.9 },
  { zone: 'Europe/Lisbon',  s: 36.9, n: 42.2, w: -9.6,  e: -6.2 },
  { zone: 'Europe/Madrid',  s: 35.9, n: 43.8, w: -9.3,  e: 3.4 },
  { zone: 'Europe/Paris',   s: 41.3, n: 51.1, w: -5.2,  e: 8.3 },
  { zone: 'Europe/Amsterdam', s: 50.7, n: 53.6, w: 3.3, e: 7.2 },
  { zone: 'Europe/Berlin',  s: 47.2, n: 55.1, w: 5.8,   e: 15.1 },
  { zone: 'Europe/Zurich',  s: 45.8, n: 47.8, w: 5.9,   e: 10.5 },
  { zone: 'Europe/Rome',    s: 36.6, n: 47.1, w: 6.6,   e: 18.6 },
  { zone: 'Europe/Athens',  s: 34.8, n: 41.8, w: 19.3,  e: 28.3 },
  { zone: 'Europe/Warsaw',  s: 49.0, n: 54.9, w: 14.1,  e: 24.2 },
  { zone: 'Europe/Moscow',  s: 44.0, n: 68.0, w: 27.3,  e: 48.0 },
  // Africa
  { zone: 'Africa/Cairo',   s: 22.0, n: 31.7, w: 24.7,  e: 36.9 },
  { zone: 'Africa/Nairobi', s: -4.7, n: 5.0,  w: 33.9,  e: 41.9 },
  { zone: 'Africa/Lagos',   s: 4.2,  n: 13.9, w: 2.7,   e: 14.7 },
  { zone: 'Africa/Johannesburg', s: -34.9, n: -22.1, w: 16.4, e: 32.9 },
  { zone: 'Africa/Casablanca', s: 27.6, n: 35.9, w: -13.2, e: -1.0 },
  // Americas
  { zone: 'America/New_York', s: 24.4, n: 47.5, w: -84.9, e: -66.9 },
  { zone: 'America/Chicago', s: 25.8, n: 49.4, w: -104.1, e: -84.9 },
  { zone: 'America/Denver',  s: 31.3, n: 49.0, w: -114.1, e: -104.1 },
  { zone: 'America/Los_Angeles', s: 32.5, n: 49.0, w: -124.8, e: -114.1 },
  { zone: 'America/Vancouver', s: 48.2, n: 60.1, w: -139.1, e: -114.1 },
  { zone: 'America/Toronto', s: 41.6, n: 56.9, w: -95.2, e: -74.3 },
  { zone: 'America/Mexico_City', s: 14.5, n: 32.7, w: -118.4, e: -86.7 },
  { zone: 'America/Bogota', s: -4.3, n: 12.6, w: -79.1, e: -66.9 },
  { zone: 'America/Lima',   s: -18.4, n: -0.1, w: -81.4, e: -68.7 },
  { zone: 'America/Santiago', s: -55.9, n: -17.5, w: -75.7, e: -66.4 },
  { zone: 'America/Sao_Paulo', s: -33.8, n: -2.7, w: -57.7, e: -34.8 },
  { zone: 'America/Argentina/Buenos_Aires', s: -55.1, n: -21.8, w: -73.6, e: -53.6 },
  // Oceania
  { zone: 'Australia/Perth',  s: -35.2, n: -13.7, w: 112.9, e: 129.0 },
  { zone: 'Australia/Adelaide', s: -38.1, n: -26.0, w: 129.0, e: 141.0 },
  { zone: 'Australia/Brisbane', s: -29.2, n: -9.1, w: 138.0, e: 153.6 },
  { zone: 'Australia/Sydney', s: -39.2, n: -28.2, w: 141.0, e: 153.7 },
  { zone: 'Pacific/Auckland', s: -47.3, n: -34.4, w: 166.4, e: 178.6 },
  { zone: 'Pacific/Fiji',     s: -20.7, n: -12.5, w: 177.0, e: 180.0 },
];

/** Best-effort IANA zone for a coordinate. Never throws; always returns
 *  something `Intl` will accept. */
export function guessZone(lat: number, lon: number, fallback?: Zone): Zone {
  for (const b of ZONE_BOXES) {
    if (lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e) return b.zone;
  }
  if (fallback) return fallback;
  // Etc/GMT signs are inverted from the usual convention: Etc/GMT-5 is UTC+5.
  const hours = Math.max(-12, Math.min(14, Math.round(lon / 15)));
  if (hours === 0) return 'UTC';
  return `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
}

/** True when `Intl` recognises the zone — guards hand-typed input. */
export function isValidZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
}

/* ---------- the built-in gazetteer ----------
   Deliberately small and biased towards the places this app was built for:
   Indian metros and their airports, plus the international hubs people fly
   in from. It is a head start, not a world atlas — live search fills the
   rest in when it is reachable. */

interface Gaz { n: string; c: string; lat: number; lon: number; k: PlaceKind; code?: string; alt?: string }

const GAZETTEER: Gaz[] = [
  // Indian metros
  { n: 'Bengaluru', c: 'Karnataka, India', lat: 12.9716, lon: 77.5946, k: 'landmark', alt: 'bangalore blr' },
  { n: 'Kempegowda International Airport', c: 'Bengaluru, India', lat: 13.1986, lon: 77.7066, k: 'airport', code: 'BLR', alt: 'bangalore airport' },
  { n: 'Mumbai', c: 'Maharashtra, India', lat: 19.0760, lon: 72.8777, k: 'landmark', alt: 'bombay' },
  { n: 'Chhatrapati Shivaji Maharaj International Airport', c: 'Mumbai, India', lat: 19.0896, lon: 72.8656, k: 'airport', code: 'BOM', alt: 'mumbai airport' },
  { n: 'New Delhi', c: 'Delhi, India', lat: 28.6139, lon: 77.2090, k: 'landmark', alt: 'delhi ncr' },
  { n: 'Indira Gandhi International Airport', c: 'Delhi, India', lat: 28.5562, lon: 77.1000, k: 'airport', code: 'DEL', alt: 'delhi airport' },
  { n: 'Goa', c: 'India', lat: 15.2993, lon: 74.1240, k: 'landmark', alt: 'panaji panjim' },
  { n: 'Manohar International Airport', c: 'Mopa, Goa, India', lat: 15.7440, lon: 73.8580, k: 'airport', code: 'GOX', alt: 'goa airport mopa' },
  { n: 'Dabolim Airport', c: 'Goa, India', lat: 15.3808, lon: 73.8314, k: 'airport', code: 'GOI', alt: 'goa airport dabolim' },
  { n: 'Chennai', c: 'Tamil Nadu, India', lat: 13.0827, lon: 80.2707, k: 'landmark', alt: 'madras' },
  { n: 'Chennai International Airport', c: 'Chennai, India', lat: 12.9941, lon: 80.1709, k: 'airport', code: 'MAA' },
  { n: 'Hyderabad', c: 'Telangana, India', lat: 17.3850, lon: 78.4867, k: 'landmark' },
  { n: 'Rajiv Gandhi International Airport', c: 'Hyderabad, India', lat: 17.2403, lon: 78.4294, k: 'airport', code: 'HYD' },
  { n: 'Kolkata', c: 'West Bengal, India', lat: 22.5726, lon: 88.3639, k: 'landmark', alt: 'calcutta' },
  { n: 'Netaji Subhas Chandra Bose Airport', c: 'Kolkata, India', lat: 22.6547, lon: 88.4467, k: 'airport', code: 'CCU' },
  { n: 'Pune', c: 'Maharashtra, India', lat: 18.5204, lon: 73.8567, k: 'landmark' },
  { n: 'Jaipur', c: 'Rajasthan, India', lat: 26.9124, lon: 75.7873, k: 'landmark' },
  { n: 'Kochi', c: 'Kerala, India', lat: 9.9312, lon: 76.2673, k: 'landmark', alt: 'cochin ernakulam' },
  { n: 'Cochin International Airport', c: 'Kochi, India', lat: 10.1520, lon: 76.4019, k: 'airport', code: 'COK' },
  { n: 'Ahmedabad', c: 'Gujarat, India', lat: 23.0225, lon: 72.5714, k: 'landmark' },
  { n: 'Udaipur', c: 'Rajasthan, India', lat: 24.5854, lon: 73.7125, k: 'landmark' },
  { n: 'Rishikesh', c: 'Uttarakhand, India', lat: 30.0869, lon: 78.2676, k: 'landmark' },
  { n: 'Varanasi', c: 'Uttar Pradesh, India', lat: 25.3176, lon: 82.9739, k: 'landmark', alt: 'banaras kashi' },
  { n: 'Agra', c: 'Uttar Pradesh, India', lat: 27.1767, lon: 78.0081, k: 'landmark', alt: 'taj mahal' },
  { n: 'Coorg', c: 'Karnataka, India', lat: 12.3375, lon: 75.8069, k: 'landmark', alt: 'kodagu madikeri' },
  { n: 'Mysuru', c: 'Karnataka, India', lat: 12.2958, lon: 76.6394, k: 'landmark', alt: 'mysore' },
  { n: 'Hampi', c: 'Karnataka, India', lat: 15.3350, lon: 76.4600, k: 'landmark' },
  { n: 'Gokarna', c: 'Karnataka, India', lat: 14.5479, lon: 74.3188, k: 'landmark' },
  { n: 'Leh', c: 'Ladakh, India', lat: 34.1526, lon: 77.5771, k: 'landmark' },
  { n: 'Shimla', c: 'Himachal Pradesh, India', lat: 31.1048, lon: 77.1734, k: 'landmark' },
  { n: 'Manali', c: 'Himachal Pradesh, India', lat: 32.2432, lon: 77.1892, k: 'landmark' },
  { n: 'Darjeeling', c: 'West Bengal, India', lat: 27.0360, lon: 88.2627, k: 'landmark' },
  { n: 'Pondicherry', c: 'Puducherry, India', lat: 11.9416, lon: 79.8083, k: 'landmark', alt: 'puducherry' },
  { n: 'Alleppey', c: 'Kerala, India', lat: 9.4981, lon: 76.3388, k: 'landmark', alt: 'alappuzha backwaters' },
  { n: 'Munnar', c: 'Kerala, India', lat: 10.0889, lon: 77.0595, k: 'landmark' },
  // International hubs
  { n: 'Dubai International Airport', c: 'United Arab Emirates', lat: 25.2532, lon: 55.3657, k: 'airport', code: 'DXB' },
  { n: 'Singapore Changi Airport', c: 'Singapore', lat: 1.3644, lon: 103.9915, k: 'airport', code: 'SIN' },
  { n: 'Heathrow Airport', c: 'London, United Kingdom', lat: 51.4700, lon: -0.4543, k: 'airport', code: 'LHR' },
  { n: 'London', c: 'United Kingdom', lat: 51.5074, lon: -0.1278, k: 'landmark' },
  { n: 'Taiwan Taoyuan International Airport', c: 'Taipei, Taiwan', lat: 25.0777, lon: 121.2328, k: 'airport', code: 'TPE' },
  { n: 'Taipei', c: 'Taiwan', lat: 25.0330, lon: 121.5654, k: 'landmark' },
  { n: 'Ninoy Aquino International Airport', c: 'Manila, Philippines', lat: 14.5086, lon: 121.0198, k: 'airport', code: 'MNL' },
  { n: 'Bangkok', c: 'Thailand', lat: 13.7563, lon: 100.5018, k: 'landmark' },
  { n: 'Suvarnabhumi Airport', c: 'Bangkok, Thailand', lat: 13.6900, lon: 100.7501, k: 'airport', code: 'BKK' },
  { n: 'John F. Kennedy International Airport', c: 'New York, United States', lat: 40.6413, lon: -73.7781, k: 'airport', code: 'JFK' },
  { n: 'San Francisco International Airport', c: 'California, United States', lat: 37.6213, lon: -122.3790, k: 'airport', code: 'SFO' },
  { n: 'Tokyo', c: 'Japan', lat: 35.6762, lon: 139.6503, k: 'landmark' },
  { n: 'Haneda Airport', c: 'Tokyo, Japan', lat: 35.5494, lon: 139.7798, k: 'airport', code: 'HND' },
  { n: 'Colombo', c: 'Sri Lanka', lat: 6.9271, lon: 79.8612, k: 'landmark' },
  { n: 'Kathmandu', c: 'Nepal', lat: 27.7172, lon: 85.3240, k: 'landmark' },
  { n: 'Paris', c: 'France', lat: 48.8566, lon: 2.3522, k: 'landmark' },
  { n: 'Amsterdam', c: 'Netherlands', lat: 52.3676, lon: 4.9041, k: 'landmark' },
  { n: 'Sydney', c: 'Australia', lat: -33.8688, lon: 151.2093, k: 'landmark' },
];

function scoreMatch(hay: string, q: string): number {
  const h = hay.toLowerCase();
  if (h === q) return 100;
  if (h.startsWith(q)) return 80 - Math.min(20, h.length - q.length);
  const word = h.split(/[\s,]+/).some((w) => w.startsWith(q));
  if (word) return 60;
  if (h.includes(q)) return 40;
  return 0;
}

export function searchBuiltin(query: string, limit = 8): PlaceHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return GAZETTEER
    .map((g) => {
      const score = Math.max(
        scoreMatch(g.n, q),
        scoreMatch(g.alt ?? '', q) * 0.95,
        g.code?.toLowerCase() === q ? 100 : 0,
        scoreMatch(g.c, q) * 0.5,
      );
      return { g, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ g, score }) => ({
      name: g.n, context: g.c, lat: g.lat, lon: g.lon, kind: g.k, code: g.code,
      timezone: guessZone(g.lat, g.lon), source: 'builtin' as const, score,
    }));
}

/* ---------- live search ---------- */

const OSM_KIND: Record<string, PlaceKind> = {
  aerodrome: 'airport', airport: 'airport', terminal: 'airport',
  hotel: 'hotel', hostel: 'hotel', guest_house: 'hotel', resort: 'hotel', motel: 'hotel',
  restaurant: 'restaurant', cafe: 'restaurant', fast_food: 'restaurant', food_court: 'restaurant',
  bar: 'bar', pub: 'bar', biergarten: 'bar', nightclub: 'bar',
  place_of_worship: 'temple', temple: 'temple', hindu_temple: 'temple',
  conference_centre: 'venue', exhibition_centre: 'venue', theatre: 'venue', arts_centre: 'venue',
  station: 'transit', bus_station: 'transit', railway: 'transit', halt: 'transit',
  office: 'office', coworking_space: 'office',
};

function osmKind(row: { category?: string; type?: string; class?: string }): PlaceKind {
  return OSM_KIND[row.type ?? ''] ?? OSM_KIND[row.category ?? ''] ?? OSM_KIND[row.class ?? ''] ?? 'other';
}

let liveSearchEnabled = true;
export function setLiveSearchEnabled(on: boolean) { liveSearchEnabled = on; }
export function isLiveSearchEnabled() { return liveSearchEnabled; }

const liveCache = new Map<string, PlaceHit[]>();

/** Nominatim. Rate-limited and best-effort — a failure is silent by design,
 *  because the built-in results are already on screen by the time it answers. */
export async function searchLive(query: string, signal?: AbortSignal, near?: { lat: number; lon: number }): Promise<PlaceHit[]> {
  const q = query.trim();
  if (!liveSearchEnabled || q.length < 3) return [];
  const key = `${q}|${near ? `${near.lat.toFixed(1)},${near.lon.toFixed(1)}` : ''}`;
  const hit = liveCache.get(key);
  if (hit) return hit;

  const params = new URLSearchParams({ format: 'jsonv2', q, limit: '8', addressdetails: '1' });
  if (near) {
    // A soft nudge, not a filter: a 6° box around the trip so "the pub" finds
    // the one in this city before one on another continent.
    params.set('viewbox', [near.lon - 3, near.lat + 3, near.lon + 3, near.lat - 3].join(','));
  }
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      signal, headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as {
      display_name: string; name?: string; lat: string; lon: string;
      category?: string; type?: string; class?: string; importance?: number;
      address?: Record<string, string>;
    }[];
    const out = rows.map((r, i): PlaceHit => {
      const lat = Number(r.lat);
      const lon = Number(r.lon);
      const parts = r.display_name.split(',').map((p) => p.trim());
      const name = r.name?.trim() || parts[0];
      return {
        name,
        context: parts.slice(1).filter((p) => p !== name).slice(-3).join(', '),
        lat, lon,
        kind: osmKind(r),
        timezone: guessZone(lat, lon),
        source: 'osm',
        score: 50 + (r.importance ?? 0) * 20 - i,
      };
    }).filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon));
    liveCache.set(key, out);
    return out;
  } catch {
    return [];   // offline, blocked by CSP, or rate-limited
  }
}

/** Built-in first, then live, de-duplicated by proximity so the same airport
 *  does not appear twice under two spellings. */
export function mergeHits(a: PlaceHit[], b: PlaceHit[]): PlaceHit[] {
  const out = [...a];
  for (const hit of b) {
    const dupe = out.some(
      (x) => Math.abs(x.lat - hit.lat) < 0.02 && Math.abs(x.lon - hit.lon) < 0.02,
    );
    if (!dupe) out.push(hit);
  }
  return out.sort((x, y) => y.score - x.score);
}

/* ---------- map links ---------- */

const COORD = String.raw`(-?\d{1,3}(?:\.\d+)?)`;

/** Pull a place out of a pasted link or a pair of coordinates.
 *  Returns null when there is nothing usable, including for shortened links,
 *  which cannot be expanded from a browser. */
export function parseMapLink(input: string, fallbackZone?: Zone): PlaceHit | null {
  const text = input.trim();
  if (!text) return null;

  let name = '';
  let lat: number | null = null;
  let lon: number | null = null;

  // Bare "12.97, 77.59"
  const bare = new RegExp(`^${COORD}\\s*[,\\s]\\s*${COORD}$`).exec(text);
  if (bare) { lat = Number(bare[1]); lon = Number(bare[2]); }

  if (lat === null) {
    // geo:12.97,77.59  ·  ?q=  ·  ?ll=  ·  ?query=  ·  ?center=  ·  ?destination=
    const q = new RegExp(`(?:geo:|[?&](?:q|ll|query|center|destination|daddr|mlat)=)${COORD}(?:,|%2C)${COORD}`, 'i').exec(text);
    if (q) { lat = Number(q[1]); lon = Number(q[2]); }
  }
  if (lat === null) {
    // Google's /@lat,lon,zoom  and  !3dlat!4dlon
    const at = new RegExp(`[@/]${COORD},${COORD}(?:,|z|/|$)`).exec(text);
    const bang = new RegExp(`!3d${COORD}!4d${COORD}`).exec(text);
    const m = bang ?? at;
    if (m) { lat = Number(m[1]); lon = Number(m[2]); }
  }
  if (lat === null) {
    // OpenStreetMap  #map=15/12.97/77.59
    const osm = new RegExp(`#map=\\d+(?:\\.\\d+)?/${COORD}/${COORD}`).exec(text);
    if (osm) { lat = Number(osm[1]); lon = Number(osm[2]); }
  }
  // Separate mlat/mlon pair
  if (lat === null) {
    const la = new RegExp(`[?&]mlat=${COORD}`).exec(text);
    const lo = new RegExp(`[?&]mlon=${COORD}`).exec(text);
    if (la && lo) { lat = Number(la[1]); lon = Number(lo[1]); }
  }

  if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  // A Google link usually carries the name in /place/<name>/
  const place = /\/place\/([^/@?]+)/.exec(text);
  if (place) name = decodeURIComponent(place[1]).replace(/\+/g, ' ').trim();

  const source = bare ? 'coords' : 'link';
  return {
    name: name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    context: name ? 'From a pasted map link' : 'Pasted coordinates',
    lat, lon,
    kind: 'other',
    timezone: guessZone(lat, lon, fallbackZone),
    source,
    score: 100,
  };
}

/** True for a shortened link we cannot resolve in the browser, so the UI can
 *  explain the one extra step instead of just saying "no". */
export function isShortMapLink(input: string): boolean {
  return /(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|bit\.ly|tinyurl\.com|osm\.org\/go)/i.test(input);
}

export function mapUrl(place: Pick<Place, 'lat' | 'lon' | 'name'>): string {
  return `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lon}`;
}

export function directionsUrl(
  from: Pick<Place, 'lat' | 'lon'>,
  to: Pick<Place, 'lat' | 'lon'>,
  mode: 'driving' | 'transit' | 'walking' = 'driving',
): string {
  return `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lon}` +
    `&destination=${to.lat},${to.lon}&travelmode=${mode}`;
}

export function placeFromHit(hit: PlaceHit): Place {
  return {
    id: uid('plc'),
    name: hit.name,
    kind: hit.kind,
    lat: hit.lat,
    lon: hit.lon,
    timezone: hit.timezone,
    address: hit.context || undefined,
    code: hit.code,
    url: mapUrl(hit),
    dwellMin: hit.kind === 'airport' ? 120 : hit.kind === 'restaurant' ? 90 : undefined,
  };
}

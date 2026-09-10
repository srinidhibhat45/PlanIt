/** Sharing: the whole trip travels in the URL fragment, so a link works with
 *  no server, no account and no database. The fragment never leaves the
 *  browser (it is not sent in HTTP requests), which keeps a plan private to
 *  whoever holds the link. */

import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import type { Trip } from './types';
import { download } from './ics';
import { pack, packedIdFor, unpack, type Packed } from './pack';

export type ShareMode = 'edit' | 'view';

export interface SharePayload {
  mode: ShareMode;
  trip: Trip;
  /** Optional person focus, so you can send someone just their own view. */
  focus?: string;
}

/** Wire shape. `t` is the packed trip; `m` is 1 for an editable copy. */
interface Wire { v: 2; m?: 1; f?: string; t: Packed }

export function encodeTrip(trip: Trip, mode: ShareMode = 'view', focus?: string): string {
  const wire: Wire = {
    v: 2,
    m: mode === 'edit' ? 1 : undefined,
    f: focus ? packedIdFor(trip, focus) : undefined,
    t: pack(trip),
  };
  return compressToEncodedURIComponent(JSON.stringify(wire));
}

export function decodeTrip(token: string): SharePayload | null {
  try {
    const json = decompressFromEncodedURIComponent(token);
    if (!json) return null;
    const parsed = JSON.parse(json) as Omit<Partial<Wire>, 'v'> & { v?: number; trip?: Trip; mode?: ShareMode; focus?: string };
    // v2: packed. v1 links from an earlier build carried the trip verbatim.
    if (parsed.v === 2 && parsed.t) {
      return { mode: parsed.m === 1 ? 'edit' : 'view', trip: unpack(parsed.t), focus: parsed.f };
    }
    if (parsed.v === 1 && parsed.trip?.segments) {
      return { mode: parsed.mode ?? 'view', trip: parsed.trip, focus: parsed.focus };
    }
    return null;
  } catch {
    return null;
  }
}

export function shareUrl(trip: Trip, mode: ShareMode = 'view', focus?: string): string {
  const base = `${location.origin}${location.pathname}`;
  return `${base}#/s/${encodeTrip(trip, mode, focus)}`;
}

export function readShareFromLocation(): SharePayload | null {
  const m = location.hash.match(/^#\/s\/(.+)$/);
  return m ? decodeTrip(m[1]) : null;
}

export function clearShareFromLocation() {
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

/** The fragment never reaches a server, so server URL limits do not apply.
 *  What does bite is chat clients that truncate very long links, which is
 *  where this threshold comes from. */
export const SHARE_LINK_COMFORTABLE = 14_000;

export function shareSize(trip: Trip): { chars: number; warn: boolean } {
  const chars = shareUrl(trip).length;
  return { chars, warn: chars > SHARE_LINK_COMFORTABLE };
}

/* ---------- file import / export ---------- */

export function exportJson(trip: Trip) {
  const slug = trip.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  download(`${slug}.planit.json`, JSON.stringify(trip, null, 2), 'application/json');
}

export async function importJson(file: File): Promise<Trip> {
  const text = await file.text();
  const parsed = JSON.parse(text) as Trip;
  if (!parsed.segments || !parsed.people) throw new Error('Not a PlanIt file — missing segments or people.');
  return { ...parsed, schemaVersion: 1 };
}

/** Markdown for pasting into chat, email or a wiki. */
export function toMarkdown(trip: Trip, dayGroups: { key: string; label: string; rows: string[] }[]): string {
  const out = [`# ${trip.name}`, '', trip.subtitle ?? '', ''];
  for (const g of dayGroups) {
    out.push(`## ${g.label}`, '');
    out.push(...g.rows);
    out.push('');
  }
  return out.join('\n');
}

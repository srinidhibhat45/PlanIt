/** The trips the library can conjure out of nothing.
 *
 *  A seed is just a builder plus the words the button needs, so adding one is
 *  a line here rather than another prop threaded through the library screen. */

import type { Trip } from '../core/types';
import { conferenceTrip } from './conference';
import { uxIndiaTrip } from './uxindia';

export interface Seed {
  id: string;
  /** Reads after "Open " and after "Add ", so keep it a noun phrase. */
  label: string;
  hint: string;
  build: () => Trip;
}

export const SEEDS: Seed[] = [
  {
    id: 'ux-india',
    label: 'UX India',
    hint: 'Bengaluru, 20–30 September 2026, transcribed from the planning board: eight people out of five cities, '
      + 'two hotels, three tracks, and every question the board left open.',
    build: uxIndiaTrip,
  },
  {
    id: 'conference',
    label: 'the example',
    hint: 'A fully worked eight-person conference trip — people, flights, clashes and all — to look around in.',
    build: conferenceTrip,
  },
];

export function seedById(id: string): Seed | undefined {
  return SEEDS.find((s) => s.id === id);
}

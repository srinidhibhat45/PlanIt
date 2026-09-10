# PlanIt

An itinerary planner for trips where **different people do different things at
different times in different time zones** — conferences, tours, group travel,
anything where "what is everyone doing on Thursday evening?" is a hard question.

Runs entirely in the browser. No server, no account, no database. First run
opens a short walkthrough that explains the flow and what each of the seven
views is for; every view also carries a one-line description you can switch off
once you no longer need it.

```bash
npm install
npm run dev      # dev server with hot reload  → http://localhost:5273
npm run serve    # build + serve the real thing → http://localhost:4273
npm run check    # typecheck + 127 tests + production build
```

Both servers bind `0.0.0.0`, so anything on the same Wi-Fi can reach them at
`http://<your-lan-ip>:4273`. Find the address with `ipconfig getifaddr en0` on
macOS, or read it off the "Network:" line Vite prints on start. That is how you
get the plan onto eight phones in a room without deploying anything.

Two caveats when serving on the network:

- **Share links embed the origin they were created on.** Generate them from the
  LAN address if the recipients will open them from the LAN address; a link made
  at `localhost` only works on this machine.
- **It is plain HTTP.** Fine on a trusted network. The clipboard button needs a
  secure context in some browsers, so on a phone the link may need to be
  selected and copied by hand — the text field is there for exactly that.

---

## The problem it was built against

Eight people converge on Bengaluru for a conference:

| Person | From | Track | Arrives | Leaves |
|---|---|---|---|---|
| Aarti Naik | Goa | A · 23–25 Sep | 22 Sep, 6E 246 | 29 Sep (early) |
| Rohan Mehra | Delhi | A | 22 Sep, AI 803 | 30 Sep |
| Yu-Chen Lin | Taipei | A | 22 Sep, via Singapore | 1 Oct (late) |
| Eleanor Whitfield | London | A | 22 Sep, BA 119 | 30 Sep |
| Priya Sethi | Delhi | B · 26–27 Sep | 25 Sep, 6E 2011 | 30 Sep |
| Mariel Santos | Manila | B | 25 Sep, via Singapore | 30 Sep |
| Diego Ramos | Manila | B | 26 Sep, 05:20 red-eye | 30 Sep |
| Tom Bradshaw | Manchester | B | 26 Sep, via Dubai | 1 Oct (late) |

Two hotels, two conference tracks, a joint workshop on 28–29, staggered
departures, and free evenings where some people want temples and others want
breweries.

Open the app and it loads exactly this. **Two faults are deliberately baked in**
so you can see the analyser earn its keep:

> **Tom Bradshaw cannot make it in time.** Kempegowda International Airport →
> Bangalore International Centre needs about 98 min (33 km, ×1.51 traffic) but
> only 15 min is free. Short by 83 min.

His flight lands at 09:15 and Track B opens at 09:30. On paper that looks fine.
It is not, because the airport is 33 km out and 09:15 is the top of the morning
peak. Diego's 05:20 red-eye is the second: legal, but the app flags the short
night and the tentative early check-in.

Everything is ordinary trip data. Change the host city, the roster and the dates
and the same machinery runs a forty-person tour.

---

## What it does

**Seven views of the same plan**

| View | For |
|---|---|
| **Timeline** | Swimlanes per person, group, place or type. The view for spotting who is where. Drag to move, drag edges to resize, drag across lanes to reassign. Stretches where someone is not on the trip yet are shaded and labelled with the date they arrive, so a blank lane is never ambiguous. |
| **Day** | Hours down the side, a column per person. "Where do I need to be, and when?" |
| **Trip** | The whole trip as a day grid. Coarse moves and empty-evening spotting. |
| **Agenda** | The plain-language itinerary, with journeys between stops spelled out. This is what prints and what a screen reader reads. |
| **Map** | Real road routes, traffic-adjusted durations, stops numbered in order. |
| **People** | Roster: arrivals, departures, hotel, interests, daily load. |
| **Ideas** | Backlog of things people want to do, with interest voting. Drop one on a day and it finds a free evening slot. |

**Time zones, done properly.** Every instant is stored as UTC. A segment
records the zone it physically happens in. You choose what the whole UI renders
in: each item's own local time, trip time, your device, or *any traveller's home
clock* — so you can look at the plan the way Yu-Chen sees it from Taipei. DST
transitions, half-hour offsets (India) and quarter-hour offsets (Nepal) are all
handled; ambiguous and skipped local times follow Temporal's `compatible`
disambiguation.

**A travel model that knows about traffic.** Road geometry and free-flow
duration come from OSRM when the network allows; a diurnal congestion curve,
calibrated per metro area, is layered on top for the actual departure time.
Delhi at 09:15 is not Goa at 09:15. Airport check-in and deplaning overheads are
added separately. The UI always says which number came from a router and which
from the model — it is an estimate, not a live traffic feed.

**An analyser that reads the plan back to you.** Double bookings, journeys that
do not fit the gap, items scheduled before someone lands or after they leave,
short nights, long days with no meal break, unbooked journeys, free evenings
matched against people's stated interests, and airports with no flight between
them. Repetitive findings roll up per person per day so the real problems stay
visible.

**Sharing without a backend.** The entire plan is packed and compressed into the
URL fragment. Fragments are never sent to a server, so a link is private to
whoever holds it, works offline, and needs nothing to sign in to. A ten-day,
eight-person, 79-block plan is about 8 600 characters. Read-only or editable;
optionally focused on one person so you can send someone just their own days.

**Calendar export.** RFC 5545 `.ics` for the whole trip or per person, with
alarms, attendees, geo coordinates and correct line folding. Times are written
in UTC so Google, Outlook and Apple Calendar all render them in whatever zone
the reader is standing in. Plus per-event Google and Outlook deep links, JSON
backup/restore, plain-text copy, and print/PDF.

---

## Accessibility

Not a retrofit. Some specifics:

- **Drag and drop works from the keyboard.** Not a fallback — the same state
  machine. <kbd>Space</kbd> picks a block up, arrows move it (⇧ for 5 minutes,
  ⌥ for an hour, ↑↓ to hand it to another person), <kbd>Enter</kbd> drops,
  <kbd>Esc</kbd> puts it back. Every step is announced with the resulting time.
  Keyboard nudges apply exactly the delta they announced; pointer drags snap to
  the grid. Satisfies 2.1.1 and 2.5.7.
- **Contrast.** Zero AA failures in either theme, verified by measuring every
  visible text node against its real painted background; the lowest ratio is
  4.99:1 and about two thirds of text already clears AAA. A "higher contrast"
  setting and `prefers-contrast: more` take that to 91%.
- **Colour is never the only channel.** Every block carries an icon alongside
  its hue, plus its title whenever the block is wide enough for one; a sliver
  too narrow for a character still has its full description as its accessible
  name and its tooltip. Tentative blocks are hatched *and* dashed *and*
  labelled.
- **Honours user preferences**: `prefers-reduced-motion`,
  `prefers-reduced-transparency`, `prefers-contrast`, and `forced-colors`
  (Windows High Contrast).
- Full landmark and heading structure, a skip link, live regions for every
  mutation, focus trapping in dialogs, no positive `tabindex`, visible focus
  everywhere, 44 px touch targets on coarse pointers, and fluid `rem`-based type
  that survives 200% zoom.
- The map ships an ordered text list of stops as its accessible equivalent.

Audit the contrast yourself: `tools/contrast-audit.js` — paste into DevTools and
call `window.__audit()`.

---

## Keyboard

| | |
|---|---|
| <kbd>⌘K</kbd> | Command palette — every action by name |
| <kbd>?</kbd> | Shortcut help |
| <kbd>1</kbd>–<kbd>7</kbd> | Jump to a view |
| <kbd>N</kbd> | New block |
| <kbd>/</kbd> | Search |
| <kbd>[</kbd> <kbd>]</kbd> | Previous / next day |
| <kbd>\</kbd> | Toggle the filter rail |
| <kbd>⌘Z</kbd> / <kbd>⌘⇧Z</kbd> | Undo / redo |
| <kbd>⌘</kbd> + scroll | Zoom the time axis |

---

## Layout

```
src/
  core/          no React, no DOM — all of it unit-tested
    types.ts       the domain model
    time.ts        timezone engine, built on Intl
    travel.ts      distance, routing adapter, traffic model
    schedule.ts    derivations and the analyser
    layout.ts      lane packing and scale maths
    store.ts       reducer, undo/redo, persistence
    ics.ts         RFC 5545 export
    pack.ts        compact wire format for share links
    share.ts       link encoding, JSON import/export
    clock.ts       which zone the UI renders in
  components/    views and chrome
    Tour.tsx       the first-run walkthrough
    ViewHint.tsx   the one-line description under each view's toolbar
  hooks/         drag machine, toasts, hotkeys, focus trap
  data/          the worked conference example
test/run.ts      127 assertions, no framework
```

**Invariants worth knowing**

- Every instant in the model is UTC epoch milliseconds. Naive wall-clock values
  exist only as an explicit `{parts, zone}` pair crossing `time.ts`.
- `snapMin: 0` in a move or resize action means "apply this delta exactly" and
  is what the keyboard path uses.
- Never transition the `background` shorthand — it strands elements on a stale
  colour when a theme token changes. Use `background-color`.
- **A block never renders a line it has no room for.** Blocks have a height set
  by the grid, not by their contents, and text that overflows a fixed-height box
  does not clip politely — it paints over the line below it and outside the
  block's own border. So the caller measures first and tells `SegmentChrome` how
  many lines fit; the timeline drops the place, then the clock, then the title,
  leaving a sliver with just its icon. For the same reason nothing inside a
  block may be a flex or grid item that is allowed to shrink below its line box.

## State

Autosaves to `localStorage`. `npm run dev` starts from the example; delete
`planit.trip.v1` to reset. Nothing leaves the browser except OSRM route lookups
(coordinates only) and OpenStreetMap tile requests.

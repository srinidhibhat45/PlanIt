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

## Deploying

The build is four static files, so any static host will do. `vercel.json` has
the settings for Vercel:

```bash
npx vercel        # preview deployment
npx vercel --prod # production
```

Or import the repo at [vercel.com/new](https://vercel.com/new) — the committed
config supplies the framework, build command and output directory, so leave the
project settings on their defaults and do not add any environment variables.
There are none: nothing is configured at build time, and there is no backend to
point at.

What the config sets, and why:

- **`npm ci` + Node 22** (`.nvmrc`, `engines`). The lockfile is committed, so
  builds are reproducible.
- **A catch-all rewrite to `/index.html`.** Share links live in the URL
  fragment (`/#/s/…`), which never reaches the server, so this only matters for
  someone typing a stray path — but it makes that a plan rather than a 404.
- **`immutable` caching on `/assets/*`,** which is safe because Vite hashes
  those filenames. `index.html` stays revalidated so a deploy takes effect at
  once.
- **A content security policy** naming the three origins the app actually
  talks to: Google Fonts, OpenStreetMap tiles and the OSRM routing service.
  Anything else is refused by the browser. If you add a network call, add its
  origin here or it will be blocked in production but work fine in `npm run
  dev`.

Source maps are left out of a production build, since they are ~2.2 MB and the
source is in this repo anyway. `SOURCEMAP=1 npm run build` puts them back.

Once deployed, share links carry the deployed origin, the clipboard button
works everywhere (HTTPS), and both LAN caveats above stop applying.

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

**A library of trips.** The first screen lists every trip in this browser — start
a new one, duplicate an old one, import a JSON backup, or open the worked
example. Each trip carries its own people, places, plan and sub-trips; nothing
is shared between them.

**People are the unit.** A traveller is a first-class entity: name, contact,
where they are travelling from (searched, so it comes with coordinates and a
time zone), the window when they can actually be there, interests, dietary and
mobility notes. Every one of those feeds the analyser. Each person has their own
itinerary inside the shared plan, their own clock, and a link you can send that
opens on their days alone.

**Eight views of the same plan**

| View | For |
|---|---|
| **Canvas** | The board. A whiteboard you arrange by hand, which then resolves onto the calendar. |
| **Timeline** | Swimlanes per person, group, place or type. The view for spotting who is where. Drag to move, drag edges to resize, drag across lanes to reassign. Stretches where someone is not on the trip yet are shaded and labelled with the date they arrive, so a blank lane is never ambiguous. |
| **Day** | Hours down the side, a column per person. "Where do I need to be, and when?" |
| **Trip** | The whole trip as a day grid. Coarse moves and empty-evening spotting. |
| **Agenda** | The plain-language itinerary, with journeys between stops spelled out. This is what prints and what a screen reader reads. |
| **Map** | Real road routes, traffic-adjusted durations, stops numbered in order. |
| **People** | Roster: arrivals, departures, hotel, interests, daily load. |
| **Ideas** | Backlog of things people want to do, with interest voting. Drop one on a day and it finds a free evening slot. |

### The board

The centrepiece, and where a trip gets thought out rather than typed in. It is a
whiteboard — pan, zoom, put things anywhere — and it is deliberately *not* a
calendar. Nothing on it touches the clock until you ask.

Position earns its meaning from **frames**:

- A card inside a **day frame** happens on that day. Inside a frame, top to
  bottom is the order of the day, and side by side means at the same time — two
  conference tracks are not a queue.
- A card inside a **sub-trip frame** belongs to that group. Drop another one in
  later and it joins.
- A card anywhere else means nothing at all, which is the point of a board. It
  is drawn with a dashed edge to say so.

**Connectors** are the other half of the grammar. Drag a card's port onto
another card and the second comes after the first; a *travel* connector (the
default) costs the modelled journey between the two places, traffic and airport
overheads included, while a *then* connector just means "after". Click the chip
on a connector to switch between them.

Two buttons bridge the board and the calendar, in both directions:

- **Tidy** lays the existing plan out for you — a frame per day, cards in time
  order, lanes for things that happen at once. This is the timeline → board
  direction, and it is an explicit action rather than something that happens on
  its own: a board that rearranges itself under your hands is not a board.
- **Resolve** reads the arrangement back and hands out times. It is the board →
  timeline direction, and it is built to be safe on a plan somebody has already
  half-timed by hand:
  - **A card opts in.** One that is neither framed, wired nor pinned is left
    exactly where it is.
  - **It only ever pushes forward.** A card on the wrong day changes date and
    keeps its time of day. A card that cannot start that early is pushed later.
    Nothing is ever pulled earlier, and no time is invented.
  - **Reordering swaps, it does not reset.** Drag a card above another in the
    same column and the times already in that column are dealt back out in the
    new order — durations respected, so a one-hour lunch dropped below a
    three-hour session lands after it, not on top of it.
  - **Pins win.** A pinned card never moves, and if what runs into it says it
    cannot happen that early, you get told rather than quietly overruled.

  On a freshly tidied trip, Resolve reports no change — which is the property
  worth having, and is asserted in the test suite.

#### The time layer

A board that only knew the date would be hard to plan a day with, so the clock
is legible on it without any of it becoming a grid. **Times** in the toolbar
turns on three readouts, all derived from the cards rather than from the layout:

- A **ribbon** under each day frame: when the day starts and ends, how much of
  it is spoken for, where the longest clear stretch is, and a 24-hour track
  with a block per card. Click a block to jump to its card. A day that runs
  past midnight is marked `+1`.
- A **gap chip** in the gutter between two stacked cards — `1h30`, `no gap`,
  `overlaps 30m`, or `out of order` when the stack says one order and the clock
  says the other. It reads the same columns `resolve.ts` reads, so what the
  seam says is what resolving will do. A pair a connector already labels stays
  quiet, since the connector's own chip already says it.
- The **clock on each card**, as a range you can click and type into: start
  time, length, ±15 minutes. When a card agrees with its frame, the frame
  carries the date and the card carries only the hours; when it disagrees, the
  card says the date in warning ink, because that is a card Resolve will move.

A "clash" here means somebody in two places at once, not two things merely
happening at once — read the same way the issues panel reads it, so two
parallel tracks are not flagged on every day of the trip.

Position still means exactly what it meant. Turning the layer off changes
nothing but what you can see.

Also on the board: **sticky notes** for the things that are not plans yet, a
**roster** pinned to the corner that you drag faces from onto cards, and a
**people-flows** overlay — who actually goes from what to what, derived from
attendance and the clock rather than from anything you drew, bundled so four
travellers making the same hop is one line carrying four faces.

### Getting things in and out

Every view can build the plan, not just read it out, and each one uses the
gesture that suits its shape:

| | |
|---|---|
| **Timeline** | Drag across an empty stretch of lane. The lane decides whose it is — a person lane assigns them, a type lane sets the type, a place lane sets the place. |
| **Day** | The same gesture, downward. Snapped to the quarter-hour of the *displayed* zone, not of UTC. |
| **Trip** and **Agenda** | Neither has an hour to point at, so each day gets a **+** that drops a block on it at ten in the morning for you to move. |
| **Canvas** | The card tool, or the places panel. |
| **Ideas** | The backlog, promoted onto a day when it stops being a maybe. |

A press with no drag makes the default hour, so the gesture works before you
know it is a drag. <kbd>Esc</kbd> mid-draw abandons it.

Removing is <kbd>⌫</kbd> on the selection, from any view, with an undo in the
toast — it used to be a trip to the details panel. On the board it also deletes
notes, frames and connectors, because those are selectable there too.

People are added where people already are: the **+ Add someone** button under
the rail's list, the row below the last lane on the timeline (a lane per person
means another lane *is* another person), and the People view.

**Where a view opens.** On the day the trip starts — or today, if the trip is
happening now. Deliberately not the first day of the *span*: a block left on
today's date by accident should not drag a fortnight of planning back with it,
and since the day cursor is also where the **Add** button drops a block, getting
it wrong compounds. `tripSpan` widens to cover anything scheduled outside the
trip's dates, so nothing is ever hidden — it just does not decide the view.

### Sub-trips

Half the group goes to the beach while the rest stay for the second day of
talks. Select those cards, press **Sub-trip**, choose who peels off: a frame
goes round them, and anything dropped into it from then on joins the sub-trip.
Everyone else carries on, and both are on the same board.

Sub-trips nest — a side trip can itself fork — and dissolving one puts its cards
back on the shared plan rather than deleting them. The analyser checks them
specifically: whether a member is still booked on the main timeline while
supposedly away, and whether the group can physically get back for whatever
everybody does next.

### Places

Search by name against a built-in gazetteer that answers on the first keystroke
and works with no network; live OpenStreetMap results are merged in behind it
when they arrive. Or paste a **Google Maps or OpenStreetMap link** — or bare
coordinates — and the place is pulled straight out of it, time zone inferred
from where it is. Places sit in a shelf you can drag onto any day.

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

**An analyser that reads the plan back to you.** Double bookings, items
scheduled before someone lands or after they leave or outside the window they
gave, short nights, long days with no meal break, unbooked journeys, free
evenings matched against people's stated interests, and both kinds of sub-trip
mistake. Repetitive findings roll up per person per day so the real problems
stay visible.

Journeys get three distinct verdicts, because they call for three different
fixes:

| Verdict | Means | Example |
|---|---|---|
| **Tight** | The cab is slow. Leave earlier, or allow more time. | Taj West End → Koshy's, 2.5 km, two minutes short |
| **Needs a flight** | Nothing on the ground closes the gap, flying does, and no flight is on the plan. | Delhi → Bengaluru with eight hours and no booking |
| **Impossible** | The quickest conceivable route still does not fit. Move something. | Bengaluru → Goa, 560 km, three hours |

The distinction is held to a real margin on purpose. Calling a two-minute
shortfall "impossible" teaches people to ignore the ones that are.

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
  the grid. On the board it is the arrow keys: one grid step, ⇧ for the fine
  one, announced with the frame the card landed in. Satisfies 2.1.1 and 2.5.7.
- **Every icon-only control names itself on hover**, with its shortcut, and
  carries the same wording as its accessible name. Two tools never share a
  glyph.
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

Every icon-only control names itself on hover, shortcut included, and the full
list lives behind <kbd>?</kbd>.

| Anywhere | |
|---|---|
| <kbd>⌘K</kbd> | Command palette — every action by name |
| <kbd>?</kbd> | Shortcut help |
| <kbd>1</kbd>–<kbd>7</kbd> | Jump to a view |
| <kbd>N</kbd> | New block (except on the board, where N is the note tool) |
| <kbd>⌫</kbd> | Delete the selected block |
| <kbd>/</kbd> | Search |
| <kbd>[</kbd> <kbd>]</kbd> | Previous / next day |
| <kbd>\</kbd> | Toggle the filter rail |
| <kbd>⌘Z</kbd> / <kbd>⌘⇧Z</kbd> | Undo / redo |
| <kbd>⌘</kbd> + scroll | Zoom the time axis |

| On the board | |
|---|---|
| <kbd>V</kbd> <kbd>H</kbd> <kbd>C</kbd> <kbd>N</kbd> <kbd>F</kbd> <kbd>L</kbd> | Select, pan, card, note, frame, connect |
| <kbd>Space</kbd> held | Pan with any tool |
| <kbd>⌘A</kbd> | Select every card |
| arrows | Move the selection one grid step — <kbd>⇧</kbd> for four pixels |
| <kbd>⌫</kbd> | Delete what is selected: cards, a note, a frame, a connector |
| <kbd>P</kbd> | Pin or unpin the selection |
| <kbd>T</kbd> | Set the time on the selected card |
| <kbd>+</kbd> <kbd>−</kbd> <kbd>0</kbd> | Zoom in, out, fit |
| <kbd>⌘⏎</kbd> | Resolve the board onto the timeline |

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
    board.ts       the board: viewport maths, containment, connectors, layout
    resolve.ts     board → timeline: the pass that hands out times
    timelayer.ts   the clock read off the board: day ribbons, gutter gaps
    branch.ts      sub-trips — spans, nesting, split and rejoin points
    geo.ts         place search, map-link parsing, timezone from coordinates
    library.ts     the trip library, migration and duplication
    store.ts       reducer, undo/redo, persistence
    ics.ts         RFC 5545 export
    pack.ts        compact wire format for share links
    share.ts       link encoding, JSON import/export
    clock.ts       which zone the UI renders in
  components/    views and chrome
    CanvasView.tsx the board — tools, cards, frames, stickies, connectors
    BoardTime.tsx  the time layer on screen — day ribbons, gap chips, time editor
    TripsView.tsx  the library landing page
    PersonSheet.tsx  add or edit a traveller
    PlaceSearch.tsx  search, paste a map link, or type coordinates
    Tour.tsx       the first-run walkthrough
    ViewHint.tsx   the one-line description under each view's toolbar
  Root.tsx       routing between the library and one open trip
  hooks/         drag machine, toasts, hotkeys, focus trap
  data/          the worked conference example
test/run.ts      231 assertions, no framework
```

**Invariants worth knowing**

- Every instant in the model is UTC epoch milliseconds. Naive wall-clock values
  exist only as an explicit `{parts, zone}` pair crossing `time.ts`.
- `snapMin: 0` in a move or resize action means "apply this delta exactly" and
  is what the keyboard path uses.
- Never transition the `background` shorthand — it strands elements on a stale
  colour when a theme token changes. Use `background-color`.
- **The board stores positions; the calendar stores times; `resolve.ts` is the
  only thing that turns one into the other.** Neither derives from the other
  implicitly, which is what lets a card sit somewhere meaningless without
  corrupting the plan.
- **`toWorld` and `toScreen` are exact inverses, and `zoomAt` holds the point
  under the cursor.** Both are asserted at an awkward zoom rather than at 1;
  every drop position on the board depends on them.
- **A frame's `dayKey` is always read in `trip.baseTimezone`,** never in the
  segment's zone or the display clock. The board is one shared artefact and must
  not re-bucket itself when somebody switches to another traveller's clock — an
  overnight flight out of London is on the day the *trip* thinks it is. Getting
  this wrong shifted every red-eye by a day.
- **`turnaroundMin` defaults to zero.** Lunch ending as the afternoon session
  begins is a normal thing for a plan to say; inventing ten minutes of slack
  there rewrote thirty cards of a perfectly good schedule.
- **Drag tracking is wired up synchronously from `pointerdown`,** not from an
  effect. An effect only runs after React commits, and a fast gesture can land
  its first move before that — which silently drops the drag.
- **Do not name a plain-`div` overlay `.modal`.** The older dialogs here are real
  `<dialog class="modal">` elements, and a bare `.modal { display: grid }`
  outranks the user-agent rule that hides a closed one, so every dialog in the
  app renders at once. The new sheets use `.sheet`.
- **A block never renders a line it has no room for.** Blocks have a height set
  by the grid, not by their contents, and text that overflows a fixed-height box
  does not clip politely — it paints over the line below it and outside the
  block's own border. So the caller measures first and tells `SegmentChrome` how
  many lines fit; the timeline drops the place, then the clock, then the title,
  leaving a sliver with just its icon. For the same reason nothing inside a
  block may be a flex or grid item that is allowed to shrink below its line box.

## State

Autosaves to `localStorage`, one key per trip (`planit.trip.v2.<id>`) plus a
small index (`planit.library.v2`), so a large trip is not rewritten every time
an unrelated one is touched and a corrupt trip loses one trip rather than all of
them. A plan saved by the earlier single-trip build is adopted into the library
once, automatically. Clear those keys to reset.

Nothing leaves the browser except OSRM route lookups, OpenStreetMap tiles, and
Nominatim place searches — coordinates and search terms only. All three fail
silently: the offline estimate, a blank tile and the built-in gazetteer are
always the floor, so the app works with the network switched off.

# Windlass

Windlass is a map and canal-routing project for the London waterways listed in
[`SCOPE.md`](./SCOPE.md).

## Requirements

- Node.js 20.19+ or 22.12+
- npm

## Run the map

```sh
npm install
npm run dev
```

### Load performance

Cold load (empty cache) of the gzipped production build, on a phone-sized
screen. Median of three runs:

| Network | Panel appears | Canals on the map | Background map fully drawn |
| --- | --- | --- | --- |
| No throttling | 0.4 s | 0.7 s | 3.0 s |
| Fast 4G (9 Mbps, 60 ms latency) | **1.0 s** | **1.15 s** | 3.6 s |
| Slow 4G (1.6 Mbps, 150 ms latency) | 2.6 s | 2.8 s | 6.8 s |

- **Panel appears:** the route planner can be used.
- **Canals on the map:** the canal network, locks and marinas are drawn and
  can be clicked.
- **Background map fully drawn:** every OSM background tile has loaded.

#### How it got there

On Fast 4G:

| Step | Panel | Canals | Fully drawn | Background tiles |
| --- | --- | --- | --- | --- |
| Starting point | 1.05 s | 2.80 s | 5.35 s | 1.3 MB |
| Canal layers don't wait for tiles; map opens on the canal network | 1.06 s | 1.34 s | 3.61 s | 0.4 MB |
| Compact graph format | 1.00 s | 1.15 s | 3.59 s | 0.4 MB |

- **Canal layers don't wait for background tiles.** They're added on MapLibre's
  `style.load` event, which fires as soon as the map's style is ready. They used
  to be added on `load`, which also waits for the first OSM background tiles to
  download, so the canals appeared over a second later than they needed to.
- **The map opens on the canal network.** It's created with the network's
  bounds. It used to open on a zoom-10 view of London and then jump to the canals
  once loaded, so the first batch of tiles was downloaded and thrown away. This
  cut background tile downloads from 1.3 MB to 0.4 MB.
- **Compact graph.** The app loads `data/graph/graph.compact.json` (8.5 KB
  gzipped) instead of the indented `graph.json` (31.5 KB), cutting the main
  bundle from 396 KB to 371 KB gzipped. See
  [Build the OpenStreetMap graph](#build-the-openstreetmap-graph) for the format.

Tried and not kept:

- **Preloading the MapLibre web worker.** A worker doesn't reuse a module
  preloaded by the page, so the browser downloaded the 140 KB worker twice and
  the panel got slower.
- **A binary graph format.** It saved under 1 KB over the compact JSON once
  gzipped, which wasn't worth a harder-to-debug format.
- **Loading MapLibre separately and switching to vector tiles.** This brought
  the panel to 0.5 s on Fast 4G, but changed how the app loads and how the map
  looks, so it wasn't adopted.

Most of what remains is the single 371 KB JavaScript bundle, which is mostly
MapLibre, and the OSM background tiles.

#### How it was measured

The production build (`npm run build`) was served from a local server with
gzip, as a host would, and loaded in headless Chrome over the DevTools protocol:

- Cache cleared before every load.
- Phone screen: 390 × 844 at 3× pixel density.
- Network throttled to Chrome's Fast 4G profile, or to Lighthouse's Slow 4G
  mobile default.
- Times are from navigation start. "Panel appears" is when the planner's button
  is in the page, "Canals on the map" is when the lock layer exists, and "Fully
  drawn" is when MapLibre reports every tile loaded and the map idle.
- Each step was compared with the previous build in the same session.
  Separate sessions vary by about 0.1 s.

## Build the OpenStreetMap graph

Fetch the OSM snapshot and the Canal & River Trust lock data for the region
polygon, then build and check the graph:

```sh
npm run osm:fetch
npm run crt:fetch
npm run graph
```

`osm:fetch` reads `data/region/london-mvp.geojson` and writes the full Overpass
response to `data/osm/raw.json`. It includes waterway ways, lock and winding
features, bridge ways, marinas, and the named start and finish landmarks. Set
`OVERPASS_URL` to use a specific Overpass API endpoint.

`crt:fetch` downloads the locks inside the region's bounding box from the
[Canal & River Trust open data portal](https://data-canalrivertrust.opendata.arcgis.com)
(`Canal_And_River_Trust_Locks_View`) and writes them to `data/crt/locks.geojson`.

`graph` reads that snapshot, keeps named canal and Lee waterway ways that match
the route in `SCOPE.md`, splits them into typed nodes and edges, measures edge
lengths, and adds bridge crossings. It writes `data/graph/graph.json` and prints
`CONNECTED` when Packet Boat Marina and Pickett's Lock snap to the same graph
component. At Bulls Bridge, it removes the Grand Union continuation beyond the
Paddington junction only when that edge is not needed to connect the endpoints.
It trims the route at the two ends of the scope, keeping Uxbridge Lock and
Pickett's Lock themselves but dropping the waterway beyond them (Denham Deep Lock
and the Lee above Pickett's). Waterways tagged `boat=no` or `motorboat=no`, such
as the disused chamber beside Acton's Lock, are left out so routes cannot bypass
a lock. Locks are also excluded by their OSM `lock_name`, which keeps out
Limehouse Ship Lock (to the tidal Thames) and Thames Lock at Brentford. Any
pieces left cut off from the route by these exclusions are dropped and listed
by name, so a real mapping gap is still visible.

When `data/crt/locks.geojson` is present, `graph` cross-checks every lock
against it. Each lock edge is matched to the nearest CRT lock chamber within
40 m, closest pairs first, so twin chambers pair up one to one. Matched edges
take the CRT name, lock number (such as `1A`), waterway and asset id
(`sap_func_loc`). CRT drops apostrophes (`Actons Lock`), so these are restored
from the OSM name. The build fails if a graph lock has no CRT match or if a
CRT lock chamber on the route is missing from the graph. Bow Locks and
Limehouse Ship Lock are listed as deliberately out of scope. Named OSM marinas
within 150 m of the route are written to `graph.json` for the map.

`graph` also writes `data/graph/graph.compact.json`, which is what the map
loads (`graph.json` stays as the full output for inspection). It keeps only
what routing and display need: node types and coordinates, edge lengths, lock
flags and names, bridges, marinas and the two anchors. OSM ids and tags are
dropped. Nodes and edges are flat integer arrays referred to by index,
coordinates are rounded to 1e-5 degrees (about 1 m) and delta-encoded, lengths
are stored in decimetres, and edge lines are simplified with Douglas–Peucker to
2 m. The format is described in `scripts/graph-codec.mjs`. Travel times are not
stored, because they depend on the lock pace and speed chosen in the planner;
routing derives them from each edge's surveyed length and lock flag, so routes
match the full graph. This cuts the shipped graph from 31.5 KB to 8.5 KB
gzipped. A binary version was tried and saved under 1 KB more, so it was not
adopted.

It also reports the number of graph components; more than one means there are
disconnected mapped sections to inspect. If the endpoint check fails, it reports
missing anchors or the closest vertices across the gap.

The map draws the waterways with symbols for features: a lock chamber turned
to lie along the canal (labelled with its CRT number and name from zoom 13),
junctions, winding holes, marinas (an anchor) and bridges. Toggles show or hide
locks and other features, bridges, marinas and the region boundary. Use “Show
full route” to fit the canal network in view, and click a symbol or line for
its details; a lock shows its waterway and CRT asset id.

The panel collapses with the chevron in its header. On a phone it starts
collapsed and folds away when you pick route points, so the map stays visible.
The collapsed bar still shows the route, your position and progress, and the
"tap the map" prompt with Cancel. On touch screens a quick tap on the map acts
as a click, because MapLibre otherwise swallows it.

The app icon is an original narrowboat drawing (`public/favicon.svg`), with PNG
versions and a web manifest, so **Add to Home Screen** on a phone shows the
boat and the name Windlass.

To plan a trip, choose a lock working pace (slow, medium or fast), press “Pick
start and finish”, then click the map twice. Each click snaps to the nearest
canal and is rejected if it is more than 500 m away. The fastest route is drawn
with its locks marked. The panel shows the total time, distance, cruising time
and lock time, plus the locks in order. Drag either marker to adjust the route;
changing the pace recalculates it straight away. Press Esc to cancel picking.

**Data licences** (details in [`data/LICENSE.md`](data/LICENSE.md)):

- **OpenStreetMap:** waterways, bridges, marinas and the background map tiles
  are © OpenStreetMap contributors, under the
  [Open Database License (ODbL)](https://www.openstreetmap.org/copyright). The
  graph files built from them are offered under the ODbL too.
- **Canal & River Trust:** lock data is © Canal & River Trust copyright and
  database rights reserved, and © Crown copyright and database rights, Ordnance
  Survey 100022432. It contains public sector information licensed under the
  [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).

The map's attribution line credits both.

## Routing

`scripts/route-lib.mjs` finds the fastest route between two points on the
graph. `findRoute(graph, [lon, lat], [lon, lat], { lockSpeed, speedKmh })`
snaps each point to the nearest spot on any canal edge (up to 500 m away) and
returns the route line, distance, cruising and lock time, and the locks passed
in order.

### Cost model

The route minimises total travel time, not distance:

```
time = distance / cruising speed + locks passed × time per lock
```

| Setting | Value |
| --- | --- |
| Cruising speed | 6.4 km/h (4 mph, the Canal & River Trust speed limit), set with `speedKmh` |
| Lock time, `slow` | 30 minutes per lock |
| Lock time, `medium` (default) | 20 minutes per lock |
| Lock time, `fast` | 10 minutes per lock |

- Each lock costs the same fixed time, whatever its depth.
- A lock counts once it is passed through end to end. A start or finish point
  inside a lock chamber does not count that lock.
- Twin chambers are parallel edges, so a route only ever passes through one of them.
- The shortest path is found with Dijkstra's algorithm over edge times. Since
  lock time is part of the cost, the lock pace can change which way round the
  network is fastest. A short route with many locks can win at `fast` and lose
  at `slow` to a longer route with fewer locks.

For example, Packet Boat Marina to Pickett's Lock is 51.1 km with 14 locks. That
takes about 8 h of cruising, so roughly 15 h in total at `slow`, 12 h 40 m at
`medium` and 10 h 20 m at `fast`.

## Show my position

Press **Show my position** to put a blue dot on the canal where you are. The
browser asks for location permission the first time. Your position stays on
your device and isn't stored or sent anywhere.

- The dot is snapped onto the canal. A faint circle around it shows the raw GPS
  fix and its reported accuracy.
- The map follows you until you pan it; **Re-centre on me** follows again.
- With a route planned, the panel shows the time and distance left, the locks
  left and the next lock. **Re-plan from here** (or **Start a route from here**)
  plans from your position.
- The status line says when it's finding you, when GPS is weak, when you're away
  from the canal or route, and when location is blocked or unavailable.

Location only works on a secure page: `https://`, or `localhost` while
developing.

### Tracking

`scripts/track-lib.mjs` turns raw GPS fixes into the position shown:

- **With a planned route**, each fix is matched to the route line, close to
  where the boat was, so a fix can't match a far part of the route. Progress
  along it never goes backwards.
- **Without a route**, each fix is snapped onto the canal network, preferring
  the current canal and edges joined to it within 60 m along the canal.
- **Smoothing:** an alpha–beta filter tracks position and speed, so GPS noise
  doesn't make the dot jump about while a moving boat isn't left behind.
- **Junctions and locks:** the dot only moves onto another branch when a fix is
  clearly (8 m) nearer it, so one noisy fix near a side branch can't send it the
  wrong way. When it runs off the end of a short edge, such as a lock chamber,
  it carries on to the next one.
- **Glitches:** a fix with accuracy worse than 100 m is ignored. A fix that would
  need more than 15 km/h, or one on a canal not joined to the current one, is
  held until 3 fixes in a row agree.

### Simulated GPS

Add `?simulate` to the URL to replay a boat instead of using the device's GPS:
`?simulate` runs at 30× real time, `?simulate=60` at 60×. The boat travels the
planned route, or Packet Boat Marina to Pickett's Lock if none is planned. It
cruises at 6.4 km/h, waits the lock time at each lock, and has realistic GPS
noise with an occasional glitch.

The tests run the same simulation over the whole Packet Boat Marina to
Pickett's Lock route, with and without a planned route, at every lock pace and
across several random seeds. They check that the dot never moves more than
30 m between 5-second fixes, never leaves the route, stays within 30 m of the
boat, and arrives with every lock passed. In a wider sweep (20 seeds, 6 m of GPS
noise) the largest step was 26 m. With poor GPS (10 m of noise) and no planned
route, a few steps of up to about 39 m remain, mostly at Little Venice junction.

## Deployment

`.github/workflows/deploy.yml` builds the site and publishes it to GitHub Pages
at **https://thhheo98.github.io/windlass/** on every push to `main`, after the
tests and lint pass. GitHub Pages serves over HTTPS, which location needs.
`vite.config.ts` sets the `/windlass/` base path for builds and
`npm run preview`; the dev server stays at `/`.

## Validate the graph code

```sh
npm test
npm run lint
```

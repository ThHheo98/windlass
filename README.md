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

To plan a trip, choose a lock working pace (slow, medium or fast), press “Pick
start and finish”, then click the map twice. Each click snaps to the nearest
canal and is rejected if it is more than 500 m away. The fastest route is drawn
with its locks marked. The panel shows the total time, distance, cruising time
and lock time, plus the locks in order. Drag either marker to adjust the route;
changing the pace recalculates it straight away. Press Esc to cancel picking.

Raw OSM data is made available under the Open Database License (ODbL); the
snapshot includes the attribution returned by OpenStreetMap. Lock data is
© Canal & River Trust copyright and database rights reserved, and © Crown
copyright and database rights, Ordnance Survey 100022432, used under the
[CRT data licence](https://canalrivertrust.org.uk/refresh/media/thumbnail/26503-CRT-Data-Licence.pdf).

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

## Validate the graph code

```sh
npm test
npm run lint
```

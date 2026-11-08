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

Fetch the OSM snapshot for the region polygon, then build and check the graph:

```sh
npm run osm:fetch
npm run graph
```

`osm:fetch` reads `data/region/london-mvp.geojson` and writes the full Overpass
response to `data/osm/raw.json`. It includes waterway ways, lock and winding
features, bridge ways, and the named start and finish landmarks. Set
`OVERPASS_URL` to use a specific Overpass API endpoint.

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
a lock. Each lock edge keeps its OSM `lock_name` (or a `lock_ref` that names it).
It also reports the number of graph components; more than one means there are
disconnected mapped sections to inspect. If the endpoint check fails, it reports
missing anchors or the closest vertices across the gap.

The map displays the generated graph, with toggles for graph nodes, bridge
crossings, and the region boundary. Use “Show full route” to fit the canal
network in view, and click a graph feature to inspect its OSM details.

Raw OSM data is made available under the Open Database License (ODbL); the
snapshot includes the attribution returned by OpenStreetMap.

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

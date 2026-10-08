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
It also reports the number of graph components; more than one means there are
disconnected mapped sections to inspect. If the endpoint check fails, it reports
missing anchors or the closest vertices across the gap.

The map displays the generated graph, with toggles for graph nodes, bridge
crossings, and the region boundary. Use “Show full route” to fit the canal
network in view, and click a graph feature to inspect its OSM details.

Raw OSM data is made available under the Open Database License (ODbL); the
snapshot includes the attribution returned by OpenStreetMap.

## Validate the graph code

```sh
npm test
npm run lint
```

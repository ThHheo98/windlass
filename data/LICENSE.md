# Data licences

The files in `data/` come from two sources with different licences.

## OpenStreetMap: ODbL 1.0

- `osm/raw.json`: an OpenStreetMap snapshot downloaded through the Overpass API.
- `graph/graph.json` and `graph/graph.compact.json`: the canal graph built from
  that snapshot. They also include lock names, numbers and asset ids taken from
  the Canal & River Trust data below.

© OpenStreetMap contributors. These files are made available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
The graph files are derived databases of OpenStreetMap data, so they are offered
under the same licence. See <https://www.openstreetmap.org/copyright>.

## Canal & River Trust: Open Government Licence v3.0

- `crt/locks.geojson`: lock assets from the Canal & River Trust open data portal
  (`Canal_And_River_Trust_Locks_View`,
  <https://data-canalrivertrust.opendata.arcgis.com>).

© Canal & River Trust copyright and database rights reserved. © Crown copyright
and database rights, Ordnance Survey 100022432.

Contains public sector information licensed under the
[Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).

## This project

- `region/london-mvp.geojson`: the region outline, drawn for this project.

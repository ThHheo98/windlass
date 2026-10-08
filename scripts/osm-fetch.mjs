import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const polygonPath = resolve(root, 'data/region/london-mvp.geojson')
const outputPath = resolve(root, 'data/osm/raw.json')
const endpoints = [
  process.env.OVERPASS_URL,
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
].filter(Boolean)

function getPolygon(featureCollection) {
  const polygon = featureCollection.features?.find(
    (feature) => feature.geometry?.type === 'Polygon',
  )?.geometry
  const ring = polygon?.coordinates?.[0]

  if (
    !ring ||
    ring.length < 4 ||
    JSON.stringify(ring[0]) !== JSON.stringify(ring.at(-1))
  ) {
    throw new Error(`${polygonPath} must contain a closed GeoJSON Polygon ring`)
  }

  for (const coordinate of ring) {
    if (
      !Array.isArray(coordinate) ||
      coordinate.length < 2 ||
      !Number.isFinite(coordinate[0]) ||
      !Number.isFinite(coordinate[1])
    ) {
      throw new Error(`${polygonPath} contains an invalid [longitude, latitude] position`)
    }
  }

  return ring.map(([longitude, latitude]) => `${latitude} ${longitude}`).join(' ')
}

function buildQuery(polygon) {
  return `[out:json][timeout:180];
(
  way(poly:"${polygon}")["waterway"];
  way(poly:"${polygon}")["lock"="yes"];
  nwr(poly:"${polygon}")["waterway"~"^(lock_gate|turning_point)$"];
  way(poly:"${polygon}")["bridge"~"^(yes|movable|viaduct|aqueduct|covered|boardwalk|low_water_crossing)$"];
  way(poly:"${polygon}")["man_made"="bridge"];
  nwr(poly:"${polygon}")["name"~"Packet Boat Marina|Pickett.?s Lock|Alfie.?s Lock",i];
);
out body geom;`
}

function validateResponse(data, endpoint) {
  if (!Array.isArray(data.elements)) {
    throw new Error(`${endpoint} returned JSON without an elements array`)
  }

  const waterways = data.elements.filter(
    (element) => element.type === 'way' && element.tags?.waterway,
  )
  if (waterways.length === 0) {
    throw new Error(`${endpoint} returned no waterway ways; refusing to write an empty snapshot`)
  }

  return waterways.length
}

async function main() {
  const featureCollection = JSON.parse(await readFile(polygonPath, 'utf8'))
  const query = buildQuery(getPolygon(featureCollection))
  const failures = []

  for (const endpoint of [...new Set(endpoints)]) {
    try {
      console.log(`Fetching OSM data from ${endpoint}`)
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'user-agent': 'Windlass canal graph pipeline',
          accept: 'application/json',
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(210_000),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      const waterways = validateResponse(data, endpoint)
      await mkdir(dirname(outputPath), { recursive: true })
      await writeFile(outputPath, `${JSON.stringify(data, null, 2)}\n`)
      console.log(
        `Saved ${data.elements.length} OSM elements (${waterways} waterway ways) to data/osm/raw.json.`,
      )
      if (data.osm3s?.timestamp_osm_base) {
        console.log(`OSM snapshot timestamp: ${data.osm3s.timestamp_osm_base}`)
      }
      return
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      failures.push(`${endpoint}: ${detail}`)
      console.error(`Fetch failed: ${detail}`)
    }
  }

  throw new Error(`All Overpass endpoints failed:\n${failures.join('\n')}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

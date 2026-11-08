import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Canal & River Trust open data: Locks (data-canalrivertrust.opendata.arcgis.com).
const LOCKS_URL =
  'https://services.arcgis.com/DknzyjEEie5tEW0u/arcgis/rest/services/Canal_And_River_Trust_Locks_View/FeatureServer/0/query'
const FIELDS = ['sap_func_loc', 'sap_description', 'sap_object_type', 'waterway_name']

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const polygonPath = resolve(root, 'data/region/london-mvp.geojson')
const outputPath = resolve(root, 'data/crt/locks.geojson')

async function main() {
  const region = JSON.parse(await readFile(polygonPath, 'utf8'))
  const ring = region.features?.find((feature) => feature.geometry?.type === 'Polygon')
    ?.geometry.coordinates[0]
  if (!ring) throw new Error(`${polygonPath} must contain a GeoJSON Polygon`)

  const lons = ring.map(([lon]) => lon)
  const lats = ring.map(([, lat]) => lat)
  const params = new URLSearchParams({
    where: '1=1',
    geometry: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)].join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: FIELDS.join(','),
    outSR: '4326',
    orderByFields: 'sap_func_loc',
    f: 'geojson',
  })

  console.log('Fetching Canal & River Trust locks')
  const response = await fetch(`${LOCKS_URL}?${params}`, {
    headers: { 'user-agent': 'Windlass canal graph pipeline', accept: 'application/geo+json' },
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)

  const data = await response.json()
  if (!Array.isArray(data.features) || data.features.length === 0) {
    throw new Error('CRT returned no lock features; refusing to write an empty file')
  }
  if (data.properties?.exceededTransferLimit || data.exceededTransferLimit) {
    throw new Error('CRT response was truncated; page the query before using it')
  }

  const output = {
    type: 'FeatureCollection',
    source: 'Canal & River Trust open data: Canal_And_River_Trust_Locks_View',
    attribution:
      '© Canal & River Trust copyright and database rights reserved. © Crown copyright and database rights, Ordnance Survey 100022432.',
    licence:
      'Contains public sector information licensed under the Open Government Licence v3.0 (https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).',
    fetchedAt: new Date().toISOString(),
    features: data.features.map(({ type, geometry, properties }) => ({
      type,
      geometry,
      properties: Object.fromEntries(FIELDS.map((field) => [field, properties[field] ?? null])),
    })),
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`)

  const chambers = output.features.filter((feature) => feature.properties.sap_object_type === '010')
  console.log(
    `Saved ${output.features.length} CRT lock assets (${chambers.length} lock chambers) to data/crt/locks.geojson.`,
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

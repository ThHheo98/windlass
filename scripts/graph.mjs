import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGraph } from './graph-lib.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inputPath = resolve(root, 'data/osm/raw.json')
const outputPath = resolve(root, 'data/graph/graph.json')

async function main() {
  const raw = JSON.parse(await readFile(inputPath, 'utf8'))
  const { graph, summary } = buildGraph(raw)

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        osmTimestamp: raw.osm3s?.timestamp_osm_base ?? null,
        ...graph,
      },
      null,
      2,
    )}\n`,
  )

  console.log(`OSM waterway ways: ${summary.rawWaterwayWays}`)
  console.log(`In-scope canal/lock ways: ${summary.includedWaterwayWays}`)
  console.log(`Excluded waterway ways: ${summary.excludedWaterwayWays}`)
  console.log(`Graph edges: ${summary.edgeCount}`)
  console.log(`Connected components: ${summary.componentCount}`)
  console.log(
    `Nodes: ${Object.entries(summary.nodesByType)
      .map(([type, count]) => `${type} ${count}`)
      .join(', ')}`,
  )
  console.log(`Bridge crossings: ${summary.bridgeCount}`)
  console.log(`Off-line winding holes for Session 3: ${summary.offLineWindingCount}`)
  console.log(`Packet Boat Marina: ${formatAnchor(summary.start)}`)
  console.log(`Pickett's Lock: ${formatAnchor(summary.finish)}`)

  if (summary.connected) {
    console.log(
      summary.componentCount === 1 ? 'CONNECTED' : 'ENDPOINTS CONNECTED; CHECK COMPONENTS',
    )
    if (summary.componentCount !== 1) process.exitCode = 1
    return
  }

  console.error('NOT CONNECTED')
  if (!summary.start) {
    console.error('Could not snap Packet Boat Marina to a graph node within 1.5 km.')
  }
  if (!summary.finish) {
    console.error("Could not snap Pickett's Lock to a graph node within 1.5 km.")
  }
  if (summary.gap) {
    console.error(
      `Closest disconnected vertices: ${summary.gap.from.name ?? summary.gap.from.id} ` +
        `(${summary.gap.from.lon}, ${summary.gap.from.lat}) to ` +
        `${summary.gap.to.name ?? summary.gap.to.id} ` +
        `(${summary.gap.to.lon}, ${summary.gap.to.lat}), ` +
        `${Math.round(summary.gap.distanceM)} m apart.`,
    )
  }
  console.error(`Graph written to data/graph/graph.json for inspection.`)
  process.exitCode = 1
}

function formatAnchor(anchor) {
  if (!anchor) return 'not found'
  return `${anchor.feature} -> node ${anchor.vertexId} (${Math.round(anchor.distanceM)} m)`
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

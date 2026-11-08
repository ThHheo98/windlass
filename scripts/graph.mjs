import { access, readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { encodeGraph, SIMPLIFY_TOLERANCE_M } from './graph-codec.mjs'
import { buildGraph } from './graph-lib.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inputPath = resolve(root, 'data/osm/raw.json')
const outputPath = resolve(root, 'data/graph/graph.json')
const compactPath = resolve(root, 'data/graph/graph.compact.json')
const crtLocksPath = resolve(root, 'data/crt/locks.geojson')

async function readCrtLocks() {
  try {
    await access(crtLocksPath)
  } catch {
    return null
  }
  return JSON.parse(await readFile(crtLocksPath, 'utf8'))
}

async function main() {
  const raw = JSON.parse(await readFile(inputPath, 'utf8'))
  const crtLocks = await readCrtLocks()
  const { graph, summary } = buildGraph(raw, { crtLocks })

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

  // The browser loads the compact version; graph.json stays for inspection.
  const fullGraph = { osmTimestamp: raw.osm3s?.timestamp_osm_base ?? null, ...graph }
  const compactText = JSON.stringify(encodeGraph(fullGraph))
  await writeFile(compactPath, `${compactText}\n`)

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
  console.log(
    `Compact graph: ${(compactText.length / 1024).toFixed(1)} KB, ` +
      `${(gzipSync(compactText).length / 1024).toFixed(1)} KB gzipped ` +
      `(lines simplified to ${SIMPLIFY_TOLERANCE_M} m) -> data/graph/graph.compact.json`,
  )
  console.log(`Marinas beside the route: ${graph.marinas.length}`)
  if (summary.droppedEdges.length > 0) {
    console.log(
      `Dropped ${summary.droppedEdges.length} edges cut off from the route: ` +
        summary.droppedEdges
          .map((edge) => `${edge.name ?? edge.id} (${Math.round(edge.lengthM)} m)`)
          .join(', '),
    )
  }
  const crtOk = reportCrt(summary.crt)
  console.log(`Off-line winding holes for Session 3: ${summary.offLineWindingCount}`)
  console.log(`Packet Boat Marina: ${formatAnchor(summary.start)}`)
  console.log(`Pickett's Lock: ${formatAnchor(summary.finish)}`)

  if (summary.connected) {
    console.log(
      summary.componentCount === 1 ? 'CONNECTED' : 'ENDPOINTS CONNECTED; CHECK COMPONENTS',
    )
    if (summary.componentCount !== 1 || !crtOk) process.exitCode = 1
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

function reportCrt(crt) {
  if (!crt) {
    console.log('CRT lock check: skipped (run npm run crt:fetch first)')
    return true
  }
  console.log(`CRT lock check: ${crt.matched}/${crt.lockEdges} lock chambers matched`)
  for (const lock of crt.outOfScopeCrtLocks) {
    console.log(`  Out of scope: ${lock.description} (${lock.crtId}): ${lock.reason}`)
  }
  for (const lock of crt.unmatchedGraphLocks) {
    console.error(`  No CRT lock within 40 m of graph lock ${lock.name ?? lock.id}`)
  }
  for (const lock of crt.missingCrtLocks) {
    console.error(
      `  CRT lock on the route but missing from the graph: ${lock.description} [${lock.waterway}] (${lock.crtId})`,
    )
  }
  return crt.unmatchedGraphLocks.length === 0 && crt.missingCrtLocks.length === 0
}

function formatAnchor(anchor) {
  if (!anchor) return 'not found'
  return `${anchor.feature} -> node ${anchor.vertexId} (${Math.round(anchor.distanceM)} m)`
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

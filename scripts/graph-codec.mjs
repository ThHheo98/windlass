// Compact graph format shipped to the browser.
//
// Everything is flat integer arrays with fixed strides; nodes and edges are
// referred to by array index, strings by index into `strings`. Coordinates are
// integers in units of 1e-5 degrees (about 1.1 m) and edge interior points are
// delta-encoded from the previous point. Lengths are integers in decimetres.
// Travel time is not stored: it depends on the chosen lock pace and speed, so
// route-lib derives it from each edge's length and lock flag.
//
//   nodes     [x, y, type, name] per node        (type indexes NODE_TYPES, name -1 if none)
//   edges     [a, b, lengthDm, flags, name, points] per edge
//             flags bit 0 = lock chamber; points = interior points stored in `geometry`
//   geometry  [dx, dy, ...] interior points of every edge, in edge order
//   locks     [edge, name, number, waterway, crtId] per lock chamber with names
//   bridges   [edge, atDm, name] per bridge crossing
//   marinas   [x, y, name] per marina
//   anchors   [startNode, startName, finishNode, finishName] (-1 when missing)

import { haversineM } from './graph-lib.mjs'

export const GRAPH_FORMAT = 'windlass-graph'
export const GRAPH_VERSION = 1
export const NODE_TYPES = ['join', 'end', 'junction', 'lock', 'winding']
export const SIMPLIFY_TOLERANCE_M = 2

const SCALE = 1e5
const NODE_STRIDE = 4
const EDGE_STRIDE = 6
const LOCK_STRIDE = 5
const BRIDGE_STRIDE = 3
const MARINA_STRIDE = 3
const FLAG_LOCK = 1

const toInt = (degrees) => Math.round(degrees * SCALE)
const fromInt = (value) => value / SCALE

/** Douglas–Peucker simplification with a tolerance in metres. Keeps both ends. */
export function simplifyLine(coords, toleranceM = SIMPLIFY_TOLERANCE_M) {
  if (coords.length <= 2) return coords.slice()

  const originLat = coords[0][1]
  const kx = 111_320 * Math.cos((originLat * Math.PI) / 180)
  const ky = 110_540
  const xy = coords.map(([lon, lat]) => [lon * kx, lat * ky])
  const keep = new Uint8Array(coords.length)
  keep[0] = 1
  keep[coords.length - 1] = 1

  const stack = [[0, coords.length - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop()
    const [ax, ay] = xy[first]
    const [bx, by] = xy[last]
    const dx = bx - ax
    const dy = by - ay
    const lengthSq = dx * dx + dy * dy
    let farthest = -1
    let farthestM = 0
    for (let i = first + 1; i < last; i += 1) {
      const [px, py] = xy[i]
      const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
      const distanceM = Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
      if (distanceM > farthestM) {
        farthestM = distanceM
        farthest = i
      }
    }
    if (farthest !== -1 && farthestM > toleranceM) {
      keep[farthest] = 1
      stack.push([first, farthest], [farthest, last])
    }
  }
  return coords.filter((_, i) => keep[i])
}

/** Encode the full pipeline graph (graph.json) into the compact format. */
export function encodeGraph(graph, { toleranceM = SIMPLIFY_TOLERANCE_M } = {}) {
  const strings = []
  const stringIndex = new Map()
  const str = (value) => {
    if (value === undefined || value === null || value === '') return -1
    if (!stringIndex.has(value)) {
      stringIndex.set(value, strings.length)
      strings.push(value)
    }
    return stringIndex.get(value)
  }

  const nodeIndex = new Map(graph.nodes.map((node, i) => [String(node.id), i]))
  const indexOf = (id) => {
    const index = nodeIndex.get(String(id))
    if (index === undefined) throw new Error(`Edge refers to unknown node ${id}`)
    return index
  }

  const nodes = []
  for (const node of graph.nodes) {
    const type = NODE_TYPES.indexOf(node.type)
    if (type === -1) throw new Error(`Unknown node type ${node.type}`)
    nodes.push(toInt(node.lon), toInt(node.lat), type, str(node.name))
  }

  const edges = []
  const geometry = []
  const locks = []
  const bridges = []
  graph.edges.forEach((edge, edgeIndex) => {
    const a = indexOf(edge.a)
    const b = indexOf(edge.b)
    // Ends are the nodes' own coordinates, so only interior points are stored.
    const interior = simplifyLine(edge.coords, toleranceM).slice(1, -1)
    let [px, py] = [nodes[a * NODE_STRIDE], nodes[a * NODE_STRIDE + 1]]
    for (const [lon, lat] of interior) {
      const [x, y] = [toInt(lon), toInt(lat)]
      geometry.push(x - px, y - py)
      ;[px, py] = [x, y]
    }
    edges.push(
      a,
      b,
      Math.round(edge.lengthM * 10),
      edge.lock ? FLAG_LOCK : 0,
      str(edge.name),
      interior.length,
    )
    if (edge.lock && (edge.lockName || edge.lockNumber || edge.waterwayName || edge.crtId)) {
      locks.push(
        edgeIndex,
        str(edge.lockName),
        str(edge.lockNumber),
        str(edge.waterwayName),
        str(edge.crtId),
      )
    }
    for (const bridge of edge.bridges ?? []) {
      bridges.push(edgeIndex, Math.round(bridge.atM * 10), str(bridge.name))
    }
  })

  const marinas = []
  for (const marina of graph.marinas ?? []) {
    marinas.push(toInt(marina.lon), toInt(marina.lat), str(marina.name))
  }

  const anchor = (value) =>
    value ? [indexOf(value.vertexId), str(value.feature)] : [-1, -1]

  return {
    format: GRAPH_FORMAT,
    version: GRAPH_VERSION,
    osmTimestamp: graph.osmTimestamp ?? null,
    connected: graph.connected,
    componentCount: graph.componentCount,
    strings,
    nodes,
    edges,
    geometry,
    locks,
    bridges,
    marinas,
    anchors: [...anchor(graph.anchors?.start), ...anchor(graph.anchors?.finish)],
  }
}

/**
 * Decode the compact format into plain objects: nodes and edges are identified
 * by their index, and edges carry their coordinates and bridges.
 */
export function decodeGraph(compact) {
  if (compact?.format !== GRAPH_FORMAT || compact.version !== GRAPH_VERSION) {
    throw new Error(`Unsupported graph format ${compact?.format} v${compact?.version}`)
  }
  const text = (index) => (index >= 0 ? compact.strings[index] : undefined)
  const withText = (key, index) => (index >= 0 ? { [key]: compact.strings[index] } : {})

  const nodes = []
  for (let i = 0; i < compact.nodes.length; i += NODE_STRIDE) {
    const [x, y, type, name] = compact.nodes.slice(i, i + NODE_STRIDE)
    nodes.push({
      id: i / NODE_STRIDE,
      lon: fromInt(x),
      lat: fromInt(y),
      type: NODE_TYPES[type],
      ...withText('name', name),
    })
  }

  const edges = []
  let cursor = 0
  for (let i = 0; i < compact.edges.length; i += EDGE_STRIDE) {
    const [a, b, lengthDm, flags, name, points] = compact.edges.slice(i, i + EDGE_STRIDE)
    let [x, y] = [compact.nodes[a * NODE_STRIDE], compact.nodes[a * NODE_STRIDE + 1]]
    const coords = [[fromInt(x), fromInt(y)]]
    for (let p = 0; p < points; p += 1, cursor += 2) {
      x += compact.geometry[cursor]
      y += compact.geometry[cursor + 1]
      coords.push([fromInt(x), fromInt(y)])
    }
    coords.push([nodes[b].lon, nodes[b].lat])
    edges.push({
      id: i / EDGE_STRIDE,
      a,
      b,
      lengthM: lengthDm / 10,
      lock: (flags & FLAG_LOCK) !== 0,
      ...withText('name', name),
      coords,
      bridges: [],
    })
  }

  for (let i = 0; i < compact.locks.length; i += LOCK_STRIDE) {
    const [edge, name, number, waterway, crtId] = compact.locks.slice(i, i + LOCK_STRIDE)
    Object.assign(edges[edge], {
      ...withText('lockName', name),
      ...withText('lockNumber', number),
      ...withText('waterwayName', waterway),
      ...withText('crtId', crtId),
    })
  }
  for (let i = 0; i < compact.bridges.length; i += BRIDGE_STRIDE) {
    const [edge, atDm, name] = compact.bridges.slice(i, i + BRIDGE_STRIDE)
    edges[edge].bridges.push({ atM: atDm / 10, ...withText('name', name) })
  }

  const marinas = []
  for (let i = 0; i < compact.marinas.length; i += MARINA_STRIDE) {
    const [x, y, name] = compact.marinas.slice(i, i + MARINA_STRIDE)
    marinas.push({ id: i / MARINA_STRIDE, name: text(name) ?? '', lon: fromInt(x), lat: fromInt(y) })
  }

  const [startNode, startName, finishNode, finishName] = compact.anchors
  const anchor = (node, name) =>
    node >= 0 ? { vertexId: node, feature: text(name) ?? '' } : null

  return {
    osmTimestamp: compact.osmTimestamp,
    connected: compact.connected,
    componentCount: compact.componentCount,
    nodes,
    edges,
    marinas,
    anchors: { start: anchor(startNode, startName), finish: anchor(finishNode, finishName) },
  }
}

/** Length of an edge's (possibly simplified) geometry in metres. */
export function geometryLengthM(coords) {
  let total = 0
  for (let i = 1; i < coords.length; i += 1) total += haversineM(coords[i - 1], coords[i])
  return total
}

import { haversineM } from './graph-lib.mjs'

/** Minutes to work through one lock, by crew pace. */
export const LOCK_MINUTES = Object.freeze({ slow: 30, medium: 20, fast: 10 })

/** Cruising speed: the Canal & River Trust limit of 4 mph. */
export const DEFAULT_SPEED_KMH = 6.4

/** Clicks further than this from any canal are rejected. */
export const MAX_SNAP_DISTANCE_M = 500

/**
 * A point that snaps this close to an edge's end is treated as being at that
 * end. Shipped coordinates are rounded to ~1 m and lines simplified to 2 m, so a
 * click on a lock gate must still count the lock as passed.
 */
export const END_SNAP_M = 2

export class RouteError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RouteError'
    this.code = code
  }
}

function resolveOptions({ lockSpeed = 'medium', speedKmh = DEFAULT_SPEED_KMH } = {}) {
  const lockMinutes = LOCK_MINUTES[lockSpeed]
  if (lockMinutes === undefined) {
    throw new RouteError('bad-lock-speed', `Unknown lock speed: ${lockSpeed}`)
  }
  if (!(speedKmh > 0)) {
    throw new RouteError('bad-speed', `Speed must be positive: ${speedKmh}`)
  }
  return { lockSpeed, lockMinutes, metresPerMinute: (speedKmh * 1000) / 60 }
}

/**
 * Time to travel `lengthM` along an edge. The lock time is added only when a
 * lock chamber is passed through end to end.
 */
export function travelMinutes(lengthM, passesLock, options) {
  const { lockMinutes, metresPerMinute } = resolveOptions(options)
  return lengthM / metresPerMinute + (passesLock ? lockMinutes : 0)
}

/**
 * Distance along an edge at each of its points, scaled so the last point sits
 * at `edge.lengthM`. Shipped geometry is simplified and slightly shorter than
 * the measured length; scaling keeps snapping and costs in the same units.
 */
function edgeAlongM(edge) {
  const { coords } = edge
  const along = [0]
  for (let i = 1; i < coords.length; i += 1) {
    along.push(along[i - 1] + haversineM(coords[i - 1], coords[i]))
  }
  const total = along.at(-1)
  const scale = total > 0 && edge.lengthM > 0 ? edge.lengthM / total : 1
  return along.map((m) => m * scale)
}

/** Nearest point on segment a-b to p, using a local flat projection. */
function projectOntoSegment(p, a, b) {
  const kx = Math.cos((p[1] * Math.PI) / 180)
  const abX = (b[0] - a[0]) * kx
  const abY = b[1] - a[1]
  const apX = (p[0] - a[0]) * kx
  const apY = p[1] - a[1]
  const lengthSq = abX * abX + abY * abY
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (apX * abX + apY * abY) / lengthSq))
  return { t, coord: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] }
}

/** Snap a [lon, lat] to the nearest point on any graph edge. */
export function snapToNetwork(graph, point, maxDistanceM = MAX_SNAP_DISTANCE_M) {
  let best = null
  for (const edge of graph.edges) {
    const along = edgeAlongM(edge)
    for (let i = 1; i < edge.coords.length; i += 1) {
      const { t, coord } = projectOntoSegment(point, edge.coords[i - 1], edge.coords[i])
      const distanceM = haversineM(point, coord)
      if (!best || distanceM < best.distanceM) {
        best = {
          edge,
          coord,
          distanceM,
          alongM: along[i - 1] + (along[i] - along[i - 1]) * t,
        }
      }
    }
  }
  if (!best || best.distanceM > maxDistanceM) return null
  if (best.alongM <= END_SNAP_M) best.alongM = 0
  else if (best.alongM >= best.edge.lengthM - END_SNAP_M) best.alongM = best.edge.lengthM
  return best
}

/** Coordinates of an edge between two along-distances, in travel order. */
function sliceEdge(edge, fromM, toM) {
  if (fromM > toM) return sliceEdge(edge, toM, fromM).reverse()

  const along = edgeAlongM(edge)
  const pointAt = (m) => {
    for (let i = 1; i < along.length; i += 1) {
      if (m <= along[i] || i === along.length - 1) {
        const span = along[i] - along[i - 1]
        const t = span === 0 ? 0 : Math.max(0, Math.min(1, (m - along[i - 1]) / span))
        const [a, b] = [edge.coords[i - 1], edge.coords[i]]
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      }
    }
    return edge.coords[0]
  }

  const inner = edge.coords.filter((_, i) => along[i] > fromM && along[i] < toM)
  return [pointAt(fromM), ...inner, pointAt(toM)]
}

function lockName(edge) {
  if (edge.lockName) return edge.lockName
  return /lock/i.test(edge.name ?? '') ? edge.name : 'Unnamed lock'
}

const START = 'route:start'
const FINISH = 'route:finish'

/**
 * Fastest route between two [lon, lat] points.
 *
 * Each step costs cruising time (length / speed) plus, for a lock chamber
 * passed end to end, the lock time for the chosen pace. Dijkstra minimises the
 * total, so the lock pace can change which way round the network is fastest.
 */
export function findRoute(graph, from, to, options = {}) {
  const resolved = resolveOptions(options)
  const start = snapToNetwork(graph, from)
  if (!start) throw new RouteError('start-off-network', 'Start is not near a canal')
  const finish = snapToNetwork(graph, to)
  if (!finish) throw new RouteError('finish-off-network', 'Finish is not near a canal')

  // Steps are pieces of edges: { to, edge, fromM, toM }.
  const adjacency = new Map()
  const addStep = (fromId, step) => {
    if (!adjacency.has(fromId)) adjacency.set(fromId, [])
    adjacency.get(fromId).push(step)
  }
  for (const edge of graph.edges) {
    addStep(edge.a, { to: edge.b, edge, fromM: 0, toM: edge.lengthM })
    addStep(edge.b, { to: edge.a, edge, fromM: edge.lengthM, toM: 0 })
  }

  const s = start.alongM
  const f = finish.alongM
  addStep(START, { to: start.edge.a, edge: start.edge, fromM: s, toM: 0 })
  addStep(START, { to: start.edge.b, edge: start.edge, fromM: s, toM: start.edge.lengthM })
  addStep(finish.edge.a, { to: FINISH, edge: finish.edge, fromM: 0, toM: f })
  addStep(finish.edge.b, { to: FINISH, edge: finish.edge, fromM: finish.edge.lengthM, toM: f })
  if (start.edge.id === finish.edge.id) {
    addStep(START, { to: FINISH, edge: start.edge, fromM: s, toM: f })
  }

  const isWholeEdge = (step) =>
    Math.min(step.fromM, step.toM) === 0 &&
    Math.max(step.fromM, step.toM) === step.edge.lengthM
  const stepMinutes = (step) =>
    travelMinutes(
      Math.abs(step.toM - step.fromM),
      step.edge.lock && isWholeEdge(step),
      options,
    )

  // Dijkstra; the graph has ~150 nodes, so a linear scan for the minimum is fine.
  const best = new Map([[START, 0]])
  const via = new Map()
  const done = new Set()
  while (true) {
    let current = null
    for (const [id, minutes] of best) {
      if (!done.has(id) && (current === null || minutes < best.get(current))) current = id
    }
    if (current === null || current === FINISH) break
    done.add(current)
    for (const step of adjacency.get(current) ?? []) {
      const minutes = best.get(current) + stepMinutes(step)
      if (minutes < (best.get(step.to) ?? Infinity)) {
        best.set(step.to, minutes)
        via.set(step.to, { from: current, step })
      }
    }
  }
  if (!best.has(FINISH)) throw new RouteError('no-route', 'No route between these points')

  const steps = []
  for (let id = FINISH; id !== START; id = via.get(id).from) steps.unshift(via.get(id).step)

  const coords = []
  const locks = []
  let distanceM = 0
  for (const step of steps) {
    const piece = sliceEdge(step.edge, step.fromM, step.toM)
    coords.push(...(coords.length ? piece.slice(1) : piece))
    if (step.edge.lock && isWholeEdge(step)) {
      locks.push({
        name: lockName(step.edge),
        number: step.edge.lockNumber ?? null,
        waterway: step.edge.waterwayName ?? null,
        coord: piece[Math.floor(piece.length / 2)],
        atM: distanceM,
      })
    }
    distanceM += Math.abs(step.toM - step.fromM)
  }

  const lockMinutes = locks.length * resolved.lockMinutes
  const cruiseMinutes = distanceM / resolved.metresPerMinute
  return {
    coords,
    distanceM,
    cruiseMinutes,
    lockMinutes,
    totalMinutes: cruiseMinutes + lockMinutes,
    lockSpeed: resolved.lockSpeed,
    locks,
    start: { coord: start.coord, distanceM: start.distanceM, edgeName: start.edge.name },
    finish: { coord: finish.coord, distanceM: finish.distanceM, edgeName: finish.edge.name },
  }
}

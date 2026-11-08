import { haversineM } from './graph-lib.mjs'
import { DEFAULT_SPEED_KMH, LOCK_MINUTES, projectToEdge } from './route-lib.mjs'

/** Faster than any narrowboat; a fix implying more is treated as a GPS glitch. */
export const MAX_BOAT_SPEED_KMH = 15
/** Fixes reporting worse accuracy than this are ignored. */
export const MAX_ACCURACY_M = 100
/** Consecutive fixes needed before the shown position may jump somewhere new. */
export const CONFIRM_FIXES = 3
/** GPS noise allowed to move progress along a route backwards before it counts. */
const BACKWARD_TOLERANCE_M = 30
/**
 * Alpha-beta filter gains. Each fix moves the shown position ALPHA of the way
 * from where the boat was predicted to be towards the fix, and nudges the
 * estimated speed by BETA. Low values smooth out GPS noise; the speed estimate
 * keeps the dot from lagging behind a moving boat.
 */
const ALPHA = 0.3
const BETA = 0.04
const MAX_SPEED_MPS = (MAX_BOAT_SPEED_KMH * 1000) / 3600

/** How much nearer a joined edge a fix must be before the dot moves onto it. */
const SWITCH_MARGIN_M = 8
/** Within this distance of an edge's end, a point counts as at that end. */
const END_TOLERANCE_M = 1

const clampSpeed = (speed) => Math.max(-MAX_SPEED_MPS, Math.min(MAX_SPEED_MPS, speed))

/** How far from the water a fix may be, given its reported accuracy. */
export function acceptDistanceM(accuracyM) {
  return Math.min(150, Math.max(25, accuracyM * 1.5 + 15))
}

function maxMoveM(seconds, accuracyM) {
  return ((MAX_BOAT_SPEED_KMH * 1000) / 3600) * Math.max(seconds, 1) + accuracyM + 20
}

/** A route's line with distance along it, in the route's surveyed metres. */
export function routeLine(route) {
  const along = [0]
  for (let i = 1; i < route.coords.length; i += 1) {
    along.push(along[i - 1] + haversineM(route.coords[i - 1], route.coords[i]))
  }
  const scale = along.at(-1) > 0 ? route.distanceM / along.at(-1) : 1
  return { coords: route.coords, along: along.map((m) => m * scale) }
}

/** Point on a route line at a distance along it. */
export function pointAlongRoute(line, atM) {
  const { coords, along } = line
  if (atM <= 0) return coords[0]
  for (let i = 1; i < coords.length; i += 1) {
    if (atM <= along[i]) {
      const span = along[i] - along[i - 1]
      const t = span > 0 ? (atM - along[i - 1]) / span : 0
      const [a, b] = [coords[i - 1], coords[i]]
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    }
  }
  return coords.at(-1)
}

/**
 * Nearest point on a route line to a fix, optionally only between two
 * distances along it, so a fix can't match a far part of the route.
 */
function projectOntoRoute(line, point, fromM = -Infinity, toM = Infinity) {
  const { coords, along } = line
  const kx = Math.cos((point[1] * Math.PI) / 180)
  let best = null
  for (let i = 1; i < coords.length; i += 1) {
    if (along[i] < fromM || along[i - 1] > toM) continue
    const [a, b] = [coords[i - 1], coords[i]]
    const abX = (b[0] - a[0]) * kx
    const abY = b[1] - a[1]
    const lengthSq = abX * abX + abY * abY
    let t =
      lengthSq === 0
        ? 0
        : (((point[0] - a[0]) * kx) * abX + (point[1] - a[1]) * abY) / lengthSq
    const span = along[i] - along[i - 1]
    if (span > 0) {
      t = Math.max(t, (fromM - along[i - 1]) / span)
      t = Math.min(t, (toM - along[i - 1]) / span)
    }
    t = Math.max(0, Math.min(1, t))
    const coord = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    const distanceM = haversineM(point, coord)
    if (!best || distanceM < best.distanceM) {
      best = { coord, distanceM, alongM: along[i - 1] + span * t }
    }
  }
  return best
}

/** Edges count as joined if one starts within this distance along the canal. */
const JOINED_WITHIN_M = 60

/**
 * For each edge, the edges reachable from its ends within JOINED_WITHIN_M of
 * travel. Junctions often have edges only a few metres long, which a boat can
 * cross between two fixes; counting only edges that touch would treat the next
 * real edge as an unjoined canal.
 */
function buildAdjacency(graph) {
  const touching = new Map()
  for (const edge of graph.edges) {
    for (const node of [edge.a, edge.b]) {
      if (!touching.has(node)) touching.set(node, [])
      touching.get(node).push(edge)
    }
  }
  const nearNode = new Map()
  const edgesNear = (start) => {
    if (nearNode.has(start)) return nearNode.get(start)
    const found = new Set()
    const best = new Map([[start, 0]])
    const queue = [start]
    while (queue.length > 0) {
      const node = queue.shift()
      for (const edge of touching.get(node) ?? []) {
        found.add(edge.id)
        const other = edge.a === node ? edge.b : edge.a
        const travelled = best.get(node) + edge.lengthM
        if (travelled < JOINED_WITHIN_M && travelled < (best.get(other) ?? Infinity)) {
          best.set(other, travelled)
          queue.push(other)
        }
      }
    }
    nearNode.set(start, found)
    return found
  }
  const adjacent = new Map()
  for (const edge of graph.edges) {
    adjacent.set(edge.id, new Set([...edgesNear(edge.a), ...edgesNear(edge.b)]))
  }
  return adjacent
}

/**
 * Turns a stream of raw GPS fixes into the position to show on the map.
 *
 * Each fix is `{ coord: [lon, lat], accuracyM, time }` with time in ms. Fixes
 * are snapped onto the canal; the shown position only moves as far as a boat
 * could plausibly have gone, and only jumps to a new place (a canal not joined
 * to the current one, or a far part of a route) after CONFIRM_FIXES fixes agree.
 *
 * With a route, positions are matched to the route line and progress is
 * reported: distance and time remaining, and the next lock.
 */
export function createTracker(
  graph,
  {
    route = null,
    lockSpeed = 'medium',
    speedKmh = DEFAULT_SPEED_KMH,
    alpha = ALPHA,
    beta = BETA,
  } = {},
) {
  const adjacent = buildAdjacency(graph)
  const edgesById = new Map(graph.edges.map((edge) => [edge.id, edge]))
  const edgesAtNode = new Map()
  for (const edge of graph.edges) {
    for (const node of [edge.a, edge.b]) {
      if (!edgesAtNode.has(node)) edgesAtNode.set(node, [])
      edgesAtNode.get(node).push(edge)
    }
  }
  const line = route ? routeLine(route) : null
  const metresPerMinute = (speedKmh * 1000) / 60
  const lockMinutes = LOCK_MINUTES[lockSpeed] ?? LOCK_MINUTES.medium
  // last: { coord, time } plus, on a route, { progressM, speed } (metres along it
  // and m/s), or off a route { edgeId, xy, velocity } (filtered position and
  // velocity in metres east/north of `origin`).
  let last = null
  let pending = null // { key, count }
  let origin = null
  const toXY = ([lon, lat]) => [
    (lon - origin[0]) * 111_320 * Math.cos((origin[1] * Math.PI) / 180),
    (lat - origin[1]) * 110_540,
  ]
  const toLonLat = ([x, y]) => [
    origin[0] + x / (111_320 * Math.cos((origin[1] * Math.PI) / 180)),
    origin[1] + y / 110_540,
  ]

  const result = (status, fix, extra = {}) => ({
    status,
    raw: { coord: fix.coord, accuracyM: fix.accuracyM },
    coord: last?.coord ?? null,
    edgeId: last?.edgeId ?? null,
    ...(line && last?.progressM !== undefined ? { progress: progressAt(last.progressM) } : {}),
    ...extra,
  })

  function progressAt(progressM) {
    const remainingM = Math.max(0, route.distanceM - progressM)
    const arrived = remainingM <= 25
    // On arrival every lock counts as passed, including one that ends at the finish.
    const locksLeft = arrived
      ? []
      : route.locks.filter((lock) => progressM < lock.atM + lock.lengthM)
    const next = locksLeft[0]
    return {
      alongM: progressM,
      remainingM,
      remainingMinutes: remainingM / metresPerMinute + locksLeft.length * lockMinutes,
      locksPassed: route.locks.length - locksLeft.length,
      locksLeft: locksLeft.length,
      nextLock: next ? { name: next.name, inM: Math.max(0, next.atM - progressM) } : null,
      arrived,
    }
  }

  /** Accept a new position only once CONFIRM_FIXES fixes in a row agree on it. */
  function confirm(key) {
    pending = pending?.key === key ? { key, count: pending.count + 1 } : { key, count: 1 }
    return pending.count >= CONFIRM_FIXES
  }

  function updateOnRoute(fix, seconds) {
    const accept = acceptDistanceM(fix.accuracyM)
    if (last?.progressM !== undefined) {
      const reach = maxMoveM(seconds, fix.accuracyM)
      const near = projectOntoRoute(
        line,
        fix.coord,
        last.progressM - BACKWARD_TOLERANCE_M,
        last.progressM + reach,
      )
      if (near && near.distanceM <= accept) {
        pending = null
        const dt = Math.max(seconds, 1)
        const predicted = last.progressM + last.speed * dt
        const residual = near.alongM - predicted
        const speed = Math.max(0, clampSpeed(last.speed + (beta * residual) / dt))
        // Small backward wobbles are GPS noise: progress never goes backwards.
        const progressM = Math.min(
          route.distanceM,
          Math.max(last.progressM, predicted + alpha * residual),
        )
        last = { coord: pointAlongRoute(line, progressM), time: fix.time, progressM, speed }
        return result('tracking', fix)
      }
    }
    const anywhere = projectOntoRoute(line, fix.coord)
    if (!anywhere || anywhere.distanceM > accept) {
      pending = null
      return result(last ? 'off-route' : 'searching', fix)
    }
    // First fix, or the boat reappears somewhere else on the route (say after
    // the phone slept): needs agreement before the dot jumps there.
    if (!last || confirm(`route:${Math.round(anywhere.alongM / 100)}`)) {
      pending = null
      last = { coord: anywhere.coord, time: fix.time, progressM: anywhere.alongM, speed: 0 }
      return result('tracking', fix)
    }
    return result('held', fix)
  }

  function updateOnNetwork(fix, seconds) {
    const accept = acceptDistanceM(fix.accuracyM)
    const candidates = graph.edges
      .map((edge) => projectToEdge(edge, fix.coord))
      .filter((candidate) => candidate && candidate.distanceM <= accept)
      .sort((a, b) => a.distanceM - b.distanceM)
    if (candidates.length === 0) {
      pending = null
      return result(last ? 'off-canal' : 'searching', fix)
    }
    // Jump straight to a position, resetting the filter.
    const place = (candidate) => {
      origin ??= candidate.coord
      pending = null
      last = {
        coord: candidate.coord,
        time: fix.time,
        edgeId: candidate.edge.id,
        xy: toXY(candidate.coord),
        velocity: [0, 0],
      }
      return result('tracking', fix)
    }
    if (!last) return place(candidates[0])
    // Only the current canal and the edges joined to it, within reach.
    const reach = maxMoveM(seconds, fix.accuracyM)
    const connected = adjacent.get(last.edgeId) ?? new Set()
    // Stay on the current edge unless this fix is clearly nearer a joined one.
    // Near a junction the dot waits at the junction (projection onto the current
    // edge stops at its end) until the boat is clearly on one branch, so a noisy
    // fix near a side branch can't send it the wrong way.
    const reachable = candidates.filter(
      (candidate) =>
        connected.has(candidate.edge.id) && haversineM(candidate.coord, last.coord) <= reach,
    )
    const current = projectToEdge(edgesById.get(last.edgeId), fix.coord)
    const bestJoined = reachable[0]
    const nearby =
      bestJoined &&
      bestJoined.edge.id !== last.edgeId &&
      bestJoined.distanceM + SWITCH_MARGIN_M < current.distanceM
        ? bestJoined
        : current.distanceM <= accept && haversineM(current.coord, last.coord) <= reach
          ? current
          : bestJoined
    if (nearby) {
      pending = null
      // Filter in metres, then put the smoothed point back on the chosen canal.
      const dt = Math.max(seconds, 1)
      const measured = toXY(nearby.coord)
      const predicted = last.xy.map((value, i) => value + last.velocity[i] * dt)
      const residual = measured.map((value, i) => value - predicted[i])
      let velocity = last.velocity.map((value, i) => value + (beta * residual[i]) / dt)
      const speed = Math.hypot(...velocity)
      if (speed > MAX_SPEED_MPS) velocity = velocity.map((value) => (value * MAX_SPEED_MPS) / speed)
      const xy = predicted.map((value, i) => value + alpha * residual[i])
      // Snap the smoothed point onto the chosen edge: the fix decides which canal
      // the boat is on, smoothing only how far along it.
      const smoothed = toLonLat(xy)
      let onCanal = projectToEdge(nearby.edge, smoothed)
      // If the smoothed point has run past the end of that edge (leaving a short
      // lock chamber, say), carry it on to the edge beyond rather than leave the
      // dot parked at the end and catching up later. Where several edges meet,
      // take the one that fits both the smoothed point and this fix.
      const atEnd =
        onCanal.alongM <= END_TOLERANCE_M
          ? nearby.edge.a
          : onCanal.alongM >= nearby.edge.lengthM - END_TOLERANCE_M
            ? nearby.edge.b
            : null
      if (atEnd !== null && onCanal.distanceM > END_TOLERANCE_M) {
        onCanal = (edgesAtNode.get(atEnd) ?? [nearby.edge])
          .map((next) => ({
            onEdge: projectToEdge(next, smoothed),
            fit:
              projectToEdge(next, smoothed).distanceM + projectToEdge(next, fix.coord).distanceM,
          }))
          .reduce((best, option) => (option.fit < best.fit ? option : best)).onEdge
      }
      last = { coord: onCanal.coord, time: fix.time, edgeId: onCanal.edge.id, xy, velocity }
      return result('tracking', fix)
    }
    const [best] = candidates
    if (confirm(`edge:${best.edge.id}`)) return place(best)
    return result('held', fix)
  }

  return {
    update(fix) {
      if (!(fix.accuracyM <= MAX_ACCURACY_M)) return result('low-accuracy', fix)
      const seconds = last ? Math.max(0, (fix.time - last.time) / 1000) : 0
      return line ? updateOnRoute(fix, seconds) : updateOnNetwork(fix, seconds)
    },
    reset() {
      last = null
      pending = null
    },
  }
}

/** Small seeded random number generator (mulberry32), so simulations repeat. */
function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Move a coordinate by metres east and north. */
function offset([lon, lat], eastM, northM) {
  return [
    lon + eastM / (111_320 * Math.cos((lat * Math.PI) / 180)),
    lat + northM / 110_540,
  ]
}

/**
 * GPS fixes for a boat travelling a route: cruising at `speedKmh`, waiting the
 * lock time at each lock, with Gaussian noise of `noiseM` metres. Every
 * `glitchEvery` fixes (if set) one fix lands `glitchM` metres off, as real GPS
 * sometimes does. Fixes are `{ coord, accuracyM, time, trueAlongM }`.
 */
export function simulateRoute(
  route,
  {
    speedKmh = DEFAULT_SPEED_KMH,
    lockSpeed = 'medium',
    intervalS = 5,
    noiseM = 6,
    accuracyM = 10,
    glitchEvery = 0,
    glitchM = 250,
    seed = 1,
    startTime = 0,
  } = {},
) {
  const line = routeLine(route)
  const random = seededRandom(seed)
  const gaussian = () =>
    Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())
  const metresPerSecond = (speedKmh * 1000) / 3600
  const lockSeconds = (LOCK_MINUTES[lockSpeed] ?? LOCK_MINUTES.medium) * 60

  // Where the boat is at each moment: cruising, or waiting in a lock.
  const stops = route.locks.map((lock) => lock.atM)
  const fixes = []
  let alongM = 0
  let waitedS = 0
  let stopIndex = 0
  for (let step = 0; ; step += 1) {
    const time = startTime + step * intervalS * 1000
    const truth = pointAlongRoute(line, alongM)
    const glitch = glitchEvery > 0 && step > 0 && step % glitchEvery === 0
    const angle = random() * 2 * Math.PI
    const [east, north] = glitch
      ? [Math.cos(angle) * glitchM, Math.sin(angle) * glitchM]
      : [gaussian() * noiseM, gaussian() * noiseM]
    fixes.push({ coord: offset(truth, east, north), accuracyM, time, trueAlongM: alongM })
    if (alongM >= route.distanceM) break

    let remainingS = intervalS
    while (remainingS > 0 && alongM < route.distanceM) {
      const nextStop = stops[stopIndex]
      if (nextStop !== undefined && alongM >= nextStop) {
        const wait = Math.min(remainingS, lockSeconds - waitedS)
        waitedS += wait
        remainingS -= wait
        if (waitedS >= lockSeconds) {
          waitedS = 0
          stopIndex += 1
        }
        continue
      }
      const limit = nextStop ?? route.distanceM
      const move = Math.min(remainingS * metresPerSecond, limit - alongM, route.distanceM - alongM)
      alongM += move
      remainingS -= move / metresPerSecond
      if (move === 0) break
    }
  }
  return fixes
}

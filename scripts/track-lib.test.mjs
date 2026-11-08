import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { decodeGraph } from './graph-codec.mjs'
import { haversineM } from './graph-lib.mjs'
import { findRoute } from './route-lib.mjs'
import {
  CONFIRM_FIXES,
  acceptDistanceM,
  createTracker,
  pointAlongRoute,
  routeLine,
  simulateRoute,
} from './track-lib.mjs'

// The app ships the compact graph, so the tracker is tested against it.
const graph = decodeGraph(
  JSON.parse(readFileSync(new URL('../data/graph/graph.compact.json', import.meta.url), 'utf8')),
)
const start = graph.nodes[graph.anchors.start.vertexId]
const finish = graph.nodes[graph.anchors.finish.vertexId]
const wholeRoute = (lockSpeed) =>
  findRoute(graph, [start.lon, start.lat], [finish.lon, finish.lat], { lockSpeed })

// A displayed position moving further than this between 5-second fixes is a jump.
// A boat at 6.4 km/h covers about 9 m in that time.
const MAX_STEP_M = 30

function edge(id, coords) {
  const lengthM = coords.slice(1).reduce((sum, point, i) => sum + haversineM(coords[i], point), 0)
  return { id, a: `${id}:a`, b: `${id}:b`, lengthM, lock: false, coords }
}

// Two canals about 33 m apart that are not joined.
const parallelCanals = {
  edges: [edge('A', [[0, 0], [0.01, 0]]), edge('B', [[0, 0.0003], [0.01, 0.0003]])],
}
const fix = (coord, time, accuracyM = 10) => ({ coord, accuracyM, time })

test('acceptDistanceM grows with reported accuracy, within limits', () => {
  assert.equal(acceptDistanceM(0), 25)
  assert.equal(acceptDistanceM(10), 30)
  assert.equal(acceptDistanceM(500), 150)
})

test('snapping: a fix nearer the other canal stays on the boat’s canal', () => {
  const tracker = createTracker(parallelCanals)
  assert.equal(tracker.update(fix([0.001, 0.00002], 0)).edgeId, 'A')
  // 22 m from A, 11 m from B: still A, the canal the boat is on.
  const wobble = tracker.update(fix([0.0011, 0.0002], 5000))
  assert.equal(wobble.status, 'tracking')
  assert.equal(wobble.edgeId, 'A')
})

test('snapping: moving to an unjoined canal needs several agreeing fixes', () => {
  const tracker = createTracker(parallelCanals)
  tracker.update(fix([0.001, 0], 0))
  const results = []
  for (let i = 1; i <= CONFIRM_FIXES; i += 1) {
    results.push(tracker.update(fix([0.001 + i * 0.0001, 0.0003], i * 5000)))
  }
  assert.deepEqual(
    results.map((result) => result.status),
    [...Array(CONFIRM_FIXES - 1).fill('held'), 'tracking'],
  )
  assert.equal(results.at(-1).edgeId, 'B')
  assert.deepEqual(results[0].coord, [0.001, 0]) // held where it was
})

test('snapping: far from the water reports off-canal and keeps the last position', () => {
  const tracker = createTracker(parallelCanals)
  tracker.update(fix([0.002, 0], 0))
  const away = tracker.update(fix([0.002, 0.003], 5000))
  assert.equal(away.status, 'off-canal')
  assert.deepEqual(away.coord, [0.002, 0])
})

test('snapping: inaccurate fixes are ignored', () => {
  const tracker = createTracker(parallelCanals)
  tracker.update(fix([0.002, 0], 0))
  const vague = tracker.update(fix([0.008, 0], 5000, 400))
  assert.equal(vague.status, 'low-accuracy')
  assert.deepEqual(vague.coord, [0.002, 0])
})

test('snapping: a fix far ahead on the route is held, not jumped to', () => {
  const route = wholeRoute('medium')
  const [first] = simulateRoute(route, { noiseM: 0 })
  const ahead = simulateRoute(route, { noiseM: 0, intervalS: 600 })[20]
  const tracker = createTracker(graph, { route })
  const shown = tracker.update(first).coord
  const result = tracker.update({ ...ahead, time: 5000 })
  assert.equal(result.status, 'held')
  assert.deepEqual(result.coord, shown)
})

for (const [lockSpeed, seed] of [
  ['slow', 7],
  ['medium', 7],
  ['fast', 7],
  ...[1, 2, 3, 4, 5, 6, 8, 9, 10, 11].map((seed) => ['medium', seed]),
]) {
  test(`simulated boat runs the whole route without jumping (${lockSpeed} locks, seed ${seed})`, () => {
    const route = wholeRoute(lockSpeed)
    const fixes = simulateRoute(route, { lockSpeed, noiseM: 6, glitchEvery: 97, seed })
    const tracker = createTracker(graph, { route, lockSpeed })

    let previous = null
    let maxStepM = 0
    let maxErrorM = 0
    const first = tracker.update(fixes[0])
    assert.ok(Math.abs(first.progress.remainingMinutes - route.totalMinutes) < 1)
    for (const gps of fixes) {
      const shown = tracker.update(gps)
      assert.ok(['tracking', 'held', 'off-route'].includes(shown.status), shown.status)
      if (previous) {
        maxStepM = Math.max(maxStepM, haversineM(previous.coord, shown.coord))
        assert.ok(shown.progress.alongM >= previous.progress.alongM, 'progress went backwards')
      }
      maxErrorM = Math.max(maxErrorM, Math.abs(shown.progress.alongM - gps.trueAlongM))
      previous = shown
    }

    assert.ok(maxStepM <= MAX_STEP_M, `largest step ${maxStepM.toFixed(1)} m`)
    assert.ok(maxErrorM <= 30, `largest error ${maxErrorM.toFixed(1)} m`)
    assert.equal(previous.progress.arrived, true)
    assert.equal(previous.progress.locksPassed, route.locks.length)
    assert.equal(previous.progress.nextLock, null)
    const hours = (fixes.at(-1).time - fixes[0].time) / 3_600_000
    assert.ok(Math.abs(hours * 60 - route.totalMinutes) < 1, `took ${hours.toFixed(2)} h`)
  })
}

for (const seed of [2, 6, 11]) test(`simulated boat without a planned route stays on the canal without jumping (seed ${seed})`, () => {
  const route = wholeRoute('fast')
  const fixes = simulateRoute(route, { lockSpeed: 'fast', noiseM: 6, glitchEvery: 97, seed })
  const tracker = createTracker(graph)

  const line = routeLine(route)
  let previous = null
  let maxStepM = 0
  let far = 0
  for (const gps of fixes) {
    const shown = tracker.update(gps)
    assert.ok(['tracking', 'held', 'off-canal'].includes(shown.status), shown.status)
    if (previous) maxStepM = Math.max(maxStepM, haversineM(previous.coord, shown.coord))
    const truth = pointAlongRoute(line, gps.trueAlongM)
    if (haversineM(shown.coord, truth) > 25) far += 1
    previous = shown
  }
  assert.ok(maxStepM <= MAX_STEP_M, `largest step ${maxStepM.toFixed(1)} m`)
  assert.ok(far / fixes.length < 0.01, `${far} of ${fixes.length} fixes more than 25 m out`)
})

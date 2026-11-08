import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { haversineM } from './graph-lib.mjs'
import {
  DEFAULT_SPEED_KMH,
  LOCK_MINUTES,
  RouteError,
  findRoute,
  snapToNetwork,
  travelMinutes,
} from './route-lib.mjs'

function edge(id, coords, lock = false, lockName) {
  const lengthM = coords
    .slice(1)
    .reduce((total, point, i) => total + haversineM(coords[i], point), 0)
  return {
    id,
    a: `${coords[0]}`,
    b: `${coords.at(-1)}`,
    lengthM,
    lock,
    ...(lockName ? { lockName } : {}),
    name: 'Test Canal',
    coords,
  }
}

// Two ways from [0, 0] to [0.01, 0]:
// - direct, about 1.1 km through two locks
// - a detour, about 5.6 km with no locks
function loopGraph() {
  return {
    edges: [
      edge('d1', [[0, 0], [0.004, 0]]),
      edge('lockA', [[0.004, 0], [0.0045, 0]], true, 'Lock A'),
      edge('d2', [[0.0045, 0], [0.0055, 0]]),
      edge('lockB', [[0.0055, 0], [0.006, 0]], true, 'Lock B'),
      edge('d3', [[0.006, 0], [0.01, 0]]),
      edge('detour', [[0, 0], [0, 0.02], [0.01, 0.02], [0.01, 0]]),
    ],
  }
}

test('lock times match the slow, medium and fast paces', () => {
  assert.deepEqual({ ...LOCK_MINUTES }, { slow: 30, medium: 20, fast: 10 })
})

test('travel time is cruising time plus lock time', () => {
  const metres = DEFAULT_SPEED_KMH * 1000
  assert.equal(travelMinutes(metres, false), 60)
  assert.equal(travelMinutes(metres, true, { lockSpeed: 'slow' }), 90)
  assert.equal(travelMinutes(metres, true, { lockSpeed: 'medium' }), 80)
  assert.equal(travelMinutes(metres, true, { lockSpeed: 'fast' }), 70)
  assert.equal(travelMinutes(3200, false, { speedKmh: 3.2 }), 60)
})

test('lock pace changes which route is fastest', () => {
  const graph = loopGraph()
  const slow = findRoute(graph, [0, 0], [0.01, 0], { lockSpeed: 'slow' })
  const fast = findRoute(graph, [0, 0], [0.01, 0], { lockSpeed: 'fast' })

  assert.equal(slow.locks.length, 0)
  assert.ok(slow.distanceM > 5000)
  assert.equal(fast.locks.length, 2)
  assert.deepEqual(fast.locks.map((lock) => lock.name), ['Lock A', 'Lock B'])
  assert.ok(fast.distanceM < 1200)
  assert.equal(fast.lockMinutes, 20)
  assert.ok(Math.abs(fast.totalMinutes - (fast.cruiseMinutes + 20)) < 1e-9)
  assert.ok(fast.totalMinutes < slow.totalMinutes)
})

test('route starts and ends part-way along edges', () => {
  const route = findRoute(loopGraph(), [0.001, 0.0001], [0.003, -0.0001])
  assert.equal(route.locks.length, 0)
  assert.ok(Math.abs(route.distanceM - haversineM([0.001, 0], [0.003, 0])) < 1)
  assert.deepEqual(route.coords[0], [0.001, 0])
  assert.deepEqual(route.coords.at(-1), [0.003, 0])
})

test('a lock is only counted when the route goes all the way through it', () => {
  const route = findRoute(loopGraph(), [0.00425, 0], [0.01, 0], { lockSpeed: 'fast' })
  assert.deepEqual(route.locks.map((lock) => lock.name), ['Lock B'])
})

test('points far from the canal are rejected', () => {
  assert.equal(snapToNetwork(loopGraph(), [0.005, 0.01]), null)
  assert.throws(
    () => findRoute(loopGraph(), [0.005, 0.01], [0.01, 0]),
    (error) => error instanceof RouteError && error.code === 'start-off-network',
  )
  assert.throws(
    () => findRoute(loopGraph(), [0, 0], [0, 0], { lockSpeed: 'warp' }),
    (error) => error instanceof RouteError && error.code === 'bad-lock-speed',
  )
})

test('real graph: Packet Boat Marina to Pickett\'s Lock', () => {
  const graph = JSON.parse(
    readFileSync(new URL('../data/graph/graph.json', import.meta.url), 'utf8'),
  )
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const from = nodes.get(graph.anchors.start.vertexId)
  const to = nodes.get(graph.anchors.finish.vertexId)

  const route = findRoute(graph, [from.lon, from.lat], [to.lon, to.lat])
  const names = route.locks.map((lock) => lock.name)

  assert.ok(route.distanceM > 45_000 && route.distanceM < 60_000)
  assert.equal(route.locks.length, 14)
  assert.ok(names.includes("Acton's Lock"))
  assert.ok(!graph.edges.some((edge) => /denham/i.test(edge.name ?? '')))
})

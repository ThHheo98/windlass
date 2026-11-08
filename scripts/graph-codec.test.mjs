import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { decodeGraph, encodeGraph, simplifyLine } from './graph-codec.mjs'
import { haversineM } from './graph-lib.mjs'
import { findRoute } from './route-lib.mjs'

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))

test('simplifyLine drops points within tolerance and keeps corners and ends', () => {
  // About 111 m per 0.001 degrees at the equator.
  const line = [
    [0, 0],
    [0.0005, 0.000005], // 0.6 m off a straight line: dropped at 2 m
    [0.001, 0],
    [0.001, 0.001], // a right-angle corner: kept
  ]
  assert.deepEqual(simplifyLine(line, 2), [[0, 0], [0.001, 0], [0.001, 0.001]])
  assert.deepEqual(simplifyLine(line, 0.1), line)
  assert.deepEqual(simplifyLine([[0, 0], [1, 1]], 2), [[0, 0], [1, 1]])
})

function smallGraph() {
  return {
    osmTimestamp: '2026-11-08T00:00:00Z',
    connected: true,
    componentCount: 1,
    nodes: [
      { id: 'n1', lon: -0.1, lat: 51.5, type: 'end', name: 'West End' },
      { id: 'n2', lon: -0.099, lat: 51.5, type: 'lock' },
      { id: 'n3', lon: -0.0985, lat: 51.5, type: 'junction', name: 'Junction' },
    ],
    edges: [
      {
        id: 'e1',
        a: 'n1',
        b: 'n2',
        lengthM: 69.4321,
        lock: false,
        name: 'Test Canal',
        way: 1,
        coords: [[-0.1, 51.5], [-0.0995, 51.50001], [-0.099, 51.5]],
        bridges: [{ atM: 12.3456, name: 'Test Bridge' }],
      },
      {
        id: 'e2',
        a: 'n2',
        b: 'n3',
        lengthM: 34.7,
        lock: true,
        name: 'Test Canal',
        lockName: 'Test Lock',
        lockNumber: '7',
        waterwayName: 'Test Canal',
        crtId: 'TC-001-001',
        way: 2,
        coords: [[-0.099, 51.5], [-0.0985, 51.5]],
        bridges: [],
      },
    ],
    marinas: [{ id: 'way/9', name: 'Test Marina', lon: -0.09951, lat: 51.50011 }],
    anchors: {
      start: { feature: 'Start Place', vertexId: 'n1' },
      finish: { feature: 'Finish Place', vertexId: 'n3' },
    },
  }
}

test('encodeGraph and decodeGraph round trip what routing and display need', () => {
  const compact = encodeGraph(smallGraph())
  assert.equal(compact.format, 'windlass-graph')
  assert.ok(compact.nodes.every(Number.isInteger))
  assert.ok(compact.edges.every(Number.isInteger))
  assert.ok(!JSON.stringify(compact).includes('"way"'))

  const graph = decodeGraph(JSON.parse(JSON.stringify(compact)))
  assert.deepEqual(
    graph.nodes.map((node) => [node.id, node.type, node.name]),
    [
      [0, 'end', 'West End'],
      [1, 'lock', undefined],
      [2, 'junction', 'Junction'],
    ],
  )
  const [canal, lock] = graph.edges
  assert.deepEqual([canal.a, canal.b, lock.a, lock.b], [0, 1, 1, 2])
  assert.equal(canal.lengthM, 69.4)
  assert.equal(canal.lock, false)
  assert.equal(canal.name, 'Test Canal')
  assert.deepEqual(canal.bridges, [{ atM: 12.3, name: 'Test Bridge' }])
  // The 1.1 m bend in the middle is within tolerance, so only the ends remain.
  assert.deepEqual(canal.coords, [[-0.1, 51.5], [-0.099, 51.5]])
  assert.equal(lock.lock, true)
  assert.equal(lock.lockName, 'Test Lock')
  assert.equal(lock.lockNumber, '7')
  assert.equal(lock.crtId, 'TC-001-001')
  assert.deepEqual(graph.marinas, [{ id: 0, name: 'Test Marina', lon: -0.09951, lat: 51.50011 }])
  assert.deepEqual(graph.anchors, {
    start: { vertexId: 0, feature: 'Start Place' },
    finish: { vertexId: 2, feature: 'Finish Place' },
  })
})

test('decodeGraph rejects an unknown format', () => {
  assert.throws(() => decodeGraph({ format: 'other', version: 1 }), /Unsupported graph format/)
})

test('real graph: the compact file routes like the full graph', () => {
  const full = readJson('../data/graph/graph.json')
  const compact = readJson('../data/graph/graph.compact.json')
  const graph = decodeGraph(compact)

  // Simplified lines stay close to the surveyed ones.
  graph.edges.forEach((edge, i) => {
    assert.ok(haversineM(edge.coords[0], full.edges[i].coords[0]) < 1)
    assert.ok(haversineM(edge.coords.at(-1), full.edges[i].coords.at(-1)) < 1)
  })

  const fullNodes = new Map(full.nodes.map((node) => [node.id, node]))
  const start = fullNodes.get(full.anchors.start.vertexId)
  const finish = fullNodes.get(full.anchors.finish.vertexId)
  const trips = [
    [[start.lon, start.lat], [finish.lon, finish.lat]],
    // Camden, starting and ending part-way along edges.
    [[-0.1519231, 51.5372872], [-0.1267769, 51.5349063]],
  ]
  for (const [from, to] of trips) {
    for (const lockSpeed of ['slow', 'fast']) {
      const expected = findRoute(full, from, to, { lockSpeed })
      const actual = findRoute(graph, from, to, { lockSpeed })
      assert.deepEqual(
        actual.locks.map((lock) => lock.name),
        expected.locks.map((lock) => lock.name),
      )
      assert.ok(Math.abs(actual.distanceM - expected.distanceM) < 10)
      assert.ok(Math.abs(actual.totalMinutes - expected.totalMinutes) < 0.2)
    }
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGraph, haversineM } from './graph-lib.mjs'

function makeSnapshot() {
  const node = (id, lon, lat, tags = {}) => ({
    type: 'node',
    id,
    lon,
    lat,
    ...(Object.keys(tags).length ? { tags } : {}),
  })
  const way = (id, name, nodes, geometry, tags = {}) => ({
    type: 'way',
    id,
    nodes,
    geometry: geometry.map(([lon, lat]) => ({ lon, lat })),
    tags: { name, waterway: 'canal', ...tags },
  })

  return {
    elements: [
      way(
        10,
        'Grand Union Canal',
        [1, 2, 8, 3],
        [
          [0, 0],
          [0.001, 0],
          [0.002, 0],
          [0.003, 0],
        ],
      ),
      way(
        11,
        'Hertford Union Canal',
        [3, 4],
        [
          [0.003, 0],
          [0.004, 0],
        ],
      ),
      way(
        12,
        'Lee Navigation',
        [3, 5],
        [
          [0.003, 0],
          [0.003, 0.001],
        ],
      ),
      way(
        13,
        'Grand Union Canal',
        [4, 6],
        [
          [0.004, 0],
          [0.0045, 0],
        ],
        { waterway: 'lock', lock: 'yes' },
      ),
      way(
        20,
        'Test Bridge',
        [20, 21],
        [
          [0.0015, -0.001],
          [0.0015, 0.001],
        ],
        { waterway: null, bridge: 'yes' },
      ),
      way(
        22,
        'Not a Bridge',
        [22, 23],
        [
          [0.0025, -0.001],
          [0.0025, 0.001],
        ],
        { waterway: null, bridge: 'no' },
      ),
      way(
        30,
        'Bow Back River',
        [30, 31],
        [
          [0.003, 0],
          [0.004, -0.001],
        ],
        { waterway: 'river' },
      ),
      way(
        32,
        'River Lee Flood Relief Channel',
        [3, 33],
        [
          [0.003, 0],
          [0.004, -0.001],
        ],
        { waterway: 'river' },
      ),
      way(
        34,
        'River Lea',
        [3, 35],
        [
          [0.003, 0],
          [0.004, 0.001],
        ],
        { waterway: 'river' },
      ),
      node(2, 0.001, 0, { waterway: 'lock_gate' }),
      node(8, 0.002, 0, { waterway: 'turning_point', name: 'Winding Hole' }),
      node(9, 0.002, 0.002, { waterway: 'turning_point', name: 'Off-line winding' }),
      node(100, 0.00005, 0, { name: 'Packet Boat Marina' }),
      node(101, 0.004, 0.00005, { name: "Pickett's Lock" }),
    ],
  }
}

test('haversine length is positive and plausible for one longitude degree at the equator', () => {
  assert.ok(Math.abs(haversineM([0, 0], [1, 0]) - 111_195) < 100)
})

test('buildGraph splits route ways at typed vertices and detects bridges', () => {
  const { graph, summary } = buildGraph(makeSnapshot())

  assert.equal(summary.rawWaterwayWays, 7)
  assert.equal(summary.includedWaterwayWays, 4)
  assert.equal(summary.excludedWaterwayWays, 3)
  assert.equal(summary.offLineWindingCount, 1)
  assert.equal(summary.bridgeCount, 1)
  assert.equal(graph.offLineWindings[0].name, 'Off-line winding')
  assert.equal(summary.connected, true)
  assert.equal(graph.anchors.start.feature, 'Packet Boat Marina')
  assert.equal(graph.anchors.finish.feature, "Pickett's Lock")
  assert.ok(graph.nodes.some((node) => node.id === 2 && node.type === 'lock'))
  assert.ok(graph.nodes.some((node) => node.id === 8 && node.type === 'winding'))
  assert.ok(graph.nodes.some((node) => node.id === 3 && node.type === 'junction'))
  assert.ok(graph.edges.some((edge) => edge.lock))

  const crossedEdge = graph.edges.find((edge) => edge.bridges.length > 0)
  assert.ok(crossedEdge)
  assert.equal(crossedEdge.bridges[0].name, 'Test Bridge')
  assert.ok(crossedEdge.bridges[0].atM > 40)
})

test('buildGraph reports disconnected endpoint networks', () => {
  const raw = makeSnapshot()
  raw.elements = raw.elements.filter((element) => element.id !== 101)
  raw.elements.push(
    {
      type: 'node',
      id: 101,
      lon: 0.02,
      lat: 0,
      tags: { name: "Pickett's Lock" },
    },
    {
      type: 'way',
      id: 14,
      nodes: [40, 41],
      geometry: [
        { lon: 0.02, lat: 0 },
        { lon: 0.021, lat: 0 },
      ],
      tags: { name: 'Lee Navigation', waterway: 'canal' },
    },
  )

  const { graph, summary } = buildGraph(raw)
  assert.equal(summary.connected, false)
  assert.equal(graph.connected, false)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGraph, haversineM, parseCrtLockName } from './graph-lib.mjs'

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
      way(
        35,
        'Grand Union Canal (Paddington Branch)',
        [3, 36],
        [
          [0.003, 0],
          [0.0035, 0.0005],
        ],
      ),
      way(
        37,
        'Grand Union Canal',
        [3, 38],
        [
          [0.003, 0],
          [0.004, -0.0001],
        ],
      ),
      way(
        39,
        'Downstream Grand Union lock',
        [38, 40],
        [
          [0.004, -0.0001],
          [0.0045, -0.0002],
        ],
        { lock: 'yes' },
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

  assert.equal(summary.rawWaterwayWays, 10)
  assert.equal(summary.includedWaterwayWays, 5)
  assert.equal(summary.excludedWaterwayWays, 5)
  assert.equal(summary.offLineWindingCount, 1)
  assert.equal(summary.bridgeCount, 1)
  assert.equal(summary.componentCount, 1)
  assert.equal(graph.offLineWindings[0].name, 'Off-line winding')
  assert.equal(summary.connected, true)
  assert.equal(graph.anchors.start.feature, 'Packet Boat Marina')
  assert.equal(graph.anchors.finish.feature, "Pickett's Lock")
  assert.ok(graph.nodes.some((node) => node.id === 2 && node.type === 'lock'))
  assert.ok(graph.nodes.some((node) => node.id === 8 && node.type === 'winding'))
  assert.ok(graph.nodes.some((node) => node.id === 3 && node.type === 'junction'))
  assert.ok(!graph.nodes.some((node) => node.id === 38))
  assert.ok(!graph.edges.some((edge) => edge.way === 37))
  assert.ok(!graph.edges.some((edge) => edge.way === 39))
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
      nodes: [50, 51],
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
  assert.equal(summary.componentCount, 2)
})

test('buildGraph keeps Uxbridge Lock and trims the main line beyond it', () => {
  const raw = makeSnapshot()
  const way = (id, name, nodes, coords, tags = {}) => ({
    type: 'way',
    id,
    nodes,
    geometry: coords.map(([lon, lat]) => ({ lon, lat })),
    tags: { name, waterway: 'canal', ...tags },
  })
  raw.elements.push(
    way(60, '88 Uxbridge Lock', [1, 61], [[0, 0], [-0.0005, 0]], { lock: 'yes' }),
    way(62, 'Grand Union Canal', [61, 63], [[-0.0005, 0], [-0.002, 0]]),
    way(64, '87 Denham Deep Lock', [63, 65], [[-0.002, 0], [-0.0025, 0]], { lock: 'yes' }),
    way(66, 'Grand Union Canal', [65, 67], [[-0.0025, 0], [-0.004, 0]]),
  )

  const { graph, summary } = buildGraph(raw)
  assert.ok(graph.edges.some((edge) => edge.way === 60))
  assert.ok(!graph.edges.some((edge) => [62, 64, 66].includes(edge.way)))
  assert.equal(graph.nodes.find((node) => node.id === 61)?.type, 'lock')
  assert.equal(summary.connected, true)
})

test('parseCrtLockName splits the number and drops the chamber side', () => {
  assert.deepEqual(parseCrtLockName('Lock 17, Tottenham Lock, Eastern Side'), {
    number: '17',
    name: 'Tottenham Lock',
  })
  assert.deepEqual(parseCrtLockName('Lock 1B, Hampstead Road Lock'), {
    number: '1B',
    name: 'Hampstead Road Lock',
  })
  assert.deepEqual(parseCrtLockName('West India Dock Entrance Lock'), {
    number: null,
    name: 'West India Dock Entrance Lock',
  })
})

function crtLock(id, description, coordinates, type = '010') {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates },
    properties: {
      sap_func_loc: id,
      sap_description: description,
      sap_object_type: type,
      waterway_name: 'Grand Union Canal',
    },
  }
}

test('buildGraph names locks from CRT data and reports mismatches', () => {
  const raw = makeSnapshot()
  const lockWay = raw.elements.find((element) => element.id === 13)
  lockWay.tags.lock_name = "Smith's Lock"
  const crtLocks = {
    type: 'FeatureCollection',
    features: [
      crtLock('GU-001-001', 'Lock 7, Smiths Lock', [0.00425, 0.00005]),
      crtLock('GU-001-002', 'Lock 7 Bypass Weir, Smiths Lock', [0.00425, 0], '018'),
      crtLock('GU-001-003', 'Lock 8, Mystery Lock', [0.0015, 0]),
      crtLock('GU-009-001', 'Lock 99, Far Away Lock', [0.5, 0.5]),
    ],
  }

  const { graph, summary } = buildGraph(raw, { crtLocks })
  const lockEdge = graph.edges.find((edge) => edge.way === 13)
  assert.equal(lockEdge.lockName, "Smith's Lock")
  assert.equal(lockEdge.lockNumber, '7')
  assert.equal(lockEdge.crtId, 'GU-001-001')
  assert.equal(lockEdge.waterwayName, 'Grand Union Canal')
  assert.equal(summary.crt.matched, 1)
  assert.deepEqual(summary.crt.unmatchedGraphLocks, [])
  assert.deepEqual(
    summary.crt.missingCrtLocks.map((lock) => lock.crtId),
    ['GU-001-003'],
  )
})

test('buildGraph excludes tidal locks by lock_name and drops the cut-off stub', () => {
  const raw = makeSnapshot()
  raw.elements.push(
    {
      type: 'way',
      id: 70,
      nodes: [5, 71],
      geometry: [
        { lon: 0.003, lat: 0.001 },
        { lon: 0.003, lat: 0.0015 },
      ],
      tags: { name: "Regent's Canal", waterway: 'canal', lock: 'yes', lock_name: 'Limehouse Basin Lock' },
    },
    {
      type: 'way',
      id: 72,
      nodes: [71, 73],
      geometry: [
        { lon: 0.003, lat: 0.0015 },
        { lon: 0.003, lat: 0.003 },
      ],
      tags: { name: "Regent's Canal", waterway: 'canal' },
    },
  )

  const { graph, summary } = buildGraph(raw)
  assert.ok(!graph.edges.some((edge) => edge.way === 70 || edge.way === 72))
  assert.deepEqual(summary.droppedEdges.map((edge) => edge.id), ['72:0-1'])
  assert.equal(summary.componentCount, 1)
})

test('buildGraph lists named marinas beside the route', () => {
  const raw = makeSnapshot()
  raw.elements.push(
    { type: 'node', id: 80, lon: 0.002, lat: 0.0005, tags: { leisure: 'marina', name: 'Canalside Marina' } },
    { type: 'node', id: 81, lon: 0.002, lat: 0.05, tags: { leisure: 'marina', name: 'Far Marina' } },
    { type: 'node', id: 82, lon: 0.001, lat: 0.0003, tags: { leisure: 'marina' } },
  )

  const { graph } = buildGraph(raw)
  assert.deepEqual(graph.marinas.map((marina) => marina.name), ['Canalside Marina'])
})

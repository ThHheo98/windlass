const ROUTE_WATERWAY_NAME =
  /^(?:grand union canal(?: - slough arm| \(paddington (?:branch|arm)\))?|regent.?s canal|islington tunnel \(regent.?s canal\)|hertford union canal|limehouse cut|(?:river )?lee navigation(?: \(hackney cut\))?|river lee)$/i
const ANCHOR_NAME = /packet boat marina|pickett.?s lock|alfie.?s lock/i
const EXCLUDED_LOCK_NAME = /thames|limehouse basin lock|bow creek|prescott/i
const EARTH_RADIUS_M = 6_371_008.8

export function haversineM([lon1, lat1], [lon2, lat2]) {
  const radians = Math.PI / 180
  const deltaLat = (lat2 - lat1) * radians
  const deltaLon = (lon2 - lon1) * radians
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1 * radians) *
      Math.cos(lat2 * radians) *
      Math.sin(deltaLon / 2) ** 2

  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function geometryCoordinates(element) {
  if (element.type === 'node' && Number.isFinite(element.lon) && Number.isFinite(element.lat)) {
    return [[element.lon, element.lat]]
  }

  return (element.geometry ?? [])
    .filter((point) => Number.isFinite(point.lon) && Number.isFinite(point.lat))
    .map((point) => [point.lon, point.lat])
}

function isRouteWaterway(way) {
  const waterway = way.tags?.waterway
  const name = way.tags?.name ?? ''
  return (
    ['canal', 'river'].includes(waterway) &&
    ROUTE_WATERWAY_NAME.test(name) &&
    (!/^river lee$/i.test(name) || waterway === 'canal')
  )
}

function lineIntersectionParameter(a, b, c, d) {
  const abX = b[0] - a[0]
  const abY = b[1] - a[1]
  const cdX = d[0] - c[0]
  const cdY = d[1] - c[1]
  const denominator = abX * cdY - abY * cdX

  if (Math.abs(denominator) < 1e-12) return null

  const acX = c[0] - a[0]
  const acY = c[1] - a[1]
  const t = (acX * cdY - acY * cdX) / denominator
  const u = (acX * abY - acY * abX) / denominator
  const epsilon = 1e-8

  return t > epsilon && t < 1 - epsilon && u > epsilon && u < 1 - epsilon
    ? t
    : null
}

function getBridges(edge, bridgeWays) {
  const bridges = []
  let alongM = 0

  for (let i = 1; i < edge.coords.length; i += 1) {
    const waterA = edge.coords[i - 1]
    const waterB = edge.coords[i]
    const segmentLengthM = haversineM(waterA, waterB)

    for (const bridge of bridgeWays) {
      for (let j = 1; j < bridge.coords.length; j += 1) {
        const t = lineIntersectionParameter(
          waterA,
          waterB,
          bridge.coords[j - 1],
          bridge.coords[j],
        )
        if (t === null) continue

        const atM = alongM + segmentLengthM * t
        const existing = bridges.find((item) => Math.abs(item.atM - atM) < 3)
        if (!existing) {
          bridges.push({ atM, name: bridge.name })
        } else if (!existing.name && bridge.name) {
          existing.name = bridge.name
        }
      }
    }
    alongM += segmentLengthM
  }

  return bridges.sort((a, b) => a.atM - b.atM)
}

function collectAnchors(elements) {
  return elements
    .filter((element) => ANCHOR_NAME.test(element.tags?.name ?? ''))
    .flatMap((element) =>
      geometryCoordinates(element).map((coords) => ({
        name: element.tags.name,
        coords,
      })),
    )
}

function findAnchor(pattern, candidates, nodes) {
  const matches = candidates.filter((candidate) => pattern.test(candidate.name))
  let closest = null

  for (const candidate of matches) {
    for (const node of nodes) {
      const distanceM = haversineM(candidate.coords, [node.lon, node.lat])
      if (!closest || distanceM < closest.distanceM) {
        closest = {
          feature: candidate.name,
          vertexId: node.id,
          distanceM,
        }
      }
    }
  }

  return closest && closest.distanceM <= 1_500 ? closest : null
}

function reachableFrom(edges, startId) {
  const adjacency = new Map()
  for (const edge of edges) {
    if (!adjacency.has(edge.a)) adjacency.set(edge.a, [])
    if (!adjacency.has(edge.b)) adjacency.set(edge.b, [])
    adjacency.get(edge.a).push(edge.b)
    adjacency.get(edge.b).push(edge.a)
  }

  const seen = new Set([startId])
  const queue = [startId]
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i]
    for (const next of adjacency.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return seen
}

export function buildGraph(raw) {
  if (!Array.isArray(raw.elements)) {
    throw new Error('OSM snapshot must contain an elements array')
  }

  const elements = raw.elements
  const allWaterways = elements.filter(
    (element) => element.type === 'way' && element.tags?.waterway,
  )
  const routeWays = allWaterways.filter(isRouteWaterway)
  const routeNodeIds = new Set(
    routeWays.flatMap((way) => (way.nodes ?? []).map(String)),
  )
  const lockWays = allWaterways.filter(
    (way) =>
      (way.tags?.lock === 'yes' || way.tags?.waterway === 'lock') &&
      !EXCLUDED_LOCK_NAME.test(way.tags?.name ?? '') &&
      (way.nodes ?? []).some((id) => routeNodeIds.has(String(id))),
  )
  const lockGateWays = allWaterways.filter(
    (way) =>
      way.tags?.waterway === 'lock_gate' &&
      (way.nodes ?? []).some((id) => routeNodeIds.has(String(id))),
  )
  const lockGateNodeIds = new Set(
    lockGateWays.flatMap((way) => (way.nodes ?? []).map(String)),
  )
  const ways = [
    ...new Map([...routeWays, ...lockWays].map((way) => [way.id, way])).values(),
  ]
  const taggedNodes = new Map(
    elements
      .filter((element) => element.type === 'node' && element.tags)
      .map((node) => [String(node.id), node]),
  )
  const wayOccurrences = new Map()
  const wayPoints = new Map()
  const vertexMeta = new Map()
  const edges = []

  for (const way of ways) {
    const coords = geometryCoordinates(way)
    if (coords.length < 2) continue

    const refs = way.nodes ?? []
    const points = coords.map((position, index) => ({
      id: refs[index] ?? `way:${way.id}:point:${index}`,
      position,
      index,
    }))
    wayPoints.set(way.id, points)
    for (const point of points) {
      const key = String(point.id)
      if (!wayOccurrences.has(key)) wayOccurrences.set(key, new Set())
      wayOccurrences.get(key).add(way.id)
    }
  }

  for (const way of ways) {
    const points = wayPoints.get(way.id)
    if (!points) continue

    const isLockChamber = way.tags?.lock === 'yes' || way.tags?.waterway === 'lock'
    const splitIndices = []
    for (const point of points) {
      const node = taggedNodes.get(String(point.id))
      const tags = node?.tags ?? {}
      const isEndpoint =
        point.index === 0 || point.index === points.length - 1
      const isLockGate =
        tags.waterway === 'lock_gate' ||
        tags.lock === 'yes' ||
        lockGateNodeIds.has(String(point.id))
      const isWinding = tags.waterway === 'turning_point'
      const isShared = (wayOccurrences.get(String(point.id))?.size ?? 0) > 1

      if (
        isEndpoint ||
        isShared ||
        isLockGate ||
        isWinding ||
        (isLockChamber && isEndpoint)
      ) {
        splitIndices.push(point.index)
        const key = String(point.id)
        const meta = vertexMeta.get(key) ?? {
          id: point.id,
          lon: point.position[0],
          lat: point.position[1],
          name: tags.name ?? way.tags?.name,
          lock: false,
          winding: false,
          shared: false,
        }
        meta.lock ||= isLockGate || (isLockChamber && isEndpoint)
        meta.winding ||= isWinding
        meta.shared ||= isShared
        meta.name ||= tags.name ?? way.tags?.name
        vertexMeta.set(key, meta)
      }
    }

    for (let index = 1; index < splitIndices.length; index += 1) {
      const startIndex = splitIndices[index - 1]
      const finishIndex = splitIndices[index]
      if (startIndex === finishIndex) continue

      const segment = points.slice(startIndex, finishIndex + 1)
      const edgeCoords = segment.map((point) => point.position)
      const edge = {
        id: `${way.id}:${startIndex}-${finishIndex}`,
        a: segment[0].id,
        b: segment.at(-1).id,
        lengthM: edgeCoords.slice(1).reduce(
          (total, position, i) =>
            total + haversineM(edgeCoords[i], position),
          0,
        ),
        lock: isLockChamber,
        name: way.tags?.name,
        way: way.id,
        coords: edgeCoords,
        bridges: [],
      }
      edges.push(edge)
    }
  }

  const degree = new Map()
  for (const edge of edges) {
    degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1)
    degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1)
  }

  const nodes = [...vertexMeta.values()].map((node) => {
    const count = degree.get(node.id) ?? 0
    let type = 'join'
    if (node.lock) type = 'lock'
    else if (node.winding) type = 'winding'
    else if (count >= 3) type = 'junction'
    else if (count <= 1) type = 'end'

    return {
      id: node.id,
      lon: node.lon,
      lat: node.lat,
      type,
      ...(node.name ? { name: node.name } : {}),
    }
  })

  const bridgeWays = elements
    .filter(
      (element) =>
        element.type === 'way' &&
        (Boolean(element.tags?.bridge && element.tags.bridge !== 'no') ||
          element.tags?.man_made === 'bridge'),
    )
    .map((way) => ({
      name: way.tags?.name,
      coords: geometryCoordinates(way),
    }))
    .filter((way) => way.coords.length >= 2)

  for (const edge of edges) {
    edge.bridges = getBridges(edge, bridgeWays)
  }

  const anchors = collectAnchors(elements)
  const start = findAnchor(/packet boat marina/i, anchors, nodes)
  const finish = findAnchor(/pickett.?s lock|alfie.?s lock/i, anchors, nodes)
  const routeNodeIdsForGraph = new Set(
    ways.flatMap((way) => (way.nodes ?? []).map(String)),
  )
  const offLineWindings = elements
    .filter(
      (element) =>
        element.type === 'node' &&
        element.tags?.waterway === 'turning_point' &&
        !routeNodeIdsForGraph.has(String(element.id)),
    )
    .map((node) => ({
      id: node.id,
      lon: node.lon,
      lat: node.lat,
      ...(node.tags?.name ? { name: node.tags.name } : {}),
    }))
  const startComponent = start
    ? reachableFrom(edges, start.vertexId)
    : new Set()
  const connected =
    start !== null &&
    finish !== null &&
    startComponent.has(finish.vertexId)
  let gap = null
  if (start && finish && !connected) {
    const finishComponent = reachableFrom(edges, finish.vertexId)
    let closestDistanceM = Infinity
    for (const fromId of startComponent) {
      const fromNode = nodes.find((node) => node.id === fromId)
      if (!fromNode) continue
      for (const toId of finishComponent) {
        const toNode = nodes.find((node) => node.id === toId)
        if (!toNode) continue
        const distanceM = haversineM(
          [fromNode.lon, fromNode.lat],
          [toNode.lon, toNode.lat],
        )
        if (distanceM < closestDistanceM) {
          closestDistanceM = distanceM
          gap = { from: fromNode, to: toNode, distanceM }
        }
      }
    }
  }

  return {
    graph: {
      nodes,
      edges,
      anchors: { start, finish },
      connected,
      gap,
      offLineWindings,
    },
    summary: {
      rawWaterwayWays: allWaterways.length,
      includedWaterwayWays: ways.length,
      excludedWaterwayWays: allWaterways.length - ways.length,
      nodesByType: Object.fromEntries(
        ['lock', 'junction', 'winding', 'end', 'join'].map((type) => [
          type,
          nodes.filter((node) => node.type === type).length,
        ]),
      ),
      edgeCount: edges.length,
      bridgeCount: edges.reduce((count, edge) => count + edge.bridges.length, 0),
      offLineWindingCount: offLineWindings.length,
      start,
      finish,
      connected,
      gap,
    },
  }
}

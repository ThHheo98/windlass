import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LngLatBounds,
  Map,
  Marker,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type GeoJSONSource,
} from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import graphJson from '../data/graph/graph.compact.json?raw'
import { decodeGraph, type DecodedGraph } from '../scripts/graph-codec.mjs'
import regionBoundary from '../data/region/london-mvp.geojson?raw'
import {
  DEFAULT_SPEED_KMH,
  LOCK_MINUTES,
  MAX_SNAP_DISTANCE_M,
  RouteError,
  findRoute,
  snapToNetwork,
  type LockSpeed,
  type LonLat,
  type Route,
} from '../scripts/route-lib.mjs'
import { addMapIcons, iconSize, iconUrl, type IconName } from './mapIcons'
import './App.css'

type PickTarget = 'start' | 'finish'

const LOCK_SPEEDS: { value: LockSpeed; label: string }[] = [
  { value: 'slow', label: 'Slow' },
  { value: 'medium', label: 'Medium' },
  { value: 'fast', label: 'Fast' },
]

const OFF_NETWORK_MESSAGE = `That point is more than ${MAX_SNAP_DISTANCE_M} m from a canal on the route. Click closer to a waterway.`

function formatDuration(minutes: number) {
  const rounded = Math.round(minutes)
  const hours = Math.floor(rounded / 60)
  const mins = rounded % 60
  if (hours === 0) return `${mins} min`
  return mins === 0 ? `${hours} h` : `${hours} h ${mins} min`
}

function routeErrorMessage(error: unknown) {
  if (error instanceof RouteError) {
    if (error.code === 'start-off-network' || error.code === 'finish-off-network') {
      return OFF_NETWORK_MESSAGE
    }
    if (error.code === 'no-route') return 'No route connects these two points.'
  }
  return error instanceof Error ? error.message : String(error)
}

function routeFeatures(route: Route | null) {
  return {
    line: {
      type: 'FeatureCollection' as const,
      features: route
        ? [
            {
              type: 'Feature' as const,
              properties: {},
              geometry: { type: 'LineString' as const, coordinates: route.coords },
            },
          ]
        : [],
    },
    locks: {
      type: 'FeatureCollection' as const,
      features: (route?.locks ?? []).map((lock, index) => ({
        type: 'Feature' as const,
        properties: { name: lock.name, order: index + 1 },
        geometry: { type: 'Point' as const, coordinates: lock.coord },
      })),
    },
  }
}

type GraphData = DecodedGraph
type GraphEdge = GraphData['edges'][number]

type FeatureProperties = Record<string, string | number | boolean | null>

setWorkerUrl(workerUrl)

const graph: GraphData = decodeGraph(JSON.parse(graphJson))
const boundary = JSON.parse(regionBoundary)
const earthRadiusM = 6_371_008.8
const routeBounds: [[number, number], [number, number]] = graph.edges.reduce(
  (bounds, edge) => {
    for (const [longitude, latitude] of edge.coords) {
      bounds[0][0] = Math.min(bounds[0][0], longitude)
      bounds[0][1] = Math.min(bounds[0][1], latitude)
      bounds[1][0] = Math.max(bounds[1][0], longitude)
      bounds[1][1] = Math.max(bounds[1][1], latitude)
    }
    return bounds
  },
  [
    [Infinity, Infinity],
    [-Infinity, -Infinity],
  ],
)

function distanceM(a: [number, number], b: [number, number]) {
  const radians = Math.PI / 180
  const deltaLat = (b[1] - a[1]) * radians
  const deltaLon = (b[0] - a[0]) * radians
  const value =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(a[1] * radians) *
      Math.cos(b[1] * radians) *
      Math.sin(deltaLon / 2) ** 2

  return 2 * earthRadiusM * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
}

// `atM` is measured on the surveyed edge length; the shipped line is simplified
// and a little shorter, so scale the distance onto it.
function pointAlongEdge(edge: GraphEdge, atM: number): [number, number] {
  let lineM = 0
  for (let index = 1; index < edge.coords.length; index += 1) {
    lineM += distanceM(edge.coords[index - 1], edge.coords[index])
  }
  if (edge.lengthM > 0) atM *= lineM / edge.lengthM
  let distanceSoFar = 0

  for (let index = 1; index < edge.coords.length; index += 1) {
    const start = edge.coords[index - 1]
    const end = edge.coords[index]
    const segmentLength = distanceM(start, end)

    if (distanceSoFar + segmentLength >= atM) {
      const fraction = (atM - distanceSoFar) / segmentLength
      return [
        start[0] + (end[0] - start[0]) * fraction,
        start[1] + (end[1] - start[1]) * fraction,
      ]
    }
    distanceSoFar += segmentLength
  }

  return edge.coords.at(-1) ?? [0, 0]
}

const edgeFeatures = graph.edges
  .filter((edge) => edge.coords.length > 1)
  .map((edge) => ({
    type: 'Feature' as const,
    properties: {
      id: edge.id,
      name: edge.lockName ?? edge.name ?? 'Unnamed waterway',
      lock: edge.lock,
      lengthM: edge.lengthM,
    },
    geometry: {
      type: 'LineString' as const,
      coordinates: edge.coords,
    },
  }))

function featureCollection<T>(features: T[]) {
  return { type: 'FeatureCollection' as const, features }
}

/** Compass bearing of an edge from its first to its last point, in degrees. */
function edgeBearing(edge: GraphEdge) {
  const [from, to] = [edge.coords[0], edge.coords.at(-1) ?? edge.coords[0]]
  const dx = (to[0] - from[0]) * Math.cos((from[1] * Math.PI) / 180)
  const dy = to[1] - from[1]
  return (Math.atan2(dx, dy) * 180) / Math.PI
}

// One symbol per lock chamber, turned to lie along the canal. The icon is
// drawn east-west (bearing 90), hence the offset.
const lockFeatures = graph.edges
  .filter((edge) => edge.lock)
  .map((edge) => {
    const name = edge.lockName ?? edge.name ?? 'Unnamed lock'
    return {
      type: 'Feature' as const,
      properties: {
        name,
        number: edge.lockNumber ?? '',
        label: edge.lockNumber ? `${edge.lockNumber} · ${name}` : name,
        waterway: edge.waterwayName ?? '',
        crtId: edge.crtId ?? '',
        rotate: edgeBearing(edge) - 90,
      },
      geometry: {
        type: 'Point' as const,
        coordinates: pointAlongEdge(edge, edge.lengthM / 2),
      },
    }
  })

const marinaFeatures = (graph.marinas ?? []).map((marina) => ({
  type: 'Feature' as const,
  properties: { id: marina.id, name: marina.name },
  geometry: { type: 'Point' as const, coordinates: [marina.lon, marina.lat] },
}))

const CLICKABLE_LAYERS = [
  'graph-locks',
  'marinas',
  'graph-nodes',
  'graph-ends',
  'graph-bridges',
  'graph-edges',
] as const

function describeFeature(
  layer: (typeof CLICKABLE_LAYERS)[number],
  properties: FeatureProperties,
) {
  const text = (key: string) => String(properties[key] ?? '')
  switch (layer) {
    case 'graph-locks':
      return {
        title: text('number') ? `Lock ${text('number')}: ${text('name')}` : text('name'),
        details: [
          text('waterway'),
          text('crtId') ? `CRT asset ${text('crtId')}` : 'Not matched to CRT data',
        ]
          .filter(Boolean)
          .join(' · '),
      }
    case 'marinas':
      return { title: text('name'), details: 'Marina' }
    case 'graph-nodes':
      return {
        title: `${text('type') === 'winding' ? 'Winding hole' : 'Junction'}: ${text('name') || text('id')}`,
        details: `Graph node ${text('id')}`,
      }
    case 'graph-ends':
      return {
        title: `End of navigation: ${text('name') || text('id')}`,
        details: `Graph node ${text('id')}`,
      }
    case 'graph-bridges':
      return {
        title: `Bridge: ${text('name')}`,
        details: `Crosses ${text('edge')}${properties.atM ? ` · ${Math.round(Number(properties.atM))} m along` : ''}`,
      }
    case 'graph-edges':
      return {
        title: text('name'),
        details: `${(Number(properties.lengthM) / 1000).toFixed(2)} km${properties.lock ? ' · lock chamber' : ''}`,
      }
  }
}

function LegendIcon({ name }: { name: IconName }) {
  const { width, height } = iconSize(name)
  return <img alt="" className="legend-icon" height={height} src={iconUrl(name)} width={width} />
}

const nodeFeatures = graph.nodes.map((node) => ({
  type: 'Feature' as const,
  properties: {
    id: String(node.id),
    type: node.type,
    name: node.name ?? '',
  },
  geometry: {
    type: 'Point' as const,
    coordinates: [node.lon, node.lat],
  },
}))

const bridgeFeatures = graph.edges.flatMap((edge) =>
  edge.bridges.map((bridge, index) => ({
    type: 'Feature' as const,
    properties: {
      id: `${edge.id}:bridge:${index}`,
      name: bridge.name ?? 'Unnamed bridge',
      edge: edge.name ?? 'Unnamed waterway',
      atM: bridge.atM,
    },
    geometry: {
      type: 'Point' as const,
      coordinates: pointAlongEdge(edge, bridge.atM),
    },
  })),
)

const anchorFeatures = (
  [
    [graph.anchors.start, 'Start'],
    [graph.anchors.finish, 'Finish'],
  ] as const
).flatMap(([anchor, role]) => {
  // Node ids are their index in graph.nodes.
  const node = anchor ? graph.nodes[anchor.vertexId] : undefined
  return anchor && node
    ? [
        {
          type: 'Feature' as const,
          properties: { name: anchor.feature, role },
          geometry: { type: 'Point' as const, coordinates: [node.lon, node.lat] },
        },
      ]
    : []
})

const graphCounts = {
  nodes: graph.nodes.length,
  edges: graph.edges.length,
  bridges: bridgeFeatures.length,
}

function App() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const [showNodes, setShowNodes] = useState(true)
  const [showBridges, setShowBridges] = useState(false)
  const [showBoundary, setShowBoundary] = useState(true)
  const [showMarinas, setShowMarinas] = useState(true)
  const [mapReady, setMapReady] = useState(false)
  const [lockSpeed, setLockSpeed] = useState<LockSpeed>('medium')
  const [start, setStart] = useState<LonLat | null>(null)
  const [finish, setFinish] = useState<LonLat | null>(null)
  const [picking, setPicking] = useState<PickTarget | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const pickingRef = useRef<PickTarget | null>(null)
  const markersRef = useRef<{ start: Marker | null; finish: Marker | null }>({
    start: null,
    finish: null,
  })
  const fittedRouteKey = useRef<string | null>(null)

  const beginPicking = (target: PickTarget | null) => {
    pickingRef.current = target
    setPicking(target)
  }

  const routeResult = useMemo(() => {
    if (!start || !finish) return null
    try {
      return { route: findRoute(graph, start, finish, { lockSpeed }), error: null }
    } catch (error) {
      return { route: null, error: routeErrorMessage(error) }
    }
  }, [start, finish, lockSpeed])
  const route = routeResult?.route ?? null

  useEffect(() => {
    if (!mapContainer.current) return

    const map = new Map({
      container: mapContainer.current,
      style: {
        version: 8,
        glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution:
              '&copy; OpenStreetMap contributors · Lock data &copy; Canal &amp; River Trust',
          },
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
      // Start on the canal network so the first tiles fetched are the ones shown.
      bounds: routeBounds,
      fitBoundsOptions: { padding: 48 },
    })
    mapRef.current = map

    // 'style.load' fires once our inline style is parsed. 'load' would also wait
    // for the first background tiles, holding back the canal layers.
    map.once('style.load', async () => {
      await addMapIcons(map)
      // React StrictMode may have torn this map down while the icons loaded.
      if (mapRef.current !== map) return

      map.addSource('region-boundary', { type: 'geojson', data: boundary })
      map.addLayer({
        id: 'region-fill',
        type: 'fill',
        source: 'region-boundary',
        paint: {
          'fill-color': '#176b87',
          'fill-opacity': 0.1,
        },
        layout: { visibility: 'visible' },
      })
      map.addLayer({
        id: 'region-outline',
        type: 'line',
        source: 'region-boundary',
        paint: {
          'line-color': '#07516a',
          'line-width': 2,
          'line-dasharray': [2, 2],
        },
        layout: { visibility: 'visible' },
      })

      map.addSource('graph-edges', { type: 'geojson', data: featureCollection(edgeFeatures) })
      map.addLayer({
        id: 'graph-edges',
        type: 'line',
        source: 'graph-edges',
        paint: {
          'line-color': '#006d77',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 13, 5],
          'line-opacity': 0.92,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      })

      const emptyRoute = routeFeatures(null)
      map.addSource('route-line', { type: 'geojson', data: emptyRoute.line })
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route-line',
        paint: {
          'line-color': '#fff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 7, 13, 13],
          'line-opacity': 0.95,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      })
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route-line',
        paint: {
          'line-color': '#1c4fd6',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 4, 13, 8],
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      })

      // A blue ring under each lock symbol the route passes through.
      map.addSource('route-locks', { type: 'geojson', data: emptyRoute.locks })
      map.addLayer({
        id: 'route-locks',
        type: 'circle',
        source: 'route-locks',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 9, 14, 15],
          'circle-color': 'rgba(28, 79, 214, 0.18)',
          'circle-stroke-color': '#1c4fd6',
          'circle-stroke-width': 2.5,
        },
      })

      map.addSource('graph-nodes', { type: 'geojson', data: featureCollection(nodeFeatures) })
      map.addLayer({
        id: 'graph-ends',
        type: 'circle',
        source: 'graph-nodes',
        filter: ['==', ['get', 'type'], 'end'],
        paint: {
          'circle-radius': 4,
          'circle-color': '#172a3a',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 1.5,
        },
      })

      map.addSource('graph-bridges', { type: 'geojson', data: featureCollection(bridgeFeatures) })
      map.addLayer({
        id: 'graph-bridges',
        type: 'symbol',
        source: 'graph-bridges',
        minzoom: 11,
        layout: {
          'icon-image': 'icon-bridge',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.7, 15, 1.1],
          'icon-allow-overlap': true,
          visibility: 'none',
        },
      })

      map.addLayer({
        id: 'graph-nodes',
        type: 'symbol',
        source: 'graph-nodes',
        filter: ['in', ['get', 'type'], ['literal', ['junction', 'winding']]],
        layout: {
          'icon-image': ['concat', 'icon-', ['get', 'type']],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.7, 14, 1.1],
          'icon-allow-overlap': true,
        },
      })

      map.addSource('graph-locks', { type: 'geojson', data: featureCollection(lockFeatures) })
      map.addLayer({
        id: 'graph-locks',
        type: 'symbol',
        source: 'graph-locks',
        layout: {
          'icon-image': 'icon-lock',
          'icon-rotate': ['get', 'rotate'],
          'icon-rotation-alignment': 'map',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.7, 14, 1.2],
          'icon-allow-overlap': true,
          'text-field': ['step', ['zoom'], '', 13, ['get', 'label']],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-offset': [0, 1.3],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: {
          'text-color': '#7a2414',
          'text-halo-color': '#fff',
          'text-halo-width': 1.5,
        },
      })

      map.addSource('marinas', { type: 'geojson', data: featureCollection(marinaFeatures) })
      map.addLayer({
        id: 'marinas',
        type: 'symbol',
        source: 'marinas',
        layout: {
          'icon-image': 'icon-marina',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.75, 14, 1.15],
          'icon-allow-overlap': true,
          'text-field': ['step', ['zoom'], '', 12, ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: {
          'text-color': '#123d73',
          'text-halo-color': '#fff',
          'text-halo-width': 1.5,
        },
      })

      map.addSource('graph-anchors', { type: 'geojson', data: featureCollection(anchorFeatures) })
      map.addLayer({
        id: 'graph-anchor-labels',
        type: 'symbol',
        source: 'graph-anchors',
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 12,
          'text-offset': [0, 1.6],
          'text-anchor': 'top',
          'text-font': ['Noto Sans Regular'],
        },
        paint: {
          'text-color': '#172a3a',
          'text-halo-color': '#fff',
          'text-halo-width': 1.5,
        },
      })

      // One handler for every clickable layer, so only the top-most feature under
      // the pointer (a lock symbol rather than the canal beneath it) opens a popup.
      // The popup is closed here rather than with closeOnClick, whose own click
      // listener would otherwise close a popup this handler has just reopened.
      const popup = new Popup({ closeButton: true, closeOnClick: false })
      const clickable = CLICKABLE_LAYERS.filter((layer) => map.getLayer(layer))
      map.on('click', (event) => {
        if (pickingRef.current) {
          popup.remove()
          return
        }
        const [feature] = map.queryRenderedFeatures(event.point, { layers: clickable })
        const properties = feature?.properties as FeatureProperties | undefined
        if (!feature || !properties) {
          popup.remove()
          return
        }
        const layer = feature.layer.id as (typeof CLICKABLE_LAYERS)[number]
        const { title, details } = describeFeature(layer, properties)
        const coordinates =
          feature.geometry.type === 'Point'
            ? (feature.geometry.coordinates as [number, number])
            : event.lngLat
        popup
          .setLngLat(coordinates)
          .setHTML(`<strong>${escapeHtml(title)}</strong><br>${escapeHtml(details)}`)
          .addTo(map)
      })
      for (const layer of clickable) {
        map.on('mouseenter', layer, () => {
          if (!pickingRef.current) map.getCanvas().style.cursor = 'pointer'
        })
        map.on('mouseleave', layer, () => {
          map.getCanvas().style.cursor = ''
        })
      }

      // Registered after the layer handlers so they still see picking mode on the
      // click that sets the finish, and skip their popups.
      map.on('click', (event) => {
        const target = pickingRef.current
        if (!target) return
        const snapped = snapToNetwork(graph, [event.lngLat.lng, event.lngLat.lat])
        if (!snapped) {
          setPickError(OFF_NETWORK_MESSAGE)
          return
        }
        setPickError(null)
        if (target === 'start') {
          setStart(snapped.coord)
          pickingRef.current = 'finish'
          setPicking('finish')
        } else {
          setFinish(snapped.coord)
          pickingRef.current = null
          setPicking(null)
        }
      })

      setMapReady(true)
    })


    map.on('error', (event) => console.error('MapLibre error:', event.error))
    map.addControl(new NavigationControl(), 'top-right')

    const markers = markersRef.current
    return () => {
      markers.start?.remove()
      markers.finish?.remove()
      markers.start = null
      markers.finish = null
      mapRef.current = null
      setMapReady(false)
      map.remove()
    }
  }, [])

  // Keep the start and finish markers in sync with state. Dragging a marker
  // snaps it back onto the canal, or back to where it was if it's too far away.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return

    const sync = (
      target: PickTarget,
      point: LonLat | null,
      setPoint: (update: (current: LonLat | null) => LonLat | null) => void,
    ) => {
      const markers = markersRef.current
      if (!point) {
        markers[target]?.remove()
        markers[target] = null
        return
      }
      let marker = markers[target]
      if (!marker) {
        marker = new Marker({
          color: target === 'start' ? '#26834a' : '#9c3151',
          draggable: true,
        })
          .setLngLat(point)
          .addTo(map)
        marker.getElement().setAttribute('aria-label', `Route ${target}`)
        const created = marker
        marker.on('dragend', () => {
          const { lng, lat } = created.getLngLat()
          const snapped = snapToNetwork(graph, [lng, lat])
          if (!snapped) {
            setPickError(OFF_NETWORK_MESSAGE)
            setPoint((current) => (current ? [current[0], current[1]] : current))
            return
          }
          setPickError(null)
          setPoint(() => snapped.coord)
        })
        markers[target] = marker
      }
      marker.setLngLat(point)
    }

    sync('start', start, setStart)
    sync('finish', finish, setFinish)
  }, [start, finish, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return

    const features = routeFeatures(route)
    ;(map.getSource('route-line') as GeoJSONSource | undefined)?.setData(features.line)
    ;(map.getSource('route-locks') as GeoJSONSource | undefined)?.setData(features.locks)

    // Zoom to a route when its end points change, not when only the pace does.
    const key = route && start && finish ? `${start}|${finish}` : null
    if (route && key !== fittedRouteKey.current) {
      const bounds = route.coords.reduce(
        (box, coord) => box.extend(coord),
        new LngLatBounds(route.coords[0], route.coords[0]),
      )
      // Keep the route clear of the panel: beside it on wide screens, below it
      // when it spans the width of a phone.
      const panel = panelRef.current?.getBoundingClientRect()
      const container = map.getContainer().getBoundingClientRect()
      const padding = { top: 48, bottom: 48, left: 48, right: 48 }
      if (panel && panel.right > container.width * 0.6) {
        padding.top = Math.min(panel.bottom + 24, container.height * 0.7)
        padding.left = 24
        padding.right = 24
        padding.bottom = 24
      } else if (panel) {
        padding.left = panel.right + 32
      }
      map.fitBounds(bounds, { padding, maxZoom: 15 })
    }
    fittedRouteKey.current = key
  }, [route, start, finish, mapReady])

  useEffect(() => {
    if (!picking) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        pickingRef.current = null
        setPicking(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [picking])

  const clearRoute = () => {
    beginPicking(null)
    setStart(null)
    setFinish(null)
    setPickError(null)
  }

  const togglePicking = () => {
    setPickError(null)
    if (picking) {
      beginPicking(null)
      return
    }
    setStart(null)
    setFinish(null)
    beginPicking('start')
  }

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return

    const groups: [string[], boolean][] = [
      [['graph-locks', 'graph-nodes', 'graph-ends'], showNodes],
      [['graph-bridges'], showBridges],
      [['marinas'], showMarinas],
      [['region-fill', 'region-outline'], showBoundary],
    ]
    for (const [layers, visible] of groups) {
      for (const layer of layers) {
        if (map.getLayer(layer)) {
          map.setLayoutProperty(layer, 'visibility', visible ? 'visible' : 'none')
        }
      }
    }
  }, [showNodes, showBridges, showMarinas, showBoundary, mapReady])

  return (
    <main className="map-shell">
      <div
        className={`map${picking ? ' is-picking' : ''}`}
        ref={mapContainer}
        aria-label="London canal graph map"
      />
      <section className="map-panel" aria-label="Graph map controls" ref={panelRef}>
        <div className="map-panel-heading">
          <div>
            <p className="eyebrow">Windlass v1.0</p>
            <h1>London waterways</h1>
          </div>
          <span
            className={`connection-status ${graph.connected && graph.componentCount === 1 ? 'is-connected' : 'is-disconnected'}`}
          >
            {graph.connected && graph.componentCount === 1
              ? 'Connected'
              : `${graph.componentCount} components`}
          </span>
        </div>
        <p className="map-summary">
          {graph.edges.length} canal sections · {graph.nodes.length} graph nodes
        </p>
        <section className="route-planner" aria-label="Route planner">
          <div className="route-planner-heading">
            <h2>Plan a route</h2>
            {(start || finish) && (
              <button className="text-button" onClick={clearRoute} type="button">
                Clear
              </button>
            )}
          </div>
          <fieldset className="lock-pace">
            <legend>Lock working</legend>
            {LOCK_SPEEDS.map(({ value, label }) => (
              <label key={value} className={lockSpeed === value ? 'is-selected' : ''}>
                <input
                  checked={lockSpeed === value}
                  name="lock-pace"
                  onChange={() => setLockSpeed(value)}
                  type="radio"
                  value={value}
                />
                <span>{label}</span>
                <small>{LOCK_MINUTES[value]} min/lock</small>
              </label>
            ))}
          </fieldset>
          <button
            className={`plan-button${picking ? ' is-active' : ''}`}
            onClick={togglePicking}
            type="button"
          >
            {picking ? 'Cancel' : start && finish ? 'Pick new points' : 'Pick start and finish'}
          </button>
          {picking && (
            <p className="route-hint">
              Click the map to set the <strong>{picking}</strong>. Press Esc to cancel.
            </p>
          )}
          {pickError && (
            <p className="route-error" role="alert">
              {pickError}
            </p>
          )}
          {routeResult?.error && (
            <p className="route-error" role="alert">
              {routeResult.error}
            </p>
          )}
          {route && (
            <div className="route-summary" aria-live="polite">
              <p className="route-total">
                {formatDuration(route.totalMinutes)}
                <span> fastest at {lockSpeed} lock working</span>
              </p>
              <dl className="route-stats">
                <div>
                  <dt>Distance</dt>
                  <dd>{(route.distanceM / 1000).toFixed(1)} km</dd>
                </div>
                <div>
                  <dt>Cruising</dt>
                  <dd>{formatDuration(route.cruiseMinutes)}</dd>
                </div>
                <div>
                  <dt>Locks</dt>
                  <dd>
                    {route.locks.length}
                    {route.locks.length > 0 && <small>{formatDuration(route.lockMinutes)}</small>}
                  </dd>
                </div>
              </dl>
              {route.locks.length > 0 && (
                <details className="route-locks">
                  <summary>Locks in order</summary>
                  <ol>
                    {route.locks.map((lock, index) => (
                      <li key={`${index}-${lock.name}`}>{lock.name}</li>
                    ))}
                  </ol>
                </details>
              )}
              <p className="route-note">
                Drag the markers to adjust. Cruising at {DEFAULT_SPEED_KMH} km/h (4 mph).
              </p>
            </div>
          )}
        </section>
        <button
          className="fit-route-button"
          onClick={() => mapRef.current?.fitBounds(routeBounds, { padding: 48 })}
          type="button"
        >
          Show full route
        </button>
        <div className="map-toggles">
          <label>
            <input
              checked
              disabled
              type="checkbox"
              aria-label="Show waterways"
            />
            <span className="legend-line" />
            Waterways
          </label>
          <label className="map-toggle-wide">
            <input
              checked={showNodes}
              onChange={(event) => setShowNodes(event.target.checked)}
              type="checkbox"
            />
            <span className="legend-icons">
              <LegendIcon name="lock" />
              <LegendIcon name="junction" />
              <LegendIcon name="winding" />
            </span>
            Locks, junctions &amp; winding holes
          </label>
          <label>
            <input
              checked={showBridges}
              onChange={(event) => setShowBridges(event.target.checked)}
              type="checkbox"
            />
            <LegendIcon name="bridge" />
            Bridges ({graphCounts.bridges})
          </label>
          <label>
            <input
              checked={showBoundary}
              onChange={(event) => setShowBoundary(event.target.checked)}
              type="checkbox"
            />
            <span className="legend-boundary" />
            Region boundary
          </label>
          <label>
            <input
              checked={showMarinas}
              onChange={(event) => setShowMarinas(event.target.checked)}
              type="checkbox"
            />
            <LegendIcon name="marina" />
            Marinas ({marinaFeatures.length})
          </label>
        </div>
        <p className="map-help">Click a symbol or line for its details. Lock names and numbers come from Canal &amp; River Trust open data.</p>
      </section>
    </main>
  )
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return entities[character]
  })
}

export default App

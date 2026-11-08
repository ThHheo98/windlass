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
import graphJson from '../data/graph/graph.json?raw'
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

type GraphNode = {
  id: string | number
  lon: number
  lat: number
  type: 'lock' | 'junction' | 'winding' | 'end' | 'join'
  name?: string
}

type GraphEdge = {
  id: string
  a: string | number
  b: string | number
  lengthM: number
  lock: boolean
  lockName?: string
  name?: string
  way: string | number
  coords: [number, number][]
  bridges: { atM: number; name?: string }[]
}

type GraphData = {
  connected: boolean
  componentCount: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  anchors: {
    start: { feature: string; vertexId: string | number } | null
    finish: { feature: string; vertexId: string | number } | null
  }
}

type FeatureProperties = Record<string, string | number | boolean | null>

setWorkerUrl(workerUrl)

const graph = JSON.parse(graphJson) as GraphData
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

function pointAlongEdge(edge: GraphEdge, atM: number): [number, number] {
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
      way: edge.way,
    },
    geometry: {
      type: 'LineString' as const,
      coordinates: edge.coords,
    },
  }))

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

const anchorFeatures = [
  { ...graph.anchors.start, role: 'Start' },
  { ...graph.anchors.finish, role: 'Finish' },
]
  .filter(
    (
      anchor,
    ): anchor is {
      feature: string
      vertexId: string | number
      role: string
    } => anchor.feature !== null && anchor.vertexId !== null,
  )
  .flatMap((anchor) => {
    const node = graph.nodes.find(
      (candidate) => String(candidate.id) === String(anchor.vertexId),
    )
    return node
      ? [
          {
            type: 'Feature' as const,
            properties: { name: anchor.feature, role: anchor.role },
            geometry: {
              type: 'Point' as const,
              coordinates: [node.lon, node.lat],
            },
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
            attribution: '&copy; OpenStreetMap contributors',
          },
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
      center: [-0.1276, 51.5072],
      zoom: 10,
    })
    mapRef.current = map

    map.on('load', () => {
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

      map.addSource('graph-edges', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: edgeFeatures,
        },
      })
      map.addLayer({
        id: 'graph-edges',
        type: 'line',
        source: 'graph-edges',
        paint: {
          'line-color': [
            'case',
            ['boolean', ['get', 'lock'], false],
            '#dd5e32',
            '#006d77',
          ],
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8,
            2,
            13,
            5,
          ],
          'line-opacity': 0.92,
        },
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
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

      map.addSource('graph-nodes', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: nodeFeatures,
        },
      })
      map.addLayer({
        id: 'graph-nodes',
        type: 'circle',
        source: 'graph-nodes',
        filter: ['!=', ['get', 'type'], 'join'],
        paint: {
          'circle-radius': [
            'match',
            ['get', 'type'],
            'lock',
            5,
            'junction',
            6,
            'winding',
            5,
            4,
          ],
          'circle-color': [
            'match',
            ['get', 'type'],
            'lock',
            '#d94f30',
            'junction',
            '#7251a2',
            'winding',
            '#d18b00',
            '#172a3a',
          ],
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 1.5,
        },
        layout: { visibility: 'visible' },
      })

      map.addSource('graph-bridges', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: bridgeFeatures,
        },
      })
      map.addLayer({
        id: 'graph-bridges',
        type: 'circle',
        source: 'graph-bridges',
        paint: {
          'circle-radius': 3.5,
          'circle-color': '#f1c40f',
          'circle-stroke-color': '#263238',
          'circle-stroke-width': 1,
        },
        layout: { visibility: 'none' },
      })

      map.addSource('graph-anchors', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: anchorFeatures,
        },
      })
      map.addLayer({
        id: 'graph-anchors',
        type: 'circle',
        source: 'graph-anchors',
        paint: {
          'circle-radius': 8,
          'circle-color': [
            'match',
            ['get', 'role'],
            'Start',
            '#26834a',
            '#9c3151',
          ],
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      })
      map.addLayer({
        id: 'graph-anchor-labels',
        type: 'symbol',
        source: 'graph-anchors',
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 12,
          'text-offset': [0, 1.5],
          'text-anchor': 'top',
          'text-font': ['Noto Sans Regular'],
        },
        paint: {
          'text-color': '#172a3a',
          'text-halo-color': '#fff',
          'text-halo-width': 1.5,
        },
      })

      map.addSource('route-locks', { type: 'geojson', data: emptyRoute.locks })
      map.addLayer({
        id: 'route-locks',
        type: 'circle',
        source: 'route-locks',
        paint: {
          'circle-radius': 7,
          'circle-color': '#d94f30',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2.5,
        },
      })

      const popup = new Popup({ closeButton: true, closeOnClick: true })
      map.on('click', 'route-locks', (event) => {
        const properties = event.features?.[0]?.properties as FeatureProperties | undefined
        if (pickingRef.current || !properties) return
        popup
          .setLngLat(event.lngLat)
          .setHTML(
            `<strong>${escapeHtml(String(properties.name))}</strong><br>Lock ${escapeHtml(String(properties.order))} on route`,
          )
          .addTo(map)
      })
      for (const layer of ['graph-edges', 'graph-nodes', 'graph-bridges']) {
        map.on('click', layer, (event) => {
          if (pickingRef.current) return
          const feature = event.features?.[0]
          if (!feature) return
          const properties = feature.properties as FeatureProperties | null
          if (!properties) return
          const coordinates =
            layer === 'graph-edges'
              ? event.lngLat
              : (feature.geometry.type === 'Point'
                  ? feature.geometry.coordinates
                  : [event.lngLat.lng, event.lngLat.lat]) as [number, number]
          const title =
            layer === 'graph-nodes'
              ? `${String(properties.type)}: ${String(properties.name || properties.id)}`
              : layer === 'graph-bridges'
                ? `Bridge: ${String(properties.name)}`
                : String(properties.name)
          const details =
            layer === 'graph-edges'
              ? `${(Number(properties.lengthM) / 1000).toFixed(2)} km${properties.lock ? ' · lock chamber' : ''}`
              : layer === 'graph-bridges'
                ? `Crosses ${String(properties.edge)}${properties.atM ? ` · ${Math.round(Number(properties.atM))} m along` : ''}`
                : `OSM node ${String(properties.id)}`
          popup
            .setLngLat(coordinates)
            .setHTML(
              `<strong>${escapeHtml(title)}</strong><br>${escapeHtml(details)}`,
            )
            .addTo(map)
        })
      }
      for (const layer of ['graph-edges', 'graph-nodes', 'graph-bridges', 'route-locks']) {
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

      map.fitBounds(
        routeBounds,
        { padding: 48 },
      )
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
    if (!map) return

    const updateVisibility = () => {
      if (map.getLayer('graph-nodes')) {
        map.setLayoutProperty(
          'graph-nodes',
          'visibility',
          showNodes ? 'visible' : 'none',
        )
      }
      if (map.getLayer('graph-bridges')) {
        map.setLayoutProperty(
          'graph-bridges',
          'visibility',
          showBridges ? 'visible' : 'none',
        )
      }
      for (const layer of ['region-fill', 'region-outline']) {
        if (map.getLayer(layer)) {
          map.setLayoutProperty(
            layer,
            'visibility',
            showBoundary ? 'visible' : 'none',
          )
        }
      }
    }

    if (map.getLayer('graph-nodes')) {
      updateVisibility()
    } else {
      map.once('load', updateVisibility)
    }
  }, [showNodes, showBridges, showBoundary])

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
          <label>
            <input
              checked={showNodes}
              onChange={(event) => setShowNodes(event.target.checked)}
              type="checkbox"
            />
            <span className="legend-node" />
            Locks &amp; junctions
          </label>
          <label>
            <input
              checked={showBridges}
              onChange={(event) => setShowBridges(event.target.checked)}
              type="checkbox"
            />
            <span className="legend-bridge" />
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
        </div>
        <p className="map-help">Click a line or marker for its OSM details.</p>
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

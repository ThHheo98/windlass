import { useEffect, useRef } from 'react'
import { Map, NavigationControl, setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import regionBoundary from '../data/region/london-mvp.geojson?raw'
import './App.css'

setWorkerUrl(workerUrl)

const boundary = JSON.parse(regionBoundary)

function App() {
  const mapContainer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mapContainer.current) return

    const map = new Map({
      container: mapContainer.current,
      style: {
        version: 8,
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

    map.on('load', () => {
      map.addSource('region-boundary', {
        type: 'geojson',
        data: boundary,
      })
      map.addLayer({
        id: 'region-fill',
        type: 'fill',
        source: 'region-boundary',
        paint: {
          'fill-color': '#176b87',
          'fill-opacity': 0.16,
        },
      })
      map.addLayer({
        id: 'region-outline',
        type: 'line',
        source: 'region-boundary',
        paint: {
          'line-color': '#07516a',
          'line-width': 3,
        },
      })
      map.fitBounds(
        [
          [-0.524196, 51.454385],
          [0.004612, 51.682351],
        ],
        { padding: 32 },
      )
    })

    map.on('error', (event) => console.error('MapLibre error:', event.error))
    map.addControl(new NavigationControl(), 'top-right')

    return () => map.remove()
  }, [])

  return <main className="map" ref={mapContainer} aria-label="Map of London" />
}

export default App

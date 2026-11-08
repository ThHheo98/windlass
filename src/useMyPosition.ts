import { useEffect, useMemo, useRef, useState } from 'react'
import type { LockSpeed, Route, RouteGraph } from '../scripts/route-lib.mjs'
import {
  createTracker,
  simulateRoute,
  type Fix,
  type TrackResult,
} from '../scripts/track-lib.mjs'

export type PositionState =
  | { status: 'off' }
  | { status: 'locating' }
  | { status: 'denied' }
  | { status: 'unavailable'; reason: string }
  | TrackResult

/**
 * `?simulate` replays a boat along the planned route (or the fallback route)
 * instead of using the device's GPS. `?simulate=60` runs it 60x faster than
 * real time; the default is 30x.
 */
export function simulationSpeed(): number | null {
  const value = new URLSearchParams(window.location.search).get('simulate')
  if (value === null) return null
  const speed = Number(value)
  return Number.isFinite(speed) && speed > 0 ? speed : 30
}

function unavailableReason(simulating: boolean, replay: Route | null) {
  if (simulating) return replay ? null : 'There is no route to simulate.'
  if (!window.isSecureContext) return 'Location only works on a secure (https) page.'
  if (!('geolocation' in navigator)) return 'This browser or device has no location service.'
  return null
}

/**
 * The device's position snapped onto the canal, between start() and stop().
 * The position never leaves the device and isn't stored.
 */
export function useMyPosition({
  graph,
  route,
  fallbackRoute,
  lockSpeed,
}: {
  graph: RouteGraph
  route: Route | null
  fallbackRoute: Route | null
  lockSpeed: LockSpeed
}) {
  const [session, setSession] = useState<{ id: number; replay: Route | null; pace: LockSpeed } | null>(
    null,
  )
  const [latest, setLatest] = useState<{ session: number; value: PositionState } | null>(null)
  const speedup = useMemo(() => simulationSpeed(), [])

  // A new tracker whenever the route or pace changes; it picks the boat up again
  // from the next fix.
  const tracker = useMemo(() => createTracker(graph, { route, lockSpeed }), [graph, route, lockSpeed])
  const trackerRef = useRef(tracker)
  useEffect(() => {
    trackerRef.current = tracker
  }, [tracker])

  const blocked = session ? unavailableReason(speedup !== null, session.replay) : null

  useEffect(() => {
    if (!session || blocked) return
    const report = (value: PositionState) => setLatest({ session: session.id, value })
    const onFix = (fix: Fix) => report(trackerRef.current.update(fix))

    if (speedup !== null && session.replay) {
      const fixes = simulateRoute(session.replay, {
        lockSpeed: session.pace,
        noiseM: 6,
        glitchEvery: 97,
      })
      const startedAt = Date.now()
      let next = 0
      const timer = window.setInterval(() => {
        const simulatedNow = (Date.now() - startedAt) * speedup
        while (next < fixes.length && fixes[next].time <= simulatedNow) {
          onFix(fixes[next])
          next += 1
        }
        if (next >= fixes.length) window.clearInterval(timer)
      }, 100)
      return () => window.clearInterval(timer)
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) =>
        onFix({
          coord: [position.coords.longitude, position.coords.latitude],
          accuracyM: position.coords.accuracy,
          time: position.timestamp,
        }),
      (error) =>
        report(
          error.code === error.PERMISSION_DENIED
            ? { status: 'denied' }
            : {
                status: 'unavailable',
                reason:
                  error.code === error.TIMEOUT
                    ? 'No GPS fix yet. Try somewhere with a clear view of the sky.'
                    : 'Your position isn’t available right now.',
              },
        ),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 30_000 },
    )
    return () => navigator.geolocation.clearWatch(watchId)
  }, [session, blocked, speedup])

  let state: PositionState = { status: 'off' }
  if (session && blocked) state = { status: 'unavailable', reason: blocked }
  else if (session) state = latest?.session === session.id ? latest.value : { status: 'locating' }

  return {
    state,
    active: session !== null,
    simulated: speedup !== null,
    // The simulation replays the route and pace at the moment it starts.
    start: () =>
      setSession((current) => ({
        id: (current?.id ?? 0) + 1,
        replay: route ?? fallbackRoute,
        pace: lockSpeed,
      })),
    stop: () => setSession(null),
  }
}

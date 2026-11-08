import type { LockSpeed, LonLat, Route, RouteGraph } from './route-lib.mjs'

export type Fix = { coord: LonLat; accuracyM: number; time: number }

export type TrackStatus =
  | 'searching'
  | 'tracking'
  | 'held'
  | 'off-canal'
  | 'off-route'
  | 'low-accuracy'

export type RouteProgress = {
  alongM: number
  remainingM: number
  remainingMinutes: number
  locksPassed: number
  locksLeft: number
  nextLock: { name: string; inM: number } | null
  arrived: boolean
}

export type TrackResult = {
  status: TrackStatus
  raw: { coord: LonLat; accuracyM: number }
  coord: LonLat | null
  edgeId: string | number | null
  progress?: RouteProgress
}

export type Tracker = {
  update(fix: Fix): TrackResult
  reset(): void
}

export type RouteLine = { coords: LonLat[]; along: number[] }

export declare const MAX_BOAT_SPEED_KMH: number
export declare const MAX_ACCURACY_M: number
export declare const CONFIRM_FIXES: number
export declare function acceptDistanceM(accuracyM: number): number
export declare function routeLine(route: Route): RouteLine
export declare function pointAlongRoute(line: RouteLine, atM: number): LonLat
export declare function createTracker(
  graph: RouteGraph,
  options?: {
    route?: Route | null
    lockSpeed?: LockSpeed
    speedKmh?: number
    alpha?: number
    beta?: number
  },
): Tracker
export declare function simulateRoute(
  route: Route,
  options?: {
    speedKmh?: number
    lockSpeed?: LockSpeed
    intervalS?: number
    noiseM?: number
    accuracyM?: number
    glitchEvery?: number
    glitchM?: number
    seed?: number
    startTime?: number
  },
): (Fix & { trueAlongM: number })[]

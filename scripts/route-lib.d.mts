export type LonLat = [number, number]
export type LockSpeed = 'slow' | 'medium' | 'fast'

export type RouteEdge = {
  id: string | number
  a: string | number
  b: string | number
  lengthM: number
  lock: boolean
  lockName?: string
  lockNumber?: string
  waterwayName?: string
  crtId?: string
  name?: string
  coords: LonLat[]
}

export type RouteGraph = { edges: RouteEdge[] }

export type RouteOptions = { lockSpeed?: LockSpeed; speedKmh?: number }

export type Snap = {
  edge: RouteEdge
  coord: LonLat
  distanceM: number
  alongM: number
}

export type Route = {
  coords: LonLat[]
  distanceM: number
  cruiseMinutes: number
  lockMinutes: number
  totalMinutes: number
  lockSpeed: LockSpeed
  locks: {
    name: string
    number: string | null
    waterway: string | null
    coord: LonLat
    atM: number
  }[]
  start: { coord: LonLat; distanceM: number; edgeName?: string }
  finish: { coord: LonLat; distanceM: number; edgeName?: string }
}

export type RouteErrorCode =
  | 'bad-lock-speed'
  | 'bad-speed'
  | 'start-off-network'
  | 'finish-off-network'
  | 'no-route'

export declare const LOCK_MINUTES: Readonly<Record<LockSpeed, number>>
export declare const DEFAULT_SPEED_KMH: number
export declare const MAX_SNAP_DISTANCE_M: number
export declare const END_SNAP_M: number

export declare class RouteError extends Error {
  code: RouteErrorCode
  constructor(code: RouteErrorCode, message: string)
}

export declare function travelMinutes(
  lengthM: number,
  passesLock: boolean,
  options?: RouteOptions,
): number

export declare function snapToNetwork(
  graph: RouteGraph,
  point: LonLat,
  maxDistanceM?: number,
): Snap | null

export declare function findRoute(
  graph: RouteGraph,
  from: LonLat,
  to: LonLat,
  options?: RouteOptions,
): Route

import type { LonLat } from './route-lib.mjs'

export type NodeType = 'join' | 'end' | 'junction' | 'lock' | 'winding'

export type CompactGraph = {
  format: 'windlass-graph'
  version: number
  osmTimestamp: string | null
  connected: boolean
  componentCount: number
  strings: string[]
  nodes: number[]
  edges: number[]
  geometry: number[]
  locks: number[]
  bridges: number[]
  marinas: number[]
  anchors: number[]
}

export type DecodedGraph = {
  osmTimestamp: string | null
  connected: boolean
  componentCount: number
  nodes: { id: number; lon: number; lat: number; type: NodeType; name?: string }[]
  edges: {
    id: number
    a: number
    b: number
    lengthM: number
    lock: boolean
    name?: string
    lockName?: string
    lockNumber?: string
    waterwayName?: string
    crtId?: string
    coords: LonLat[]
    bridges: { atM: number; name?: string }[]
  }[]
  marinas: { id: number; name: string; lon: number; lat: number }[]
  anchors: {
    start: { vertexId: number; feature: string } | null
    finish: { vertexId: number; feature: string } | null
  }
}

export declare const GRAPH_FORMAT: 'windlass-graph'
export declare const GRAPH_VERSION: number
export declare const NODE_TYPES: readonly NodeType[]
export declare const SIMPLIFY_TOLERANCE_M: number
export declare function simplifyLine(coords: LonLat[], toleranceM?: number): LonLat[]
export declare function encodeGraph(graph: unknown, options?: { toleranceM?: number }): CompactGraph
export declare function decodeGraph(compact: CompactGraph): DecodedGraph
export declare function geometryLengthM(coords: LonLat[]): number

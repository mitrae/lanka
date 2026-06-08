// app/types/api.ts
//
// Mirror the return shapes of server/api handlers. Keeping this as a
// hand-maintained mirror (rather than type-imports from server/) lets Pinia
// stores and page components type-check without pulling the entire server
// import graph client-side.
//
// If a server handler's return shape changes, update the matching interface
// here and let TypeScript surface the affected pages.

export interface Address {
  id: number
  name: string
  createdAt: string
  updatedAt: string
}

export interface Group {
  id: number
  addressId: number
  name: string
  createdAt: string
  updatedAt: string
}

export type DeviceStatus = 'online' | 'idle' | 'offline'

export interface Device {
  id: string
  groupId: number | null
  name: string | null
  lastSeenAt: string | null
  playerVersion: string | null
  currentItemId: number | null
  createdAt: string
  updatedAt: string
}

export interface DeviceListRow extends Device {
  status: DeviceStatus
}

export interface RegisterResult {
  deviceId: string
  claimed: boolean
  name: string | null
  groupId: number | null
}

export interface Media {
  id: number
  sha256: string
  kind: 'video' | 'image'
  filename: string
  mimeType: string
  bytes: number
  thumbnailBytes: number | null
  durationMs: number | null
  width: number | null
  height: number | null
  createdAt: string
  organizationId: number | null
}

export interface MediaListRow extends Media {
  usedInPlaylists: number
}

export interface PlaylistItem {
  id: number
  playlistId: number
  mediaId: number
  position: number
  durationMsOverride: number | null
}

export interface Playlist {
  id: number
  name: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface PlaylistDetail extends Playlist {
  items: PlaylistItem[]
}

export interface PlaylistSummary extends Playlist {
  itemCount: number
  assignmentCount: number
}

export interface ManifestItem {
  id: number
  type: 'video' | 'image'
  sha256: string
  durationMs: number
}

export interface Manifest {
  playlistId: number
  playlistName: string
  version: number
  items: ManifestItem[]
}

export interface Assignment {
  id: number
  playlistId: number
  deviceId: string | null
  groupId: number | null
  addressId: number | null
  createdAt: string
  updatedAt: string
}

export type Role = 'super' | 'admin' | 'client'
export interface SessionUser {
  id: number
  email: string
  role: Role
  organizationId: number | null
}
export interface Organization {
  id: number
  name: string
  createdAt: string
  updatedAt: string
}
export interface MediaReach {
  mediaId: number
  filename: string
  kind: 'video' | 'image'
  screensScheduled: number
  screensOnline: number
  screensShowingNow: number
  recentErrors: number
}
export interface OrgReach {
  organization: { id: number; name: string }
  totals: { mediaCount: number; screensReached: number; screensOnline: number; showingNow: number }
  media: MediaReach[]
}

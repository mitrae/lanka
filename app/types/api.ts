// app/types/api.ts
//
// Mirror the return shapes of server/api handlers. Keeping this as a
// hand-maintained mirror (rather than type-imports from server/) lets Pinia
// stores and page components type-check without pulling the entire server
// import graph client-side.
//
// If a server handler's return shape changes, update the matching interface
// here and let TypeScript surface the affected pages.

/**
 * Playlist assignment context returned by the Address / Group / Device detail
 * endpoints: the row the assignment picker edits (`direct*`) and the playlist
 * that actually wins after Device > Group > Address resolution (`effective*`).
 */
export interface AssignmentContext {
  directPlaylistId: number | null
  directPlaylistName: string | null
  effectivePlaylistId: number | null
  effectivePlaylistName: string | null
  effectiveLevel: 'device' | 'group' | 'address' | null
}

export interface Address {
  id: number
  name: string
  createdAt: string
  updatedAt: string
}

/** GET /api/addresses/:id */
export interface AddressDetail extends Address, AssignmentContext {}

export interface Group {
  id: number
  addressId: number
  name: string
  createdAt: string
  updatedAt: string
}

/** GET /api/groups/:id */
export interface GroupDetail extends Group, AssignmentContext {}

export type DeviceStatus = 'online' | 'idle' | 'offline'

export interface Device {
  id: string
  groupId: number | null
  name: string | null
  lastSeenAt: string | null
  playerVersion: string | null
  currentItemId: number | null
  surface: 'webview' | 'native'
  /** Is the player actually on screen? 'unknown' = never reported. */
  visibility: 'foreground' | 'obscured' | 'background' | 'unknown'
  visibilitySince: string | number | null
  foregroundPackage: string | null
  snapBacks: number
  focusLosses: number
  hiddenMs: number
  createdAt: string
  updatedAt: string
}

export interface DeviceListRow extends Device {
  status: DeviceStatus
}

/** GET /api/devices/:id */
export interface DeviceDetail extends Device, AssignmentContext {}

export interface RegisterResult {
  deviceId: string
  claimed: boolean
  name: string | null
  groupId: number | null
  /** Raw command-channel secret — present only on the device's FIRST register
   *  (trust-on-first-use); null afterwards. Persist it on first receipt. */
  commandSecret: string | null
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
  playCount: number
  quality: 'low' | 'standard' | 'high'
}

export interface MediaListRow extends Media {
  usedInPlaylists: number
}

export interface MediaDetail extends Media {
  playlists: { id: number; name: string }[]
}

export type UploadStatus = 'pending' | 'queued' | 'processing' | 'done' | 'failed' | 'expired'

/** Where the browser must PUT the bytes (presigned R2 URL or same-origin /file). */
export interface UploadTicket {
  method: 'PUT'
  url: string
  headers: Record<string, string>
  expiresAt: number
}

export interface UploadJob {
  id: string
  filename: string
  kind: 'video' | 'image'
  quality: 'low' | 'standard' | 'high'
  mimeType: string
  bytes: number
  status: UploadStatus
  error: string | null
  mediaId: number | null
  attempts: number
  createdAt: string
  updatedAt: string
  media?: Media | null
}

export interface CreateUploadBody {
  filename: string
  kind: 'video' | 'image'
  quality: 'low' | 'standard' | 'high'
  mimeType: string
  bytes: number
}

export interface CreatedUpload extends UploadJob {
  upload: UploadTicket
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
  /** The server's build id; the player reloads when it differs from its own. */
  playerBuild?: string
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
  phone: string | null
  email: string | null
  notes: string | null
  /** Media files owned by this org. */
  mediaCount: number
  /** Client accounts belonging to it — force-deleting the org deletes them. */
  userCount: number
  createdAt: string
  updatedAt: string
}
export interface OrganizationInput {
  name?: string
  phone?: string | null
  email?: string | null
  notes?: string | null
}
export interface User {
  id: number
  email: string
  role: Role
  organizationId: number | null
  organizationName: string | null
  createdAt: string
}
export interface CreateUserBody {
  email: string
  role: 'admin' | 'client'
  organizationId?: number
}
export interface UpdateUserBody {
  email?: string
  role?: 'admin' | 'client'
  /** null is rejected for a client — the server requires an organization. */
  organizationId?: number | null
}
export interface CreateUserResult {
  user: { id: number; email: string; role: 'admin' | 'client'; organizationId: number | null }
  generatedPassword: string
}
export interface MediaReach {
  mediaId: number
  filename: string
  kind: 'video' | 'image'
  screensScheduled: number
  screensOnline: number
  screensShowingNow: number
  recentErrors: number
  playCount: number
}
export interface OrgReach {
  organization: { id: number; name: string }
  totals: { mediaCount: number; screensReached: number; screensOnline: number; showingNow: number }
  media: MediaReach[]
}

/** Rich now-playing status returned by GET /api/devices/:id/status */
export interface DeviceNowPlaying {
  online: boolean
  lastSeenAt: number | null
  apkVersion?: string | null
  surface: 'webview' | 'native'
  visibility: 'foreground' | 'obscured' | 'background' | 'unknown'
  visibilitySince: number | null
  foregroundPackage: string | null
  snapBacks: number
  focusLosses: number
  hiddenMs: number
  currentItem: { mediaId: number; filename: string; kind: 'video' | 'image'; sha256: string } | null
  playlistName: string | null
}

export interface ApkRelease {
  id: number
  version: string
  sha256: string
  size: number
  uploadedAt: string | number
}

export interface DeviceCommand {
  id: number
  deviceId: string
  cmd: 'ota' | 'reboot' | 'screenshot' | 'log-request' | 'kiosk-lock' | 'kiosk-unlock' | 'set-surface'
  payload: string | null
  status: 'pending' | 'sent' | 'acked' | 'failed'
  result: string | null
  createdAt: string | number
  updatedAt: string | number
}

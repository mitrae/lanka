export type ManifestKey = { playlistId: number; version: number }

export function shouldReconcile(
  prev: ManifestKey | null,
  next: ManifestKey
): boolean {
  if (!prev) return true
  return prev.playlistId !== next.playlistId || prev.version !== next.version
}

// app/composables/useFmtBytes.ts
//
// Shared human-readable byte formatter, auto-imported across components.

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let b = bytes
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024
    i++
  }
  return `${b.toFixed(i ? 1 : 0)} ${units[i]}`
}

// app/components/PlaylistEditor.logic.ts
export interface DraftItem {
  id: number | null // null for newly-added items
  mediaId: number
  durationMsOverride: number | null
}

export function reorderItems<T>(
  items: T[],
  fromIndex: number,
  toIndex: number
): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    fromIndex >= items.length ||
    toIndex < 0 ||
    toIndex >= items.length
  ) {
    return items
  }
  const next = items.slice()
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

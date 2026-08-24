// app/utils/mediaFilter.ts

/**
 * Media page organization filter. String values rather than `number | null`
 * because the underlying select serialises its value — a `null` item would be
 * indistinguishable from "nothing picked".
 */
export const ORG_FILTER_ALL = 'all'
export const ORG_FILTER_NONE = 'none'

export type OrgFilter = string

export function isOrgFilterActive(filter: OrgFilter): boolean {
  return filter !== ORG_FILTER_ALL
}

export function filterByOrganization<T extends { organizationId: number | null }>(
  items: T[],
  filter: OrgFilter
): T[] {
  if (filter === ORG_FILTER_ALL) return items
  if (filter === ORG_FILTER_NONE) return items.filter((m) => m.organizationId == null)
  const id = Number(filter)
  return items.filter((m) => m.organizationId === id)
}

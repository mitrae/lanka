import { describe, it, expect } from 'vitest'
import {
  filterByOrganization,
  isOrgFilterActive,
  ORG_FILTER_ALL,
  ORG_FILTER_NONE
} from '~/app/utils/mediaFilter'

const list = [
  { id: 1, organizationId: 1 },
  { id: 2, organizationId: null },
  { id: 3, organizationId: 2 },
  { id: 4, organizationId: 1 }
]

describe('media organization filter', () => {
  it('passes everything through when set to all', () => {
    expect(filterByOrganization(list, ORG_FILTER_ALL)).toEqual(list)
    expect(isOrgFilterActive(ORG_FILTER_ALL)).toBe(false)
  })

  it('selects the unassigned bucket', () => {
    expect(filterByOrganization(list, ORG_FILTER_NONE).map((m) => m.id)).toEqual([2])
    expect(isOrgFilterActive(ORG_FILTER_NONE)).toBe(true)
  })

  it('selects one organization by id', () => {
    expect(filterByOrganization(list, '1').map((m) => m.id)).toEqual([1, 4])
    expect(filterByOrganization(list, '2').map((m) => m.id)).toEqual([3])
  })

  it('returns nothing for an organization with no media', () => {
    expect(filterByOrganization(list, '99')).toEqual([])
  })
})

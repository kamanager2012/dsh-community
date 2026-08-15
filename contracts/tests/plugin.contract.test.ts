import { describe, expect, it } from 'vitest'
import { domainMustExist, officialWebRowIds } from './domain-rows.ts'

describe('official plugin surface', () => {
  it('still mounts official plugin inventory for out-of-tree UI', () => {
    const ids = officialWebRowIds()
    for (const id of domainMustExist('plugin')) {
      expect(ids, id).toContain(id)
    }
  })
})

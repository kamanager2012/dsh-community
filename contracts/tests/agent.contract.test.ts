import { describe, expect, it } from 'vitest'
import { domainMustExist, officialWebRowIds } from './domain-rows.ts'

describe('official agent surface', () => {
  it('still mounts the official agent loop, not a community one', () => {
    const ids = officialWebRowIds()
    for (const id of domainMustExist('agent')) {
      expect(ids, id).toContain(id)
    }
  })
})

import { describe, expect, it } from 'vitest'
import { domainMustExist, officialWebRowIds } from './domain-rows.ts'

describe('official approval surface', () => {
  it('still mounts official approval and permission rows', () => {
    const ids = officialWebRowIds()
    for (const id of domainMustExist('approval')) {
      expect(ids, id).toContain(id)
    }
  })
})

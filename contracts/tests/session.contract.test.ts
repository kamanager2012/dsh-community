import { describe, expect, it } from 'vitest'
import { domainMustExist, officialWebRowIds } from './domain-rows.ts'

describe('official session surface', () => {
  it('still mounts the session log and persistence rows', () => {
    const ids = officialWebRowIds()
    for (const id of domainMustExist('session')) {
      expect(ids, id).toContain(id)
    }
  })
})

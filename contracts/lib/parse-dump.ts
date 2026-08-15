export interface OfficialDumpRow {
  readonly id: string
  readonly name?: string
  readonly source?: string
}

export function parseOfficialDump(text: string): OfficialDumpRow[] {
  const rows: OfficialDumpRow[] = []
  let source: string | undefined
  let current: { id: string; name?: string; source?: string } | undefined
  for (const line of text.split('\n')) {
    const heading = /^# == (.+)$/.exec(line)
    if (heading) {
      source = heading[1].trim()
      continue
    }
    const id = /^- id: (\S+)$/.exec(line)
    if (id) {
      if (current !== undefined) rows.push(current)
      current = { id: id[1], ...(source === undefined ? {} : { source }) }
      continue
    }
    if (current === undefined) continue
    const name = /^ {2}name: (.+)$/.exec(line)
    if (name) current.name = name[1].trim().replaceAll(/^['"]|['"]$/g, '')
  }
  if (current !== undefined) rows.push(current)
  return rows
}

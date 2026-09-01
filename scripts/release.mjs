/**
 * Local release gate. Pushing the tag starts the GitHub `release` workflow,
 * which builds Linux / Windows / macOS artifacts and publishes the release.
 *
 * Usage: node scripts/release.mjs v0.1.0-rc.8-community.1
 */

import { spawnSync } from 'node:child_process'

const tag = process.argv[2]
if (tag === undefined || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  process.stderr.write('usage: node scripts/release.mjs <vX.Y.Z[-prerelease]>\n')
  process.exit(2)
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
  })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${String(result.status)})`)
}

const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
if (status.stdout.trim() !== '') {
  throw new Error('working tree is not clean; commit or stash before releasing')
}
const hasTag = spawnSync('git', ['tag', '--list', tag], { encoding: 'utf8' })
if (hasTag.stdout.trim() === tag) {
  throw new Error(`tag ${tag} already exists`)
}
process.stdout.write('0/6 validate candidate release identity\n')
run(process.execPath, ['scripts/validate-release-tag.mjs', tag])
process.stdout.write('1/6 verify current Published Latest against GitHub\n')
run(process.execPath, ['scripts/validate-published-latest.mjs'])

function productRemote() {
  const out = spawnSync('git', ['remote', '-v'], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error('git remote -v failed')
  for (const line of out.stdout.split('\n')) {
    if (!line.includes('(push)')) continue
    if (
      /github\.com[/:]kamanager2012\/dsh-community(?:\.git)?(?:\s|$)/.test(line)
      && !line.includes('dsh-community-edition')
    ) {
      return line.split(/\s+/)[0]
    }
  }
  throw new Error('no push remote for kamanager2012/dsh-community (not the edition archive)')
}

const remote = productRemote()

process.stdout.write('2/6 typecheck + test\n')
run('pnpm', ['install', '--frozen-lockfile'])
run('pnpm', ['typecheck'])
run('pnpm', ['test'])

process.stdout.write('3/6 build AppImage locally (sanity check)\n')
run('pnpm', ['desktop:package', '--', '--appimage'])

process.stdout.write('4/6 tag\n')
run('git', ['tag', tag])

process.stdout.write(`5/6 push tag to ${remote} (starts the 3-OS release workflow)\n`)
run('git', ['push', remote, tag])
process.stdout.write(`\n${tag} pushed. Watch https://github.com/kamanager2012/dsh-community/actions\n`)

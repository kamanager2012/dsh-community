import { EventEmitter } from 'node:events'
import type { HostChild } from '../src/spawn-web.ts'

export function fakeChild(
  pid = 4242,
  options: { readonly killExits?: boolean } = {},
): HostChild & {
  emitData(chunk: string): void
  emitStderr(chunk: string): void
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void
  readonly killedWith: Array<'SIGTERM' | 'SIGKILL'>
} {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const lifecycle = new EventEmitter()
  const killedWith: Array<'SIGTERM' | 'SIGKILL'> = []
  return {
    pid,
    stdout: {
      onData(listener) {
        stdout.on('data', listener)
        return () => stdout.off('data', listener)
      },
    },
    stderr: {
      onData(listener) {
        stderr.on('data', listener)
        return () => stderr.off('data', listener)
      },
    },
    onExit(listener) {
      lifecycle.on('exit', listener)
      return () => lifecycle.off('exit', listener)
    },
    onError() {
      return () => undefined
    },
    kill(signal) {
      killedWith.push(signal)
      if (options.killExits !== false) lifecycle.emit('exit', 0, null)
    },
    emitData(chunk) {
      stdout.emit('data', chunk)
    },
    emitStderr(chunk) {
      stderr.emit('data', chunk)
    },
    emitExit(code, signal = null) {
      lifecycle.emit('exit', code, signal)
    },
    killedWith,
  }
}

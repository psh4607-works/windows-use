import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import type { Readable } from 'node:stream'
import type { EventEmitter } from 'node:events'
import { spawnProcess } from '../../shared/child-process/run-process'
import type { BridgeRequest } from './desktop-script-provider-types'

const DEFAULT_STARTUP_TIMEOUT_MS = 3_000
const PIPE_ENV = 'ORCA_COMPUTER_WINDOWS_FOCUS_PIPE'
const TOKEN_ENV = 'ORCA_COMPUTER_WINDOWS_FOCUS_TOKEN'

export type WindowsFocusHelperChild = EventEmitter & {
  stdout: Readable | null
  stderr: Readable | null
  kill(signal?: NodeJS.Signals): boolean
}

type WindowsFocusHelperDeps = {
  exists: (path: string) => boolean
  spawn: (program: string, args: string[], env: NodeJS.ProcessEnv) => WindowsFocusHelperChild
  pipeName: () => string
  token: () => string
  parentPid: number
  startupTimeoutMs: number
}

const defaultDeps: WindowsFocusHelperDeps = {
  exists: existsSync,
  spawn: (program, args, env) =>
    spawnProcess({
      program,
      args,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    }) as WindowsFocusHelperChild,
  pipeName: () => `orca-computer-focus-${process.pid}-${randomUUID()}`,
  token: () => randomBytes(32).toString('hex'),
  parentPid: process.pid,
  startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS
}

export function shouldPrepareWindowsFocusHelper(
  request: Pick<BridgeRequest, 'tool' | 'restoreWindow'>
): boolean {
  return request.restoreWindow === true
}

export class WindowsFocusHelperClient {
  private readonly helperPath: string
  private readonly deps: WindowsFocusHelperDeps
  private child: WindowsFocusHelperChild | null = null
  private environment: NodeJS.ProcessEnv | null = null
  private starting: Promise<NodeJS.ProcessEnv> | null = null

  constructor(runtimePath: string, deps: Partial<WindowsFocusHelperDeps> = {}) {
    this.helperPath = join(dirname(runtimePath), 'focus-helper.ps1')
    this.deps = { ...defaultDeps, ...deps }
  }

  async environmentFor(
    request: Pick<BridgeRequest, 'tool' | 'restoreWindow'>
  ): Promise<NodeJS.ProcessEnv> {
    if (!shouldPrepareWindowsFocusHelper(request) || !this.deps.exists(this.helperPath)) {
      return {}
    }
    if (this.environment) {
      return this.environment
    }
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null
      })
    }
    return await this.starting
  }

  shutdown(): void {
    const child = this.child
    this.child = null
    this.environment = null
    this.starting = null
    child?.kill('SIGTERM')
  }

  private async start(): Promise<NodeJS.ProcessEnv> {
    const pipeName = this.deps.pipeName()
    const token = this.deps.token()
    const child = this.deps.spawn(
      windowsPowerShellPath(),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.helperPath,
        '-PipeName',
        pipeName,
        '-ParentPid',
        String(this.deps.parentPid)
      ],
      { ...process.env, [TOKEN_ENV]: token }
    )
    this.child = child
    child.stderr?.on('data', () => {})

    const ready = await this.waitForReady(child)
    if (!ready || this.child !== child) {
      if (this.child === child) {
        this.child = null
      }
      child.kill('SIGTERM')
      return {}
    }

    this.environment = { [PIPE_ENV]: pipeName, [TOKEN_ENV]: token }
    child.once('exit', () => this.clearExitedChild(child))
    child.once('error', () => this.clearExitedChild(child))
    return this.environment
  }

  private waitForReady(child: WindowsFocusHelperChild): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      let output = ''
      const finish = (ready: boolean): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        child.off('exit', onExit)
        child.off('error', onError)
        resolve(ready)
      }
      const onData = (chunk: Buffer | string): void => {
        output += chunk.toString()
        const lines = output.split(/\r?\n/)
        output = lines.pop() ?? ''
        if (lines.some((line) => line.trim() === '{"ready":true}')) {
          finish(true)
        }
      }
      const onExit = (): void => finish(false)
      const onError = (): void => finish(false)
      const timer = setTimeout(() => finish(false), this.deps.startupTimeoutMs)
      child.stdout?.on('data', onData)
      child.once('exit', onExit)
      child.once('error', onError)
    })
  }

  private clearExitedChild(child: WindowsFocusHelperChild): void {
    if (this.child !== child) {
      return
    }
    this.child = null
    this.environment = null
  }
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot?.trim() || env.WINDIR?.trim() || 'C:\\Windows'
  return win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

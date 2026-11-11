/**
 * The install gate seam: a provider that rules on a quarantined copy of a package before the profile installs it.
 * @module @deepseek-ai/dsh-plugin-manager/install-gate
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { execa } from 'execa'
import { parseAllDocuments } from 'yaml'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { ProfilePnpmInvocation } from '@deepseek-ai/dsh-app-boot'
import { anchorPathSpec, registryArguments } from './operations.ts'
import type { InstallGateLevel, InstallGateReport, InstallGateSeverity, Registry } from './types.ts'

/** What a quarantine fetch printed and how it ended. */
export interface QuarantineFetchResult {
  /** pnpm's exit code; null when it was killed or never started. */
  readonly exitCode: number | null
  /** Combined output tail, bounded by the manager's `outputBytes`. */
  readonly output: string
  /**
   * For a local directory spec, the directory itself: the profile links it, so its files are what gets installed,
   * while the quarantine copies it to resolve its dependencies.
   */
  readonly packageDir?: string
}

/** One package an installation is about to fetch, handed to the gate before the profile changes. */
export interface InstallGateRequest {
  /** The spec as the caller supplied it. */
  readonly spec: string
  /** The registry the installation asks first. */
  readonly registry: Registry
  /**
   * Install the spec into `dir` with lifecycle scripts disabled, using the profile's pnpm, registry and npmrc.
   * `dir` must hold a `package.json`; the fetched package lands in `dir/node_modules/<name>`.
   */
  readonly fetch: (dir: string, signal: AbortSignal) => Promise<QuarantineFetchResult>
  /** Stream one progress line into the installation's log. */
  readonly log: (text: string, stream: 'stdout' | 'stderr') => void
  /** Aborts when the installation is cancelled or the manager stops. */
  readonly signal: AbortSignal
}

/** A gate's ruling and the means to check that the profile installed the same files. */
export interface InstallGateVerdict {
  readonly report: InstallGateReport
  /**
   * Whether the package directory the profile installed holds exactly the files the gate scanned.
   * @param dir The installed package directory.
   * @returns True when the digests match.
   */
  readonly verifyInstalled: (dir: string) => Promise<boolean>
  /** Remove the quarantine; called once the installation settles. */
  readonly dispose: () => Promise<void>
}

/**
 * Service Definition for an install gate, registered through `PluginManager.registerInstallGate`. Any number of gates
 * can be registered; every installation asks all of them and follows the strictest ruling.
 */
export interface InstallGate {
  /** Stable identifier, unique among registered gates, such as the provider's package name. */
  readonly id: string
  /**
   * Quarantine and scan a package.
   * @param request The spec and the fetch, log and cancellation facilities of the installation.
   * @returns The ruling; a rejection fails the installation as an operation error.
   */
  vet(request: InstallGateRequest): Promise<InstallGateVerdict>
}

/** Pnpm invocation facts a quarantine fetch reuses from the manager. */
export interface QuarantineFetchOptions {
  readonly invocation: ProfilePnpmInvocation
  readonly profileDir: string
  /** The directory relative path specs are anchored to, as for the profile's own installation. */
  readonly cwd: string
  readonly spec: string
  readonly registry: Registry
  readonly outputBytes: number
  readonly timeoutMs: number
  readonly onOutput: (text: string, stream: 'stdout' | 'stderr') => void
}

/**
 * Run `pnpm add <spec> --ignore-scripts` in a quarantine directory. The profile's `.npmrc`, when present, is the user
 * config so registry and authentication settings match the real installation without copying credentials into the
 * scanned tree.
 * @param dir Quarantine directory holding a `package.json`.
 * @param signal Cancellation.
 * @param options The manager's pnpm invocation and bounds.
 * @returns Exit code and output tail.
 */
export async function quarantineFetch(dir: string, signal: AbortSignal, options: QuarantineFetchOptions): Promise<QuarantineFetchResult> {
  const npmrc = join(options.profileDir, '.npmrc')
  const env = {
    ...scrubbedParentEnv(), ...options.invocation.env,
    ...existsSync(npmrc) ? { npm_config_userconfig: npmrc } : {},
  }
  const anchored = anchorPathSpec(options.spec, options.cwd)
  const path = anchored.replace(/^(?:file|link):/, '')
  // A linked directory brings no dependency resolution, so the quarantine copies it to lock what it depends on.
  const local = isAbsolute(path) && !/\.(?:tgz|tar\.gz)$/.test(path)
  const child = execa(options.invocation.command, [
    ...options.invocation.args, 'add', local ? `file:${path}` : anchored, '--ignore-scripts', '--config.side-effects-cache=false',
    ...registryArguments(options.registry),
  ], {
    cwd: dir, env, extendEnv: false, reject: false, stdin: 'ignore', all: true, buffer: true,
    cancelSignal: signal, timeout: options.timeoutMs,
  })
  child.stdout.on('data', (chunk: Buffer) => { options.onOutput(chunk.toString('utf8'), 'stdout') })
  child.stderr.on('data', (chunk: Buffer) => { options.onOutput(chunk.toString('utf8'), 'stderr') })
  const settled = await child
  const all = Buffer.from(typeof settled.all === 'string' ? settled.all : '')
  return {
    exitCode: settled.exitCode ?? null,
    output: all.subarray(Math.max(0, all.length - options.outputBytes)).toString('utf8'),
    ...local ? { packageDir: path } : {},
  }
}

const LEVEL_RANK: Readonly<Record<InstallGateLevel, number>> = { pass: 0, review: 1, block: 2 }
const SEVERITY_RANK: Readonly<Record<InstallGateSeverity, number>> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

/**
 * Merge the rulings of several gates on one spec. The level is the strictest, the score the lowest any gate gave, and
 * the digest covers every gate's digest, so an acknowledgement names exactly the set of reports the person read; the
 * installed files must satisfy every gate.
 * @param verdicts One verdict per gate, in registration order; at least one.
 * @returns The single verdict the installation follows.
 */
export function combineVerdicts(verdicts: readonly InstallGateVerdict[]): InstallGateVerdict {
  const [first, ...rest] = verdicts
  if (first === undefined) throw new Error('plugin-manager: no install gate verdict to combine')
  if (rest.length === 0) return first
  const reports = verdicts.map(verdict => verdict.report)
  const level = reports.reduce<InstallGateLevel>((worst, report) => LEVEL_RANK[report.level] > LEVEL_RANK[worst] ? report.level : worst, 'pass')
  const scores = reports.flatMap(item => item.score === undefined ? [] : [item.score])
  const checks = reports.flatMap(item => item.checks ?? [])
  const metrics: Record<string, number> = {}
  for (const item of reports) {
    for (const [key, value] of Object.entries(item.metrics ?? {})) metrics[key] = Math.max(metrics[key] ?? value, value)
  }
  const report: InstallGateReport = {
    digest: createHash('sha256').update(reports.map(item => item.digest).join('\n')).digest('hex'),
    spec: first.report.spec,
    ...first.report.packageName === undefined ? {} : { packageName: first.report.packageName },
    ...first.report.version === undefined ? {} : { version: first.report.version },
    level,
    ...scores.length === 0 ? {} : { score: Math.min(...scores) },
    reasons: reports.flatMap(item => item.reasons),
    ...checks.length === 0 ? {} : { checks },
    findings: reports.flatMap(item => item.findings).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    omittedFindings: reports.reduce((sum, item) => sum + item.omittedFindings, 0),
    ...Object.keys(metrics).length === 0 ? {} : { metrics },
    gates: reports.flatMap(item => item.gates),
    checkedAt: reports.map(item => item.checkedAt).sort().at(-1) ?? first.report.checkedAt,
  }
  return {
    report,
    verifyInstalled: async dir => (await Promise.all(verdicts.map(verdict => verdict.verifyInstalled(dir)))).every(Boolean),
    dispose: async () => { await Promise.all(verdicts.map(verdict => verdict.dispose())) },
  }
}

/**
 * Whether a profile's own patch sets `requireInstallGate: true` on its `plugin-manager` row. Processes that cannot run
 * install gates, such as the `dsh plugin` command, refuse package additions for such a profile.
 * @param profileDir Profile directory.
 * @returns True when the profile patch requires an install gate.
 */
export function profileRequiresInstallGate(profileDir: string): boolean {
  const path = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(path)) return false
  for (const document of parseAllDocuments(readFileSync(path, 'utf8'), { logLevel: 'silent' })) {
    if (!('contents' in document)) continue
    // `!!js` scalars read as strings; only a literal `true` requires a gate.
    const rows: unknown = document.toJS({ maxAliasCount: 0 })
    if (!Array.isArray(rows)) continue
    for (const row of rows as unknown[]) {
      if (typeof row !== 'object' || row === null || !('id' in row) || row.id !== 'plugin-manager' || !('config' in row)) continue
      const config = row.config
      if (typeof config === 'object' && config !== null && 'requireInstallGate' in config && config.requireInstallGate === true) return true
    }
  }
  return false
}

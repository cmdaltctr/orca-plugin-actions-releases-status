// Reads the facts `classify` needs. All network and process access goes through `Io`,
// so tests can stand in for GitHub, npm and the updater.
import { execFile } from 'node:child_process'
import { parseRepo, RELEASE_BRANCH, type ProjectDef } from './projects'
import { ACTION_RUNS, type Facts, type ReleasePr, type Run } from './status'

export interface Io {
  ghJson(args: string[]): Promise<unknown>
  ghText(args: string[]): Promise<string>
  getJson(url: string): Promise<unknown>
  /** `owner/name` of the checkout's `origin` remote when it is on GitHub, else null. */
  repoOf(path: string): Promise<string | null>
  /** Folder of the workspace that owns one of these terminals, or null when Orca's CLI cannot say. */
  workspacePathOf(terminalIds: string[]): Promise<string | null>
}

// Orca can start with a short PATH, so add the usual Homebrew locations for `gh` and Orca's own CLI folder.
const PATH = `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin:/Applications/Orca.app/Contents/Resources/bin`

function exec(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env: { ...process.env, PATH }, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim().split('\n')[0]))
          return
        }
        resolve(stdout)
      }
    )
  })
}

const ghText = (args: string[]): Promise<string> => exec('gh', args)

export const realIo: Io = {
  ghText,
  ghJson: async (args) => JSON.parse(await ghText(args)),
  workspacePathOf: async (terminalIds) => {
    try {
      const out = JSON.parse(await exec(process.env.ORCA_CLI_COMMAND || 'orca', ['terminal', 'list', '--json'])) as {
        result?: { terminals?: TerminalRow[] }
      }
      return out.result?.terminals?.find((t) => terminalIds.includes(t.handle))?.worktreePath ?? null
    } catch {
      return null
    }
  },
  repoOf: async (path) => {
    try {
      return parseRepo(await exec('git', ['-C', path, 'remote', 'get-url', 'origin']))
    } catch {
      return null
    }
  },
  getJson: async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) {
      throw new Error(`${url} answered ${response.status}`)
    }
    return response.json()
  }
}

/** One row of `orca terminal list --json`. */
interface TerminalRow {
  handle: string
  worktreePath?: string
}

interface RawRun {
  databaseId: number
  workflowName: string
  status: string
  conclusion: string | null
  url: string
  displayTitle: string
}

interface RawCheck {
  status?: string
  conclusion?: string | null
  state?: string
}

interface RawPr {
  number: number
  url: string
  headRefName: string
  statusCheckRollup: RawCheck[]
}

const fromRaw = (raw: RawRun): Run => ({
  id: raw.databaseId,
  status: raw.status.toLowerCase(),
  conclusion: raw.conclusion?.toLowerCase() || null,
  url: raw.url,
  title: raw.displayTitle,
  workflow: raw.workflowName
})

const toRun = (raw: RawRun | undefined): Run | null => (raw ? fromRaw(raw) : null)

const BAD = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'error'])

/** Check runs report `status` and `conclusion`; commit statuses report `state`. */
export function checksOf(rollup: RawCheck[]): ReleasePr['checks'] {
  const words = rollup.map((c) => ({
    done: c.status ? c.status.toLowerCase() === 'completed' : !['pending', 'expected'].includes((c.state ?? '').toLowerCase()),
    result: (c.conclusion ?? c.state ?? '').toLowerCase()
  }))
  if (words.some((w) => w.done && BAD.has(w.result))) {
    return 'failed'
  }
  return words.some((w) => !w.done) ? 'pending' : 'passed'
}

async function releasePr(def: ProjectDef, io: Io): Promise<ReleasePr | null> {
  if (!def.releasePrBranch) {
    return null
  }
  const prs = (await io.ghJson([
    'pr', 'list', '-R', def.repo, '--state', 'open', '--limit', '20',
    '--json', 'number,url,headRefName,statusCheckRollup'
  ])) as RawPr[]
  const pr = prs.find((p) => p.headRefName.startsWith(def.releasePrBranch ?? ''))
  return pr ? { number: pr.number, url: pr.url, checks: checksOf(pr.statusCheckRollup) } : null
}

async function newestRelease(def: ProjectDef, io: Io): Promise<Facts['release']> {
  const [latest] = (await io.ghJson([
    'release', 'list', '-R', def.repo, '--limit', '1', '--exclude-drafts', '--json', 'tagName'
  ])) as { tagName: string }[]
  if (!latest) {
    return null
  }
  const url = `https://github.com/${def.repo}/releases/tag/${latest.tagName}`
  if (def.kind !== 'semantic-release-desktop') {
    return { tag: latest.tagName, url, assets: [] }
  }
  const view = (await io.ghJson(['release', 'view', latest.tagName, '-R', def.repo, '--json', 'assets'])) as {
    assets: { name: string }[]
  }
  return { tag: latest.tagName, url, assets: view.assets.map((a) => a.name) }
}

const listRuns = (repo: string, branch: string, limit: number, io: Io): Promise<RawRun[]> =>
  io.ghJson([
    'run', 'list', '-R', repo, '--branch', branch, '--limit', String(limit),
    '--json', 'databaseId,workflowName,status,conclusion,url,displayTitle'
  ]) as Promise<RawRun[]>

/** The repository's default branch, or null when GitHub does not say. */
export async function defaultBranch(repo: string, io: Io): Promise<string | null> {
  try {
    const view = (await io.ghJson(['repo', 'view', repo, '--json', 'defaultBranchRef'])) as {
      defaultBranchRef?: { name?: string } | null
    }
    return view.defaultBranchRef?.name || null
  } catch {
    return null
  }
}

/** `branch` is the branch whose runs are listed. The release stages always read the release branch. */
export async function gatherFacts(def: ProjectDef, branch: string, io: Io): Promise<Facts> {
  // 100 runs, so busy CI runs on the release branch do not push the release runs out of the window.
  const releaseRuns = def.kind ? listRuns(def.repo, RELEASE_BRANCH, 100, io) : Promise.resolve([] as RawRun[])
  const [runs, branchRuns, release, pr, npm, updater] = await Promise.all([
    releaseRuns,
    def.kind && branch === RELEASE_BRANCH ? releaseRuns : listRuns(def.repo, branch, ACTION_RUNS, io),
    def.kind ? newestRelease(def, io) : null,
    releasePr(def, io),
    def.npmPackage
      ? (io.getJson(`https://registry.npmjs.org/-/package/${def.npmPackage}/dist-tags`) as Promise<{ latest?: string }>)
      : null,
    def.updaterUrl ? (io.getJson(def.updaterUrl) as Promise<{ version?: string }>) : null
  ])
  return {
    pr,
    // `gh run list` is newest first.
    releaseRun: toRun(runs.find((r) => r.workflowName === 'Release')),
    finalizeRun: toRun(runs.find((r) => r.workflowName === 'Finalize Desktop Release')),
    runs: branchRuns.slice(0, ACTION_RUNS).map(fromRaw),
    release,
    npmLatest: npm?.latest ?? null,
    updaterVersion: updater?.version ?? null
  }
}

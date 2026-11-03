// Reads the facts `classify` needs. All network and process access goes through `Io`,
// so tests can stand in for GitHub, npm and the updater.
import { execFile } from 'node:child_process'
import { parseRepo, RELEASE_BRANCH, type DetectedFlow, type ProjectDef } from './projects'
import type { Check, Facts, ReleasePr, Run } from './status'

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
  headSha: string
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
  if (def.kind !== 'release-workflow-desktop') {
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
    '--json', 'databaseId,workflowName,status,conclusion,url,displayTitle,headSha'
  ]) as Promise<RawRun[]>

async function npmPackageOf(repo: string, io: Io): Promise<string | null> {
  try {
    const file = (await io.ghJson(['api', `repos/${repo}/contents/package.json`])) as { content?: string }
    const manifest = JSON.parse(Buffer.from(file.content ?? '', 'base64').toString('utf8')) as { name?: string; private?: boolean }
    return manifest.private ? null : (manifest.name ?? null)
  } catch {
    return null
  }
}

/**
 * Looks at the repository on GitHub for its release flow; null when it has none.
 * Throws when GitHub cannot be read, so the caller does not remember a wrong answer.
 */
export async function detectFlow(repo: string, io: Io): Promise<DetectedFlow | null> {
  const [files, workflows] = await Promise.all([
    io.ghJson(['api', `repos/${repo}/contents`]) as Promise<{ name: string }[]>,
    io.ghJson(['api', `repos/${repo}/actions/workflows?per_page=100`]) as Promise<{ workflows: { name: string }[] }>
  ])
  const names = new Set(files.map((file) => file.name))
  if (names.has('release-please-config.json') || names.has('.release-please-manifest.json')) {
    const npmPackage = names.has('package.json') ? await npmPackageOf(repo, io) : null
    return npmPackage ? { kind: 'release-please-npm', npmPackage } : { kind: 'release-please' }
  }
  return workflows.workflows.some((workflow) => workflow.name === 'Release') ? { kind: 'release-workflow' } : null
}

interface RawCheckRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  html_url: string
  details_url?: string | null
}

/** The checks of one commit: workflow jobs and outside checks such as Codecov. A failed read shows none. */
async function checksOfCommit(repo: string, sha: string, io: Io): Promise<Check[]> {
  try {
    const answer = (await io.ghJson(['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`])) as {
      check_runs: RawCheckRun[]
    }
    return answer.check_runs.map((raw) => ({
      id: raw.id,
      name: raw.name,
      status: raw.status.toLowerCase(),
      conclusion: raw.conclusion?.toLowerCase() || null,
      url: raw.html_url,
      runId: Number(/\/actions\/runs\/(\d+)/.exec(raw.details_url ?? raw.html_url)?.[1]) || null
    }))
  } catch {
    return []
  }
}

interface RawJob {
  databaseId: number
  name: string
  status: string
  conclusion: string | null
  url: string
}

/** The jobs of one workflow run. A failed read shows none. */
async function jobsOfRun(repo: string, run: Run, io: Io): Promise<Check[]> {
  try {
    const view = (await io.ghJson(['run', 'view', String(run.id), '-R', repo, '--json', 'jobs'])) as { jobs: RawJob[] }
    return view.jobs.map((job) => ({
      id: job.databaseId,
      name: job.name,
      status: job.status.toLowerCase(),
      conclusion: job.conclusion?.toLowerCase() || null,
      url: job.url,
      runId: run.id
    }))
  } catch {
    return []
  }
}

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

/** `branch` is the branch whose checks are listed. The release stages always read the release branch. */
export async function gatherFacts(def: ProjectDef, branch: string, io: Io): Promise<Facts> {
  // 100 runs, so busy CI runs on the release branch do not push the release runs out of the window.
  const releaseRuns = def.kind ? listRuns(def.repo, RELEASE_BRANCH, 100, io) : Promise.resolve([] as RawRun[])
  // Only the newest run is needed from another branch: its commit names the checks to show.
  const branchRuns = def.kind && branch === RELEASE_BRANCH ? releaseRuns : listRuns(def.repo, branch, 1, io)
  const [runs, checks, release, pr, npm, updater] = await Promise.all([
    releaseRuns,
    branchRuns.then((newest) => (newest[0] ? checksOfCommit(def.repo, newest[0].headSha, io) : [])),
    def.kind ? newestRelease(def, io) : null,
    releasePr(def, io),
    def.npmPackage
      ? (io.getJson(`https://registry.npmjs.org/-/package/${def.npmPackage}/dist-tags`) as Promise<{ latest?: string }>)
      : null,
    def.updaterUrl ? (io.getJson(def.updaterUrl) as Promise<{ version?: string }>) : null
  ])
  // A release run that passed needs no job list. One that has not passed shows what failed.
  const unfinished = [
    { label: 'Release run', run: toRun(runs.find((r) => r.workflowName === 'Release')) },
    ...(def.kind === 'release-workflow-desktop'
      ? [{ label: 'Finalize run', run: toRun(runs.find((r) => r.workflowName === 'Finalize Desktop Release')) }]
      : [])
  ].filter((entry): entry is { label: string; run: Run } => entry.run !== null && entry.run.conclusion !== 'success')
  const jobGroups = await Promise.all(
    unfinished.map(async ({ label, run }) => ({ label, run, jobs: await jobsOfRun(def.repo, run, io) }))
  )
  return {
    pr,
    // `gh run list` is newest first.
    releaseRun: toRun(runs.find((r) => r.workflowName === 'Release')),
    finalizeRun: toRun(runs.find((r) => r.workflowName === 'Finalize Desktop Release')),
    checks,
    jobGroups,
    release,
    npmLatest: npm?.latest ?? null,
    updaterVersion: updater?.version ?? null
  }
}

// Pure: turns what GitHub, npm and the updater said into stages and one overall state.
import type { ProjectDef } from './projects'
import type { Overall, ProjectStatus, RunRow, RunState, Stage, StageState } from './protocol'

export interface Run {
  id: number
  /** `queued`, `in_progress` or `completed`. */
  status: string
  conclusion: string | null
  url: string
  title: string
  workflow: string
}

export interface ReleasePr {
  number: number
  url: string
  checks: 'pending' | 'failed' | 'passed'
}

export interface Facts {
  /** Open release-please PR. */
  pr: ReleasePr | null
  /** Newest "Release" run on main. */
  releaseRun: Run | null
  /** Newest "Finalize Desktop Release" run on main. */
  finalizeRun: Run | null
  /** Every workflow's newest runs on the viewed branch, newest first. */
  runs: Run[]
  /** Newest published GitHub release. */
  release: { tag: string; url: string; assets: string[] } | null
  npmLatest: string | null
  updaterVersion: string | null
}

/** How many runs the panel lists per project. */
export const ACTION_RUNS = 12

const FAILED = new Set(['failure', 'timed_out'])

function runState(run: Run): RunState {
  if (run.status !== 'completed') {
    return 'running'
  }
  if (run.conclusion === 'success') {
    return 'passed'
  }
  return FAILED.has(run.conclusion ?? '') ? 'failed' : 'idle'
}

const runRow = (run: Run): RunRow => ({
  id: run.id,
  workflow: run.workflow,
  title: run.title,
  state: runState(run),
  rerunnable: runState(run) === 'failed',
  url: run.url
})

const bare = (tag: string): string => tag.replace(/^v/, '')

function runStage(id: string, label: string, run: Run | null): Stage {
  if (!run) {
    return { id, label, state: 'idle', detail: 'No run yet' }
  }
  const base = { id, label, url: run.url }
  if (run.status !== 'completed') {
    return { ...base, state: 'running', detail: `Running: ${run.title}` }
  }
  if (run.conclusion === 'success') {
    return { ...base, state: 'done', detail: 'Passed' }
  }
  if (run.conclusion === 'cancelled' || run.conclusion === 'skipped') {
    return { ...base, state: 'idle', detail: `${run.conclusion}: ${run.title}` }
  }
  return { ...base, state: 'failed', detail: `Failed (${run.conclusion ?? 'unknown'}): ${run.title}` }
}

function prStage(pr: ReleasePr | null): Stage {
  const label = 'Release PR'
  if (!pr) {
    return { id: 'pr', label, state: 'idle', detail: 'No release PR open' }
  }
  const base = { id: 'pr', label, url: pr.url }
  if (pr.checks === 'failed') {
    return { ...base, state: 'failed', detail: `#${pr.number}: checks failing` }
  }
  if (pr.checks === 'pending') {
    return { ...base, state: 'running', detail: `#${pr.number}: checks running` }
  }
  return { ...base, state: 'running', detail: `#${pr.number}: checks green, waiting for auto-merge` }
}

function npmStage(def: ProjectDef, f: Facts): Stage {
  const label = 'npm'
  const url = `https://www.npmjs.com/package/${def.npmPackage}`
  if (!f.release || !f.npmLatest) {
    return { id: 'npm', label, state: 'idle', detail: 'Not looked up', url }
  }
  const tag = bare(f.release.tag)
  if (tag === f.npmLatest) {
    return { id: 'npm', label, state: 'done', detail: `latest is ${tag}`, url }
  }
  if (f.releaseRun && f.releaseRun.status !== 'completed') {
    return { id: 'npm', label, state: 'running', detail: `Publishing ${tag} (latest is ${f.npmLatest})`, url }
  }
  if (f.releaseRun?.conclusion === 'success') {
    return {
      id: 'npm',
      label,
      state: 'blocked',
      detail: `${tag} is released but npm latest is ${f.npmLatest}. If staged, approve it: bun run release:approve`,
      url
    }
  }
  return { id: 'npm', label, state: 'idle', detail: `${tag} is not on npm yet (latest is ${f.npmLatest})`, url }
}

function githubReleaseStage(f: Facts): Stage {
  if (!f.release) {
    return { id: 'release', label: 'GitHub release', state: 'idle', detail: 'No release yet' }
  }
  return { id: 'release', label: 'GitHub release', state: 'done', detail: f.release.tag, url: f.release.url }
}

const isBinary = (name: string): boolean => name.endsWith('.dmg') || name.endsWith('.app.tar.gz')

function updaterStage(f: Facts): Stage {
  const label = 'Updater'
  if (!f.release || !f.updaterVersion) {
    return { id: 'updater', label, state: 'idle', detail: 'Not looked up' }
  }
  const tag = bare(f.release.tag)
  if (!f.release.assets.some(isBinary)) {
    return { id: 'updater', label, state: 'idle', detail: `No native build for v${tag}. Updater serves v${f.updaterVersion}` }
  }
  if (tag === f.updaterVersion) {
    return { id: 'updater', label, state: 'done', detail: `Serves v${tag}` }
  }
  if (f.finalizeRun && f.finalizeRun.status !== 'completed') {
    return { id: 'updater', label, state: 'running', detail: `Finalising v${tag}`, url: f.finalizeRun.url }
  }
  if (f.finalizeRun?.conclusion && f.finalizeRun.conclusion !== 'success') {
    return { id: 'updater', label, state: 'failed', detail: `Finalise failed. Updater serves v${f.updaterVersion}`, url: f.finalizeRun.url }
  }
  return {
    id: 'updater',
    label,
    state: 'blocked',
    detail: `v${tag} binary is on GitHub but the updater serves v${f.updaterVersion}. Run: npm run desktop:release -- --tag v${tag} --finalize-only`
  }
}

function stagesFor(def: ProjectDef, f: Facts): Stage[] {
  switch (def.kind) {
    case undefined:
      return []
    case 'release-please-npm':
      return [prStage(f.pr), runStage('run', 'Release run', f.releaseRun), npmStage(def, f)]
    case 'semantic-release':
      return [runStage('run', 'Release run', f.releaseRun), githubReleaseStage(f)]
    case 'semantic-release-desktop':
      return [runStage('run', 'Release run', f.releaseRun), githubReleaseStage(f), updaterStage(f)]
  }
}

/** Worst first: the project takes the state of its worst stage. */
const RANK: ('failed' | 'blocked' | 'running')[] = ['failed', 'blocked', 'running']

/** For a repository with no release flow: the newest run of each workflow decides. */
function actionsHealth(rows: RunRow[], branch: string): { overall: Overall; summary: string } {
  const newest = rows.filter((row, i) => rows.findIndex((other) => other.workflow === row.workflow) === i)
  const failed = newest.find((row) => row.state === 'failed')
  if (failed) {
    return { overall: 'failed', summary: `${failed.workflow} failed on ${branch}` }
  }
  const running = newest.find((row) => row.state === 'running')
  if (running) {
    return { overall: 'running', summary: `${running.workflow} is running on ${branch}` }
  }
  return { overall: 'ok', summary: rows.length > 0 ? `All workflows passing on ${branch}` : `No workflow runs on ${branch}` }
}

/** Where the panel is looking: the branch whose runs are listed, the branches it can switch to, and whether the focused workspace owns the project. */
export interface View {
  branch: string
  branches: string[]
  detected: boolean
}

export function classify(def: ProjectDef, f: Facts, view: View): ProjectStatus {
  const stages = stagesFor(def, f)
  const runs = f.runs.map(runRow)
  const worst: StageState | undefined = RANK.find((state) => stages.some((s) => s.state === state))
  const lead = worst ? stages.find((s) => s.state === worst) : undefined
  const actions = actionsHealth(runs, view.branch)
  const health: { overall: Overall; summary: string } = def.kind
    ? {
        overall: worst ?? 'ok',
        summary: lead ? `${lead.label}: ${lead.detail}` : f.release ? `Up to date at ${f.release.tag}` : 'Nothing released yet'
      }
    : actions
  return {
    id: def.id,
    name: def.name,
    detected: view.detected,
    flow: def.kind ? 'release' : 'actions',
    ...health,
    actions,
    stages,
    branch: view.branch,
    branches: view.branches,
    runs,
    ...(def.agentPrompt ? { agentPrompt: def.agentPrompt } : {})
  }
}

export function unknownStatus(def: ProjectDef, error: unknown, view: View): ProjectStatus {
  const message = error instanceof Error ? error.message : String(error)
  return {
    id: def.id,
    name: def.name,
    detected: view.detected,
    flow: def.kind ? 'release' : 'actions',
    overall: 'unknown',
    summary: `Lookup failed: ${message}`,
    actions: { overall: 'unknown', summary: `Lookup failed: ${message}` },
    stages: [],
    branch: view.branch,
    branches: view.branches,
    runs: []
  }
}

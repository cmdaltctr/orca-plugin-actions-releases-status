// Pure: turns what GitHub, npm and the updater said into stages and one overall state.
import type { ProjectDef } from './projects'
import type { BranchPr, CheckRow, Overall, PrState, ProjectStatus, RunJobs, RunState, Stage, StageState } from './protocol'

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

/** One check run of a commit, as GitHub reports it. */
export interface Check {
  id: number
  name: string
  /** `queued`, `in_progress` or `completed`. */
  status: string
  conclusion: string | null
  url: string
  /** The workflow run it belongs to, when it comes from GitHub Actions. */
  runId: number | null
}

export interface Facts {
  /** Open release-please PR. */
  pr: ReleasePr | null
  /** Newest "Release" run on main. */
  releaseRun: Run | null
  /** Newest "Finalize Desktop Release" run on main. */
  finalizeRun: Run | null
  /** Checks of the newest commit on the viewed branch. */
  checks: Check[]
  /** The pull request of the viewed branch. */
  branchPr: BranchPr | null
  /** Jobs of the release runs that have not passed. */
  jobGroups: { label: string; run: Run; jobs: Check[] }[]
  /** Newest published GitHub release. */
  release: { tag: string; url: string; assets: string[] } | null
  npmLatest: string | null
  updaterVersion: string | null
}

const FAILED = new Set(['failure', 'timed_out'])

function stateOf(status: string, conclusion: string | null): RunState {
  if (status !== 'completed') {
    return 'running'
  }
  if (conclusion === 'success') {
    return 'passed'
  }
  if (conclusion === 'cancelled') {
    return 'cancelled'
  }
  return FAILED.has(conclusion ?? '') ? 'failed' : 'idle'
}

const checkRow = (check: Check): CheckRow => {
  const state = stateOf(check.status, check.conclusion)
  return {
    id: check.id,
    name: check.name,
    state,
    runId: check.runId,
    rerunnable: (state === 'failed' || state === 'cancelled') && check.runId !== null,
    url: check.url
  }
}

const ORDER: Record<RunState, number> = { failed: 0, cancelled: 1, running: 2, passed: 3, idle: 4 }

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
    case 'release-please':
      return [prStage(f.pr), runStage('run', 'Release run', f.releaseRun), githubReleaseStage(f)]
    case 'release-workflow':
      return [runStage('run', 'Release run', f.releaseRun), githubReleaseStage(f)]
    case 'release-workflow-desktop':
      return [runStage('run', 'Release run', f.releaseRun), githubReleaseStage(f), updaterStage(f)]
  }
}

/** Worst first: the project takes the state of its worst stage. */
const RANK: ('failed' | 'blocked' | 'running')[] = ['failed', 'blocked', 'running']

/** The state of the newest commit's checks on the shown branch. */
function actionsHealth(rows: CheckRow[], branch: string): { overall: Overall; summary: string } {
  const failed = rows.find((row) => row.state === 'failed')
  if (failed) {
    return { overall: 'failed', summary: `${failed.name} failed on ${branch}` }
  }
  const running = rows.find((row) => row.state === 'running')
  if (running) {
    return { overall: 'running', summary: `${running.name} is running on ${branch}` }
  }
  return { overall: 'ok', summary: rows.length > 0 ? `All checks passing on ${branch}` : `No checks on ${branch}` }
}

const NO_FLOW = 'No release flow found. Looked for release-please files and a workflow named Release.'

function flowNote(def: ProjectDef): string {
  switch (def.kind) {
    case 'release-please-npm':
      return `release-please, npm package ${def.npmPackage}`
    case 'release-please':
      return 'release-please'
    case 'release-workflow':
      return 'A workflow named Release'
    case 'release-workflow-desktop':
      return 'Release workflow with an updater URL'
    case undefined:
      return NO_FLOW
  }
}

/** Where the panel is looking: the branch whose checks are listed, the branches it can switch to, and whether the focused workspace owns the project. */
export interface View {
  branch: string
  branches: string[]
  detected: boolean
  /** The user locked this branch, so it stays when focus moves to another project. */
  locked: boolean
  /** A card opened from the PRs tab. */
  opened?: boolean
}

/** What GitHub says about a worktree's pull request, with its checks already summed up by `checksOf`. */
export interface PrFacts {
  /** `OPEN`, `MERGED` or `CLOSED`. */
  state: string
  isDraft: boolean
  /** `MERGEABLE`, `CONFLICTING` or `UNKNOWN`. */
  mergeable: string
  checks: ReleasePr['checks']
}

/** The colour rule of the PRs tab. Reviews are not read. */
export function prState(pr: PrFacts): { state: PrState; reason: string } {
  const state = pr.state.toUpperCase()
  if (state === 'MERGED' || state === 'CLOSED') {
    return { state: state === 'MERGED' ? 'merged' : 'closed', reason: '' }
  }
  if (pr.checks === 'failed') {
    return { state: 'failed', reason: 'A check failed' }
  }
  if (pr.checks === 'pending') {
    return { state: 'running', reason: 'Checks running' }
  }
  if (pr.isDraft) {
    return { state: 'running', reason: 'Draft' }
  }
  if (pr.mergeable === 'CONFLICTING') {
    return { state: 'running', reason: 'Merge conflicts' }
  }
  return pr.mergeable === 'MERGEABLE'
    ? { state: 'ready', reason: '' }
    : { state: 'running', reason: 'GitHub is still checking if it can merge' }
}

export function classify(def: ProjectDef, f: Facts, view: View): ProjectStatus {
  const stages = stagesFor(def, f)
  const checks = f.checks.map(checkRow).sort((a, b) => ORDER[a.state] - ORDER[b.state])
  const releaseJobs: RunJobs[] = f.jobGroups.map((group) => ({
    label: group.label,
    title: group.run.title,
    url: group.run.url,
    jobs: group.jobs.map(checkRow).sort((a, b) => ORDER[a.state] - ORDER[b.state])
  }))
  const worst: StageState | undefined = RANK.find((state) => stages.some((s) => s.state === state))
  const lead = worst ? stages.find((s) => s.state === worst) : undefined
  const actions = actionsHealth(checks, view.branch)
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
    locked: view.locked,
    opened: view.opened === true,
    flow: def.kind ? 'release' : 'actions',
    flowNote: flowNote(def),
    settings: def.settings,
    ...health,
    actions,
    stages,
    releaseJobs,
    branch: view.branch,
    branches: view.branches,
    checks,
    branchPr: f.branchPr,
    ...(def.agentPrompt ? { agentPrompt: def.agentPrompt } : {})
  }
}

export function unknownStatus(def: ProjectDef, error: unknown, view: View): ProjectStatus {
  const message = error instanceof Error ? error.message : String(error)
  return {
    id: def.id,
    name: def.name,
    detected: view.detected,
    locked: view.locked,
    opened: view.opened === true,
    flow: def.kind ? 'release' : 'actions',
    flowNote: flowNote(def),
    settings: def.settings,
    overall: 'unknown',
    summary: `Lookup failed: ${message}`,
    actions: { overall: 'unknown', summary: `Lookup failed: ${message}` },
    stages: [],
    releaseJobs: [],
    branch: view.branch,
    branches: view.branches,
    checks: [],
    branchPr: null
  }
}

import { assert, test } from 'orca/testing'
import { checksOf } from './facts'
import { parseRepo, projectDef, settingsProblem, type DetectedFlow } from './projects'
import { classify, type Check, type Facts, type Run, type View } from './status'

const FLOWS: Record<string, [string, DetectedFlow | null, { agentPrompt: string; updaterUrl: string }]> = {
  npm: ['acme/widget', { kind: 'release-please-npm', npmPackage: 'widget-pkg' }, { agentPrompt: '/release-agent', updaterUrl: '' }],
  please: ['acme/plain', { kind: 'release-please' }, { agentPrompt: '', updaterUrl: '' }],
  workflow: ['acme/gadget', { kind: 'release-workflow' }, { agentPrompt: '', updaterUrl: '' }],
  desktop: [
    'acme/desktop',
    { kind: 'release-workflow' },
    { agentPrompt: '/release-desktop', updaterUrl: 'https://updates.example.com/desktop/latest.json' }
  ]
}
const def = (id: string) => {
  const flow = FLOWS[id]
  return flow ? projectDef(flow[0], flow[1], flow[2]) : projectDef(id, null)
}
const view: View = { branch: 'main', branches: ['main'], detected: true }
const run = (over: Partial<Run> = {}): Run => ({
  id: 7,
  status: 'completed',
  conclusion: 'success',
  url: 'https://github.com/x/y/actions/runs/7',
  title: 'Release',
  workflow: 'Release',
  ...over
})
const facts = (over: Partial<Facts> = {}): Facts => ({
  pr: null,
  releaseRun: run(),
  finalizeRun: null,
  checks: [],
  jobGroups: [],
  release: { tag: 'v5.2.0', url: 'https://github.com/x/y/releases/tag/v5.2.0', assets: [] },
  npmLatest: '5.2.0',
  updaterVersion: null,
  ...over
})

test('npm flow: is ok when npm latest matches the newest release', () => {
  const status = classify(def('npm'), facts(), view)
  assert.equal(status.overall, 'ok')
  assert.equal(status.summary, 'Up to date at v5.2.0')
})

test('npm flow: needs you when the release run passed but npm is behind', () => {
  const status = classify(def('npm'), facts({ release: { tag: 'v5.3.0', url: 'u', assets: [] } }), view)
  assert.equal(status.overall, 'blocked')
  assert.match(status.summary, /release:approve/)
})

test('npm flow: shows publishing while the release run is still going', () => {
  const status = classify(
    def('npm'),
    facts({ release: { tag: 'v5.3.0', url: 'u', assets: [] }, releaseRun: run({ status: 'in_progress', conclusion: null }) }),
    view
  )
  assert.equal(status.overall, 'running')
  assert.equal(status.stages.find((s) => s.id === 'npm')?.state, 'running')
})

test('npm flow: failed release run fails the project and offers the agent', () => {
  const status = classify(
    def('npm'),
    facts({ release: { tag: 'v5.3.0', url: 'u', assets: [] }, releaseRun: run({ conclusion: 'failure' }) }),
    view
  )
  assert.equal(status.overall, 'failed')
  assert.equal(status.agentPrompt, '/release-agent')
})

const check = (over: Partial<Check> = {}): Check => ({
  id: 1,
  name: 'test (ubuntu-latest)',
  status: 'completed',
  conclusion: 'success',
  url: 'https://github.com/x/y/actions/runs/70/job/1',
  runId: 70,
  ...over
})

test('checks list failed first, then cancelled, running, passed and skipped, and only failed or cancelled workflow checks re-run', () => {
  const checks = [
    check({ id: 1 }),
    check({ id: 2, status: 'in_progress', conclusion: null }),
    check({ id: 3, conclusion: 'failure' }),
    check({ id: 4, conclusion: 'skipped' }),
    check({ id: 5, conclusion: 'failure', runId: null, url: 'https://codecov.io/x' }),
    check({ id: 6, conclusion: 'cancelled' })
  ]
  const rows = classify(def('npm'), facts({ checks }), view).checks
  assert.deepEqual(
    rows.map((r) => [r.id, r.state, r.rerunnable]),
    [
      [3, 'failed', true],
      [5, 'failed', false],
      [6, 'cancelled', true],
      [2, 'running', false],
      [1, 'passed', false],
      [4, 'idle', false]
    ]
  )
})

test('npm flow: release PR: failing checks fail, pending run, green waits for auto-merge', () => {
  const stage = (checks: 'failed' | 'pending' | 'passed') =>
    classify(def('npm'), facts({ pr: { number: 9, url: 'u', checks } }), view).stages[0]
  assert.equal(stage('failed')?.state, 'failed')
  assert.equal(stage('pending')?.state, 'running')
  assert.match(stage('passed')?.detail ?? '', /auto-merge/)
})

const desktop = (over: Partial<Facts>) =>
  classify(
    def('desktop'),
    facts({
      release: { tag: 'v1.65.0', url: 'u', assets: ['Desktop_1.65.0_aarch64.dmg'] },
      updaterVersion: '1.65.0',
      npmLatest: null,
      ...over
    }),
    view
  )

test('desktop flow: is ok when the updater serves the newest tag', () => {
  assert.equal(desktop({}).overall, 'ok')
})

test('desktop flow: needs you when the binary is on GitHub but the updater is behind', () => {
  const status = desktop({ updaterVersion: '1.64.0' })
  assert.equal(status.overall, 'blocked')
  assert.match(status.summary, /--finalize-only/)
})

test('desktop flow: treats a tag without a binary as normal', () => {
  const status = desktop({
    release: { tag: 'v1.66.0', url: 'u', assets: [] },
    updaterVersion: '1.65.0'
  })
  assert.equal(status.overall, 'ok')
})

test('desktop flow: failed finalise run fails the project and its updater stage', () => {
  const failed = run({ id: 11, conclusion: 'failure', workflow: 'Finalize Desktop Release' })
  const status = desktop({ updaterVersion: '1.64.0', finalizeRun: failed })
  assert.equal(status.overall, 'failed')
  assert.equal(status.stages.find((stage) => stage.id === 'updater')?.state, 'failed')
})

test('release-workflow flow: reports its release run', () => {
  assert.equal(classify(def('workflow'), facts({ releaseRun: run({ conclusion: 'failure' }) }), view).overall, 'failed')
  assert.equal(classify(def('workflow'), facts(), view).overall, 'ok')
})

test('check rollup: failure beats pending, pending beats pass, skipped passes', () => {
  assert.equal(checksOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }]), 'pending')
  assert.equal(
    checksOf([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }]),
    'failed'
  )
  assert.equal(checksOf([{ status: 'COMPLETED', conclusion: 'SKIPPED' }]), 'passed')
  assert.equal(checksOf([{ state: 'PENDING' }]), 'pending')
  assert.equal(checksOf([{ state: 'FAILURE' }]), 'failed')
})

const actions = (checks: Check[], branch = 'v3') =>
  classify(def('someone/else'), facts({ checks, releaseRun: null, release: null, npmLatest: null }), { ...view, branch })

test('a repository with no release flow has no stages and is judged by its checks', () => {
  const status = actions([check({ id: 3 }), check({ id: 2, name: 'Lint', conclusion: 'failure' })])
  assert.equal(status.flow, 'actions')
  assert.deepEqual(status.stages, [])
  assert.equal(status.overall, 'failed')
  assert.equal(status.summary, 'Lint failed on v3')
  assert.equal(status.flowNote, 'No release flow found. Looked for release-please files and a workflow named Release.')
})

test('actions health: all passing is ok, running beats ok, no checks says so', () => {
  assert.equal(actions([check()]).summary, 'All checks passing on v3')
  assert.equal(actions([check(), check({ id: 2, status: 'in_progress', conclusion: null })]).overall, 'running')
  assert.equal(actions([]).summary, 'No checks on v3')
  assert.equal(actions([]).overall, 'ok')
})

test('a release-please repository without an npm package ends its stages at the GitHub release', () => {
  const status = classify(def('please'), facts({ pr: { number: 4, url: 'u', checks: 'passed' } }), view)
  assert.deepEqual(status.stages.map((stage) => stage.id), ['pr', 'run', 'release'])
  assert.equal(status.flowNote, 'release-please')
})

test('flow notes say how the flow was found', () => {
  assert.equal(classify(def('npm'), facts(), view).flowNote, 'release-please, npm package widget-pkg')
  assert.equal(classify(def('workflow'), facts(), view).flowNote, 'A workflow named Release')
  assert.equal(classify(def('desktop'), facts(), view).flowNote, 'Release workflow with an updater URL')
})

test('an updater URL turns a Release workflow or no flow into a desktop flow, and leaves release-please alone', () => {
  const url = { agentPrompt: '', updaterUrl: 'https://updates.example.com/x.json' }
  assert.equal(projectDef('a/b', { kind: 'release-workflow' }, url).kind, 'release-workflow-desktop')
  assert.equal(projectDef('a/b', null, url).kind, 'release-workflow-desktop')
  assert.equal(projectDef('a/b', { kind: 'release-please' }, url).kind, 'release-please')
  assert.equal(projectDef('a/b', { kind: 'release-workflow' }).kind, 'release-workflow')
  assert.equal(projectDef('a/b', null).kind, undefined)
})

test('saved settings are carried to the status, set or not', () => {
  const status = classify(def('npm'), facts(), view)
  assert.deepEqual(status.settings, { agentPrompt: '/release-agent', updaterUrl: '' })
  assert.equal(classify(def('someone/else'), facts(), view).agentPrompt, undefined)
})

test('settingsProblem accepts a slash command and an https URL, and names the problem otherwise', () => {
  assert.equal(settingsProblem({ agentPrompt: '', updaterUrl: '' }), null)
  assert.equal(settingsProblem({ agentPrompt: '/release-agent', updaterUrl: 'https://u.example.com/a.json' }), null)
  assert.match(settingsProblem({ agentPrompt: 'rm -rf /', updaterUrl: '' }) ?? '', /start with \//)
  assert.match(settingsProblem({ agentPrompt: '/a\n/b', updaterUrl: '' }) ?? '', /one line/)
  assert.match(settingsProblem({ agentPrompt: '', updaterUrl: 'http://u.example.com' }) ?? '', /https/)
  assert.match(settingsProblem({ agentPrompt: '', updaterUrl: 'not a url' }) ?? '', /https/)
})

test('parseRepo reads remotes and plain names and rejects the rest', () => {
  assert.equal(parseRepo('git@github.com:acme/widget.git'), 'acme/widget')
  assert.equal(parseRepo('https://github.com/acme/widget'), 'acme/widget')
  assert.equal(parseRepo('https://user@github.com/acme/widget.git\n'), 'acme/widget')
  assert.equal(parseRepo('ssh://git@github.com/acme/widget.git'), 'acme/widget')
  assert.equal(parseRepo('acme/widget'), 'acme/widget')
  assert.equal(parseRepo('https://gitlab.com/acme/widget.git'), null)
  assert.equal(parseRepo('https://github.com/acme/widget/pull/3'), null)
  assert.equal(parseRepo('--help/x'), null)
  assert.equal(parseRepo('widget'), null)
})

const releaseRun = run({ id: 41, conclusion: 'failure', title: 'Merge pull request #232' })

test('the jobs of a release run that did not pass are listed, failed and cancelled first, and can re-run', () => {
  const jobs = [
    check({ id: 1, name: 'publish', runId: 41 }),
    check({ id: 2, name: 'smoke-macos / macos-26', conclusion: 'cancelled', runId: 41 }),
    check({ id: 3, name: 'report-failure', conclusion: 'skipped', runId: 41 })
  ]
  const status = classify(def('npm'), facts({ releaseRun, jobGroups: [{ label: 'Release run', run: releaseRun, jobs }] }), view)
  assert.equal(status.releaseJobs.length, 1)
  assert.equal(status.releaseJobs[0]?.label, 'Release run')
  assert.equal(status.releaseJobs[0]?.title, 'Merge pull request #232')
  assert.deepEqual(
    status.releaseJobs[0]?.jobs.map((job) => [job.name, job.state, job.rerunnable]),
    [
      ['smoke-macos / macos-26', 'cancelled', true],
      ['publish', 'passed', false],
      ['report-failure', 'idle', false]
    ]
  )
})

test('a release project with no unfinished release run lists no jobs', () => {
  assert.deepEqual(classify(def('npm'), facts(), view).releaseJobs, [])
})

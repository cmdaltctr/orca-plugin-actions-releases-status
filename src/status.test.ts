import { assert, test } from 'orca/testing'
import { checksOf } from './facts'
import { parseRepo, projectDef, RELEASE_FLOWS } from './projects'
import { classify, type Facts, type Run, type View } from './status'

// Release flows for the tests only: the plugin ships with none.
RELEASE_FLOWS['acme/widget'] = {
  name: 'Widget',
  kind: 'release-please-npm',
  npmPackage: 'widget-pkg',
  releasePrBranch: 'release-please--branches--main--components--widget-pkg',
  agentPrompt: '/release-agent'
}
RELEASE_FLOWS['acme/gadget'] = { name: 'Gadget', kind: 'semantic-release' }
RELEASE_FLOWS['acme/desktop'] = {
  name: 'Desktop',
  kind: 'semantic-release-desktop',
  updaterUrl: 'https://updates.example.com/desktop/stable/darwin/aarch64/0.0.1',
  agentPrompt: '/release-desktop'
}

const REPOS: Record<string, string> = { npm: 'acme/widget', semantic: 'acme/gadget', desktop: 'acme/desktop' }
const def = (id: string) => projectDef(REPOS[id] ?? id)
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
  runs: [],
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

test('runs list keeps order and marks only failed runs as re-runnable', () => {
  const runs = [
    run({ id: 1, status: 'in_progress', conclusion: null }),
    run({ id: 2, conclusion: 'failure' }),
    run({ id: 3, conclusion: 'timed_out' }),
    run({ id: 4, conclusion: 'success' }),
    run({ id: 5, conclusion: 'cancelled' })
  ]
  const rows = classify(def('npm'), facts({ runs }), view).runs
  assert.deepEqual(
    rows.map((r) => [r.id, r.state, r.rerunnable]),
    [
      [1, 'running', false],
      [2, 'failed', true],
      [3, 'failed', true],
      [4, 'passed', false],
      [5, 'idle', false]
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

test('desktop flow: failed finalise run fails the project and shows its workflow', () => {
  const failed = run({ id: 11, conclusion: 'failure', workflow: 'Finalize Desktop Release' })
  const status = desktop({ updaterVersion: '1.64.0', finalizeRun: failed, runs: [failed] })
  assert.equal(status.overall, 'failed')
  assert.equal(status.runs[0]?.workflow, 'Finalize Desktop Release')
  assert.equal(status.runs[0]?.rerunnable, true)
})

test('semantic-release flow: reports its release run', () => {
  assert.equal(classify(def('semantic'), facts({ releaseRun: run({ conclusion: 'failure' }) }), view).overall, 'failed')
  assert.equal(classify(def('semantic'), facts(), view).overall, 'ok')
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

const actions = (runs: Run[], branch = 'v3') =>
  classify(def('someone/else'), facts({ runs, releaseRun: null, release: null, npmLatest: null }), { ...view, branch })

test('a repository with no release flow has no stages and is judged by the newest run of each workflow', () => {
  const status = actions([
    run({ id: 3, workflow: 'CI', conclusion: 'success' }),
    run({ id: 2, workflow: 'Lint', conclusion: 'failure' }),
    run({ id: 1, workflow: 'CI', conclusion: 'failure' })
  ])
  assert.equal(status.flow, 'actions')
  assert.deepEqual(status.stages, [])
  assert.equal(status.overall, 'failed')
  assert.equal(status.summary, 'Lint failed on v3')
})

test('an older failure is ignored once the same workflow passes again', () => {
  const status = actions([
    run({ id: 2, workflow: 'CI', conclusion: 'success' }),
    run({ id: 1, workflow: 'CI', conclusion: 'failure' })
  ])
  assert.equal(status.overall, 'ok')
  assert.equal(status.summary, 'All workflows passing on v3')
})

test('actions health: running beats ok, and no runs is ok', () => {
  assert.equal(actions([run({ status: 'in_progress', conclusion: null })]).overall, 'running')
  assert.equal(actions([]).summary, 'No workflow runs on v3')
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

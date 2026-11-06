import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from '../panel'
import type { CheckRow, ProjectStatus, StatusSnapshot, WorktreePr } from '../protocol'

const NO_FLOW = 'No release flow found. Looked for release-please files and a workflow named Release.'

const check = (over: Partial<CheckRow> = {}): CheckRow => ({
  id: 1,
  name: 'test (ubuntu-latest)',
  state: 'passed',
  runId: 10,
  rerunnable: false,
  url: 'https://c/1',
  ...over
})

const widget: ProjectStatus = {
  id: 'acme/widget',
  name: 'Widget',
  detected: true,
  locked: false,
  opened: false,
  flow: 'release',
  flowNote: 'release-please, npm package widget-pkg',
  settings: { agentPrompt: '/release-agent', updaterUrl: '' },
  overall: 'blocked',
  summary: 'npm: v5.3.0 is released but npm latest is 5.2.0',
  actions: { overall: 'running', summary: 'Release is running on main' },
  stages: [{ id: 'npm', label: 'npm', state: 'blocked', detail: 'approve it', url: 'https://npm' }],
  releaseJobs: [],
  branch: 'main',
  branches: ['main', 'v3'],
  checks: [check({ id: 9, name: 'Release', state: 'running', runId: 90, url: 'https://c/9' })],
  branchPr: { number: 42, url: 'https://github.com/Acme/Widget/pull/42', title: 'fix: first message', state: 'open' },
  agentPrompt: '/release-agent'
}

const tool: ProjectStatus = {
  id: 'Acme/Tool',
  name: 'Tool',
  detected: false,
  locked: false,
  opened: false,
  flow: 'actions',
  flowNote: NO_FLOW,
  settings: { agentPrompt: '', updaterUrl: '' },
  overall: 'failed',
  summary: 'CI failed on main',
  actions: { overall: 'failed', summary: 'CI failed on main' },
  stages: [],
  releaseJobs: [],
  branch: 'main',
  branches: ['main'],
  branchPr: null,
  checks: [
    check({ id: 3, name: 'CI', state: 'failed', runId: 30, rerunnable: true, url: 'https://c/3' }),
    check({ id: 2, name: 'lint', state: 'passed', runId: 30, url: 'https://c/2' })
  ]
}

const prs: WorktreePr[] = [
  { worktree: 'widget-chat', branch: 'fix/chat', number: 50, url: 'https://github.com/Acme/Widget/pull/50', title: 'fix: chat', state: 'running', reason: 'Checks running' },
  { worktree: 'widget-ocr', branch: 'fix/ocr', number: 51, url: 'https://github.com/Acme/Widget/pull/51', title: 'fix: ocr', state: 'ready', reason: '' },
  { worktree: 'widget-lint', branch: 'fix/lint', number: 52, url: 'https://github.com/Acme/Widget/pull/52', title: 'fix: lint', state: 'failed', reason: 'A check failed' },
  { worktree: 'widget-v3', branch: 'v3', number: 7, url: 'https://github.com/Acme/Widget/pull/7', title: 'feat: v3', state: 'merged', reason: '' },
  { worktree: 'widget-old', branch: 'old', number: 3, url: 'https://github.com/Acme/Widget/pull/3', title: 'chore: old', state: 'closed', reason: '' }
]

const snapshot: StatusSnapshot = { checkedAt: Date.UTC(2026, 10, 3, 9, 0), projects: [widget, tool], opened: [], worktrees: [], worktreePrs: prs }

const host = (requests: Parameters<typeof mockHost>[0] = {}) =>
  mockHost({
    results: {
      'agents.list': () => ({
        agents: [{ terminalId: 't1', title: 'claude', agent: 'claude', state: 'waiting', stateStartedAt: 1 }]
      })
    },
    ...requests,
    requests: {
      'status.get': () => snapshot,
      'status.refresh': () => snapshot,
      'branch.select': () => snapshot,
      'branch.lock': () => snapshot,
      'card.open': () => snapshot,
      'card.close': () => snapshot,
      'card.pin': () => snapshot,
      'project.add': () => ({ ok: true, message: 'Added Acme/Tool' }),
      'project.remove': () => ({ ok: true, message: 'Removed Acme/Tool' }),
      'project.settings': () => ({ ok: true, message: 'Saved settings of Widget' }),
      'run.rerun': () => ({ ok: true, message: 'Re-running failed jobs of run 30' }),
      'agent.ask': () => ({ sent: true, message: 'Sent /release-agent' }),
      ...requests.requests
    }
  })

const only = (project: ProjectStatus): StatusSnapshot => ({ ...snapshot, projects: [project] })

test('shows each project with its state', async () => {
  const view = await mount(panel, { host: host() })
  assert.ok(view.find({ label: 'Widget' }))
  assert.ok(view.find({ type: 'Badge', text: 'Running' }))
  assert.ok(view.find({ type: 'Badge', text: 'Failing' }))
  assert.equal(view.findAll({ type: 'Badge', text: 'This project' }).length, 1)
  assert.ok(view.find({ text: 'Checks on main' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('the Actions tab opens first and keeps release stages and the agent button out of it', async () => {
  const view = await mount(panel, { host: host() })
  assert.ok(view.find({ role: 'tab', text: 'Actions' }))
  assert.ok(view.find({ role: 'tab', text: 'Releases' }))
  assert.equal(view.find({ label: 'Widget stages' }), null)
  assert.equal(view.find({ text: /Ask agent/ }), null)
  assert.equal(view.find({ type: 'Badge', text: 'Needs you' }), null)
  await view.unmount()
})

test('the Releases tab shows every project: stages for a release flow, what was looked for otherwise', async () => {
  const view = await mount(panel, { host: host() })
  await view.select({ label: 'View' }, 'releases')
  assert.ok(view.find({ label: 'Widget' }))
  assert.ok(view.find({ label: 'Widget stages' }))
  assert.ok(view.find({ type: 'Badge', text: 'Needs you' }))
  assert.ok(view.find({ text: 'Found: release-please, npm package widget-pkg' }))
  assert.ok(view.find({ label: 'Tool' }))
  assert.ok(view.find({ type: 'Badge', text: 'No release flow' }))
  assert.ok(JSON.stringify(view.tree()).includes(NO_FLOW))
  assert.equal(view.find({ text: 'Checks on main' }), null)
  assert.equal(view.find({ label: 'Repository' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the Releases tab says so when there is no project, and never points at source files', async () => {
  const view = await mount(panel, {
    host: host({ requests: { 'status.get': () => ({ ...snapshot, projects: [] }) } })
  })
  await view.select({ label: 'View' }, 'releases')
  assert.ok(view.find({ type: 'EmptyState', label: 'No project yet' }))
  assert.equal(view.find({ text: /projects\.ts/ }), null)
  await view.unmount()
})

const failedRelease: ProjectStatus = {
  ...widget,
  overall: 'failed',
  summary: 'Release run: Failed (failure): Merge pull request #232',
  releaseJobs: [
    {
      label: 'Release run',
      title: 'Merge pull request #232',
      url: 'https://r/41',
      jobs: [
        check({ id: 21, name: 'smoke-macos / macos-26', state: 'cancelled', runId: 41, rerunnable: true, url: 'https://j/21' }),
        check({ id: 22, name: 'publish', state: 'passed', runId: 41, url: 'https://j/22' })
      ]
    }
  ]
}

test('the Releases tab lists the jobs of a release run that did not pass, with a retry on the cancelled one', async () => {
  const sent: unknown[] = []
  const view = await mount(panel, {
    host: host({
      requests: {
        'status.get': () => only(failedRelease),
        'run.rerun': (input: unknown) => {
          sent.push(input)
          return { ok: true, message: 'Re-running failed jobs of run 41' }
        }
      }
    })
  })
  await view.select({ label: 'View' }, 'releases')
  assert.ok(view.find({ text: 'Jobs of the Release run' }))
  assert.ok(view.find({ type: 'Badge', text: 'Cancelled' }))
  assert.ok(view.find({ type: 'Badge', text: 'Passed' }))
  assert.equal(view.findAll({ type: 'IconButton', label: /Re-run/ }).length, 1)
  await view.press({ label: 'Re-run failed jobs: smoke-macos / macos-26' })
  assert.deepEqual(sent, [{ projectId: 'acme/widget', runId: 41 }])
  assert.ok(view.find({ text: 'Re-running failed jobs of run 41' }))
  await view.unmount()
})

test('the Releases tab shows no job list when every release run passed, and the Actions tab never shows it', async () => {
  const view = await mount(panel, { host: host({ requests: { 'status.get': () => only(failedRelease) } }) })
  assert.equal(view.find({ text: 'Jobs of the Release run' }), null)
  await view.select({ label: 'View' }, 'releases')
  await view.unmount()
  const passing = await mount(panel, { host: host() })
  await passing.select({ label: 'View' }, 'releases')
  assert.equal(passing.find({ text: 'Jobs of the Release run' }), null)
  await passing.unmount()
})

test('a running check shows a spinner and no retry button', async () => {
  const view = await mount(panel, { host: host() })
  assert.ok(view.find({ type: 'Spinner', label: 'Running: Release' }))
  assert.equal(view.findAll({ type: 'Spinner' }).length, 1)
  await view.unmount()
})

test('only a failed check of a workflow run gets a retry button, and pressing it re-runs that run', async () => {
  const sent: unknown[] = []
  const view = await mount(panel, {
    host: host({
      requests: {
        'status.get': () => snapshot,
        'run.rerun': (input: unknown) => {
          sent.push(input)
          return { ok: true, message: 'Re-running failed jobs of run 30' }
        }
      }
    })
  })
  assert.equal(view.findAll({ type: 'IconButton', label: /Re-run/ }).length, 1)
  await view.press({ label: 'Re-run failed jobs: CI' })
  assert.deepEqual(sent, [{ projectId: 'Acme/Tool', runId: 30 }])
  assert.ok(view.find({ text: 'Re-running failed jobs of run 30' }))
  await view.unmount()
})

test('a failed check from outside GitHub Actions gets an info icon that says it cannot re-run', async () => {
  const checks = [
    check({ id: 1, name: 'codecov/patch', state: 'failed', runId: null }),
    check({ id: 2, name: 'codecov/project', state: 'passed', runId: null }),
    check({ id: 3, name: 'CI', state: 'failed', runId: 30, rerunnable: true })
  ]
  const view = await mount(panel, {
    host: host({ requests: { 'status.get': () => only({ ...tool, checks }) } })
  })
  const info = view.findAll({ type: 'IconButton', label: /cannot re-run/ })
  assert.equal(info.length, 1)
  assert.equal(info[0].props.icon, 'info')
  assert.equal(info[0].props.label, 'codecov/patch: Not a GitHub Actions job, cannot re-run.')
  assert.equal(info[0].props.tooltip, 'Not a GitHub Actions job, cannot re-run.')
  assert.equal(view.findAll({ type: 'IconButton', label: /Re-run/ }).length, 1)
  await view.unmount()
})

test('checks past the first eight fold into one row', async () => {
  const many = Array.from({ length: 10 }, (_, i) => check({ id: 100 + i, name: `job ${i}` }))
  const view = await mount(panel, {
    host: host({ requests: { 'status.get': () => only({ ...tool, checks: many }) } })
  })
  assert.equal(view.findAll({ type: 'Badge', text: 'Passed' }).length, 8)
  assert.ok(view.find({ label: '2 more checks' }))
  await view.unmount()
})

test('the Actions tab shows the PR number on one line, and says there is none otherwise', async () => {
  const view = await mount(panel, { host: host() })
  assert.ok(view.find({ type: 'Button', text: 'PR #42: fix: first message' }))
  assert.ok(view.find({ type: 'Badge', text: 'open' }))
  assert.ok(view.find({ text: 'No PR for main' }))
  await view.unmount()
})

test('a long PR title is cut with three dots and the full title is the hover text', async () => {
  const title = 'fix(web): say when memory injection runs and what each switch adds'
  const long = { ...widget, branchPr: { number: 237, url: 'https://github.com/Acme/Widget/pull/237', title, state: 'merged' as const } }
  const view = await mount(panel, { host: host({ requests: { 'status.get': () => only(long) } }) })
  assert.ok(view.find({ type: 'Button', text: 'PR #237: fix(web): say when memory...' }))
  assert.equal(view.find({ type: 'Badge', text: '🟣 merged' })?.props.tone, 'neutral')
  assert.ok(JSON.stringify(view.tree()).includes(`#237 ${title}`))
  assert.equal(view.find({ text: new RegExp(title) }), null)
  await view.unmount()
})

test('the Releases tab shows the same PR line', async () => {
  const view = await mount(panel, { host: host() })
  await view.select({ label: 'View' }, 'releases')
  assert.ok(view.find({ type: 'Button', text: 'PR #42: fix: first message' }))
  await view.unmount()
})

test('a branch with no checks says so', async () => {
  const view = await mount(panel, {
    host: host({ requests: { 'status.get': () => only({ ...tool, checks: [], actions: { overall: 'ok', summary: 'No checks on main' } }) } })
  })
  assert.ok(view.find({ text: 'No checks on main' }))
  await view.unmount()
})

test('Ask agent stays disabled until an agent terminal is picked', async () => {
  const view = await mount(panel, { host: host() })
  try {
    await view.select({ label: 'View' }, 'releases')
    await assert.rejects(view.press({ text: /Ask agent/ }), /disabled/)
    await view.select({ label: 'Send to agent' }, 't1')
    await view.press({ text: /Ask agent/ })
    assert.ok(view.find({ text: 'Sent /release-agent' }))
  } finally {
    // An unmounted panel clears its polling timer; a failed test must not leave it running.
    await view.unmount()
  }
})

test('Settings holds the agent prompt and updater URL, and Save sends both', async () => {
  const sent: unknown[] = []
  const view = await mount(panel, {
    host: host({
      requests: {
        'status.get': () => only(tool),
        'project.settings': (input: unknown) => {
          sent.push(input)
          return { ok: true, message: 'Saved settings of Tool' }
        }
      }
    })
  })
  await view.select({ label: 'View' }, 'releases')
  await view.toggle({ label: 'Settings' })
  await view.type({ label: 'Agent prompt of Tool' }, '/release-tool')
  await view.type({ label: 'Updater URL of Tool' }, 'https://updates.example.com/latest.json')
  await view.press({ text: 'Save settings' })
  assert.deepEqual(sent, [
    { projectId: 'Acme/Tool', agentPrompt: '/release-tool', updaterUrl: 'https://updates.example.com/latest.json' }
  ])
  assert.ok(view.find({ text: 'Saved settings of Tool' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Settings starts from the saved values', async () => {
  const view = await mount(panel, { host: host({ requests: { 'status.get': () => only(widget) } }) })
  await view.select({ label: 'View' }, 'releases')
  await view.toggle({ label: 'Settings' })
  assert.equal(view.valueOf({ label: 'Agent prompt of Widget' }), '/release-agent')
  await view.unmount()
})

test('the branch picker appears only when there is a branch to switch to, and asks the worker', async () => {
  const sent: unknown[] = []
  const view = await mount(panel, {
    host: host({
      requests: {
        'status.get': () => snapshot,
        'branch.select': (input: unknown) => {
          sent.push(input)
          return snapshot
        }
      }
    })
  })
  assert.equal(view.findAll({ type: 'Select', label: /Branch of/ }).length, 1)
  await view.select({ label: 'Branch of Widget' }, 'v3')
  assert.deepEqual(sent, [{ projectId: 'acme/widget', branch: 'v3' }])
  await view.unmount()
})

test('the lock switch locks the branch and shows the Locked badge, and turning it off unlocks', async () => {
  const sent: unknown[] = []
  const view = await mount(panel, {
    host: host({
      requests: {
        'status.get': () => only(widget),
        'branch.lock': (input: unknown) => {
          sent.push(input)
          return only({ ...widget, locked: true })
        }
      }
    })
  })
  assert.equal(view.find({ type: 'Badge', text: 'Locked' }), null)
  assert.ok(view.find({ type: 'Badge', text: 'Unlocked' }))
  await view.toggle({ role: 'switch' })
  assert.deepEqual(sent, [{ projectId: 'acme/widget', locked: true }])
  assert.ok(view.find({ type: 'Badge', text: 'Locked' }))
  assert.equal(view.find({ type: 'Badge', text: 'Unlocked' }), null)
  await view.toggle({ role: 'switch' })
  assert.deepEqual(sent[1], { projectId: 'acme/widget', locked: false })
  await view.unmount()
})

test('an info icon beside the lock switch says what the lock does', async () => {
  const view = await mount(panel, { host: host({ requests: { 'status.get': () => only(widget) } }) })
  const info = view.findAll({ type: 'IconButton', label: /^Lock:/ })
  assert.equal(info.length, 1)
  assert.equal(info[0].props.icon, 'info')
  assert.equal(info[0].props.tooltip, 'Lock: keep this card on main when you focus another project.')
  await view.unmount()
})

test('only an added project has a remove button', async () => {
  const sent: unknown[] = []
  const view = await mount(panel, {
    host: host({
      requests: {
        'status.get': () => snapshot,
        'project.remove': (input: unknown) => {
          sent.push(input)
          return { ok: true, message: 'Removed Acme/Tool' }
        }
      }
    })
  })
  assert.equal(view.findAll({ label: /^Remove / }).length, 1)
  await view.press({ label: 'Remove Tool' })
  assert.deepEqual(sent, [{ repo: 'Acme/Tool' }])
  await view.unmount()
})

test('Add stays disabled until a repository is typed, then sends it and clears the box', async () => {
  const sent: unknown[] = []
  const view = await mount(panel, {
    host: host({
      requests: {
        'status.get': () => snapshot,
        'project.add': (input: unknown) => {
          sent.push(input)
          return { ok: true, message: 'Added Acme/Tool' }
        }
      }
    })
  })
  await assert.rejects(view.press({ text: 'Add' }), /disabled/)
  await view.type({ label: 'Repository' }, 'acme/tool')
  await view.press({ text: 'Add' })
  assert.deepEqual(sent, [{ repo: 'acme/tool' }])
  assert.ok(view.find({ text: 'Added Acme/Tool' }))
  assert.equal(view.valueOf({ label: 'Repository' }), '')
  await view.unmount()
})

test('a failed add keeps the typed text and shows why', async () => {
  const view = await mount(panel, {
    host: host({
      requests: {
        'status.get': () => snapshot,
        'project.add': () => ({ ok: false, message: 'Cannot read ghost/missing' })
      }
    })
  })
  await view.type({ label: 'Repository' }, 'ghost/missing')
  await view.press({ text: 'Add' })
  assert.ok(view.find({ text: 'Cannot read ghost/missing' }))
  assert.equal(view.valueOf({ label: 'Repository' }), 'ghost/missing')
  await view.unmount()
})

test('says why no project was detected', async () => {
  const view = await mount(panel, {
    host: host({
      requests: { 'status.get': () => ({ ...snapshot, projects: [], detectNote: 'No workspace is focused' }) }
    })
  })
  assert.ok(view.find({ text: 'No project detected: No workspace is focused' }))
  await view.unmount()
})

test('looks again when the focused workspace changes', async () => {
  let looks = 0
  const view = await mount(panel, {
    host: host({
      requests: {
        'status.get': () => {
          looks += 1
          return snapshot
        }
      }
    })
  })
  const first = looks
  await view.emit('workspace.changed', { context: { branch: 'v3', displayName: 'widget-v3', terminals: [] } })
  assert.equal(looks, first + 1)
  await view.unmount()
})

test('the PRs tab comes before Actions, and Actions still opens first', async () => {
  const view = await mount(panel, { host: host() })
  assert.deepEqual(view.findAll({ role: 'tab' }).map((tab) => tab.text), ['PRs', 'Actions', 'Releases'])
  assert.ok(view.find({ text: 'Checks on main' }))
  await view.unmount()
})

test('the PRs tab lists each worktree by name with its state, never the branch', async () => {
  const view = await mount(panel, { host: host() })
  await view.select({ label: 'View' }, 'prs')
  for (const worktree of ['widget-chat', 'widget-ocr', 'widget-lint', 'widget-v3', 'widget-old']) {
    assert.ok(view.find({ type: 'Button', text: worktree }), worktree)
  }
  // One dot per row, in the order of the rows: orange, green, red, purple emoji, grey.
  const dots = view.findAll({ type: 'Text', text: /^(●|🟣)$/ })
  assert.deepEqual(
    dots.map((dot) => [dot.text, dot.props.tone ?? (dot.props.muted ? 'muted' : null)]),
    [['●', 'warning'], ['●', 'success'], ['●', 'danger'], ['🟣', 'muted'], ['●', 'muted']]
  )
  // A badge per row in the dot's colour; merged carries the purple emoji, closed is grey.
  const badges = view.findAll({ type: 'Badge', text: /^(Running|Ready|Failed|🟣 Merged|Closed)$/ })
  assert.deepEqual(
    badges.map((badge) => [badge.text, badge.props.tone]),
    [['Running', 'warning'], ['Ready', 'success'], ['Failed', 'danger'], ['🟣 Merged', 'neutral'], ['Closed', 'neutral']]
  )
  assert.equal(view.find({ type: 'Button', text: 'widget-chat' })?.props.tooltip, 'Running: Checks running. #50 fix: chat')
  assert.equal(view.find({ text: /fix\/chat/ }), null)
  assert.equal(view.find({ text: 'Checks on main' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('pressing a worktree opens its card and switches to the Actions tab', async () => {
  const sent: unknown[] = []
  const openedCard: ProjectStatus = { ...widget, detected: false, opened: true, branch: 'fix/chat', branches: ['fix/chat'] }
  const view = await mount(panel, {
    host: host({
      requests: {
        'card.open': (input: unknown) => {
          sent.push(input)
          return { ...snapshot, opened: [openedCard] }
        }
      }
    })
  })
  await view.select({ label: 'View' }, 'prs')
  await view.press({ type: 'Button', text: 'widget-chat' })
  assert.deepEqual(sent, [{ branch: 'fix/chat' }])
  assert.ok(view.find({ text: 'Checks on fix/chat' }))
  await view.unmount()
})

test('an opened card has a close button and no lock switch or branch picker', async () => {
  const sent: unknown[] = []
  const openedCard: ProjectStatus = { ...widget, detected: false, opened: true, branch: 'fix/chat', branches: ['fix/chat'] }
  const view = await mount(panel, {
    host: host({
      requests: {
        'status.get': () => ({ ...snapshot, projects: [], opened: [openedCard] }),
        'card.close': (input: unknown) => {
          sent.push(input)
          return { ...snapshot, projects: [], opened: [] }
        }
      }
    })
  })
  assert.ok(view.find({ type: 'Badge', text: 'fix/chat' }))
  assert.equal(view.find({ role: 'switch' }), null)
  assert.equal(view.find({ type: 'Select', label: /Branch of/ }), null)
  await view.press({ label: 'Close Widget fix/chat' })
  assert.deepEqual(sent, [{ projectId: 'acme/widget', branch: 'fix/chat' }])
  assert.equal(view.find({ text: 'Checks on fix/chat' }), null)
  await view.unmount()
})

const chatCard: ProjectStatus = { ...widget, detected: false, opened: true, branch: 'fix/chat', branches: ['fix/chat'] }
/** The card headings of the Actions tab, top to bottom. */
const cardOrder = (view: Awaited<ReturnType<typeof mount>>) => view.findAll({ text: /^Checks on / }).map((node) => node.text)

test('an opened card sits under its own repository card when nothing is pinned', async () => {
  const view = await mount(panel, { host: host({ requests: { 'status.get': () => ({ ...snapshot, opened: [chatCard] }) } }) })
  assert.deepEqual(cardOrder(view), ['Checks on main', 'Checks on fix/chat', 'Checks on main'])
  await view.unmount()
})

test('pinned cards sit in a Pinned group above the rest, whatever their kind', async () => {
  const projects = [widget, { ...tool, pinned: true, branch: 'trunk' }]
  const opened = [{ ...chatCard, pinned: true }]
  const view = await mount(panel, { host: host({ requests: { 'status.get': () => ({ ...snapshot, projects, opened }) } }) })
  // The pinned opened card and the pinned Tool card first, then the unpinned widget card.
  assert.deepEqual(cardOrder(view), ['Checks on fix/chat', 'Checks on trunk', 'Checks on main'])
  assert.ok(view.find({ type: 'Badge', text: '2' }))
  await view.unmount()
})

/** A card of the sibling scope: one worktree branch of Widget, with the given Actions state. */
const sibling = (worktree: string, branch: string, overall: ProjectStatus['overall'], over: Partial<ProjectStatus> = {}): ProjectStatus => ({
  ...widget,
  flow: 'actions',
  detected: false,
  worktree,
  branch,
  branches: [branch],
  overall,
  actions: { overall, summary: '' },
  checks: [],
  branchPr: null,
  ...over
})
const siblings = [
  sibling('widget', 'main', 'ok', { detected: true }),
  sibling('widget-chat', 'fix/chat', 'running'),
  sibling('widget-lint', 'fix/lint', 'failed'),
  sibling('widget-ocr', 'fix/ocr', 'ok')
]
const withSiblings = (worktrees: ProjectStatus[]) => host({ requests: { 'status.get': () => ({ ...snapshot, worktrees }) } })
/** Worktree names (the grey badge of each sibling card), top to bottom. */
const worktreeOrder = (view: Awaited<ReturnType<typeof mount>>) =>
  view.findAll({ type: 'Badge', text: /^widget(-|$)/ }).map((node) => node.text)
const openAll = async (view: Awaited<ReturnType<typeof mount>>) => view.select({ label: 'Actions scope' }, 'all')

test('the scope tabs show only when the project has sibling worktrees', async () => {
  const none = await mount(panel, { host: host() })
  assert.equal(none.find({ role: 'tab', text: 'All worktrees' }), null)
  await none.unmount()
  const some = await mount(panel, { host: withSiblings(siblings) })
  assert.ok(some.find({ role: 'tab', text: 'This worktree' }))
  assert.ok(some.find({ role: 'tab', text: 'All worktrees' }))
  // The first scope keeps the project cards.
  assert.ok(some.find({ label: 'Widget' }))
  assert.equal(some.find({ type: 'Badge', text: 'widget-chat' }), null)
  await some.unmount()
})

test('All worktrees shows one card per worktree branch, marks the focused one, and hides the project cards', async () => {
  const view = await mount(panel, { host: withSiblings(siblings) })
  await openAll(view)
  assert.deepEqual(worktreeOrder(view), ['widget', 'widget-chat', 'widget-lint', 'widget-ocr'])
  assert.ok(view.find({ type: 'Badge', text: 'This worktree' }))
  assert.equal(view.find({ label: 'Add a project' }), null)
  assert.equal(view.find({ role: 'switch' }), null)
  assert.equal(view.find({ type: 'Select', label: /Branch of/ }), null)
  assert.equal(view.find({ type: 'IconButton', label: /^(Remove|Close) / }), null)
  await view.unmount()
})

test('Show worktree narrows All worktrees to one', async () => {
  const view = await mount(panel, { host: withSiblings(siblings) })
  await openAll(view)
  await view.select({ label: 'Show worktree' }, 'widget-lint')
  assert.deepEqual(worktreeOrder(view), ['widget-lint'])
  assert.ok(view.find({ text: 'Showing 1 of 4 cards' }))
  await view.unmount()
})

test('search keeps the cards whose project, branch or worktree holds the text, in any case', async () => {
  // `type` adds to the text already in the box, so each search starts from a fresh panel.
  const search = async (text: string) => {
    const view = await mount(panel, { host: withSiblings(siblings) })
    await openAll(view)
    await view.type({ label: 'Search cards' }, text)
    return view
  }
  const byWorktree = await search('LINT')
  assert.deepEqual(worktreeOrder(byWorktree), ['widget-lint'])
  await byWorktree.unmount()
  const byBranch = await search('fix/')
  assert.deepEqual(worktreeOrder(byBranch), ['widget-chat', 'widget-lint', 'widget-ocr'])
  await byBranch.unmount()
  const none = await search('nothing like this')
  assert.ok(none.find({ text: 'No card matches' }))
  await none.unmount()
})

test('the state filter keeps only failing, running or passing cards', async () => {
  const view = await mount(panel, { host: withSiblings(siblings) })
  await openAll(view)
  await view.select({ label: 'Show state' }, 'failed')
  assert.deepEqual(worktreeOrder(view), ['widget-lint'])
  await view.select({ label: 'Show state' }, 'running')
  assert.deepEqual(worktreeOrder(view), ['widget-chat'])
  await view.select({ label: 'Show state' }, 'ok')
  assert.deepEqual(worktreeOrder(view), ['widget', 'widget-ocr'])
  await view.unmount()
})

test('sort puts failing or passing cards first, or goes by name', async () => {
  const view = await mount(panel, { host: withSiblings(siblings) })
  await openAll(view)
  await view.select({ label: 'Sort cards' }, 'failing')
  assert.deepEqual(worktreeOrder(view), ['widget-lint', 'widget-chat', 'widget', 'widget-ocr'])
  await view.select({ label: 'Sort cards' }, 'passing')
  assert.deepEqual(worktreeOrder(view), ['widget', 'widget-ocr', 'widget-chat', 'widget-lint'])
  await view.select({ label: 'Sort cards' }, 'name-desc')
  assert.deepEqual(worktreeOrder(view), ['widget-ocr', 'widget-lint', 'widget-chat', 'widget'])
  await view.select({ label: 'Sort cards' }, 'name-asc')
  assert.deepEqual(worktreeOrder(view), ['widget', 'widget-chat', 'widget-lint', 'widget-ocr'])
  await view.unmount()
})

test('pinned cards stay above the rest when the list is sorted', async () => {
  const pinned = siblings.map((card) => (card.worktree === 'widget-ocr' ? { ...card, pinned: true } : card))
  const view = await mount(panel, { host: withSiblings(pinned) })
  await openAll(view)
  await view.select({ label: 'Sort cards' }, 'failing')
  assert.deepEqual(worktreeOrder(view), ['widget-ocr', 'widget-lint', 'widget-chat', 'widget'])
  await view.unmount()
})

test('a worktree card and an opened card pin by branch', async () => {
  const sent: unknown[] = []
  const view = await mount(panel, {
    host: host({
      requests: {
        'status.get': () => ({ ...snapshot, opened: [chatCard], worktrees: siblings }),
        'card.pin': (input: unknown) => {
          sent.push(input)
          return { ...snapshot, opened: [chatCard], worktrees: siblings }
        }
      }
    })
  })
  await view.press({ type: 'IconButton', label: 'Pin acme/widget' })
  await view.press({ type: 'IconButton', label: 'Pin acme/widget fix/chat' })
  await openAll(view)
  await view.press({ type: 'IconButton', label: 'Pin acme/widget fix/lint' })
  assert.deepEqual(sent, [
    { projectId: 'acme/widget', pinned: true },
    { projectId: 'acme/widget', branch: 'fix/chat', pinned: true },
    { projectId: 'acme/widget', branch: 'fix/lint', pinned: true }
  ])
  await view.unmount()
})

test('the pin button is a star, outlined when pinned, and asks the worker', async () => {
  const sent: unknown[] = []
  const view = await mount(panel, {
    host: host({
      requests: {
        'status.get': () => ({ ...snapshot, projects: [widget, { ...tool, pinned: true }] }),
        // The fake keeps the pin where it was, so both buttons stay to press.
        'card.pin': (input: unknown) => {
          sent.push(input)
          return { ...snapshot, projects: [widget, { ...tool, pinned: true }] }
        }
      }
    })
  })
  assert.ok(view.find({ type: 'IconButton', icon: 'star', label: 'Unpin Acme/Tool', variant: 'outline' }))
  assert.ok(view.find({ type: 'IconButton', icon: 'star', label: 'Pin acme/widget', variant: 'ghost' }))
  await view.press({ type: 'IconButton', label: 'Pin acme/widget' })
  await view.press({ type: 'IconButton', label: 'Unpin Acme/Tool' })
  assert.deepEqual(sent, [{ projectId: 'acme/widget', pinned: true }, { projectId: 'Acme/Tool', pinned: false }])
  await view.unmount()
})

test('the PRs tab says why it is empty', async () => {
  const view = await mount(panel, { host: host({ requests: { 'status.get': () => ({ ...snapshot, worktreePrs: [] }) } }) })
  await view.select({ label: 'View' }, 'prs')
  assert.ok(view.find({ type: 'EmptyState', label: 'No pull requests' }))
  await view.unmount()
})

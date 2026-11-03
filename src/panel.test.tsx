import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { StatusSnapshot } from './protocol'

const snapshot: StatusSnapshot = {
  checkedAt: Date.UTC(2026, 10, 3, 9, 0),
  projects: [
    {
      id: 'acme/widget',
      name: 'Widget',
      detected: true,
      flow: 'release',
      overall: 'blocked',
      summary: 'npm: v5.3.0 is released but npm latest is 5.2.0',
      actions: { overall: 'running', summary: 'Release is running on main' },
      stages: [{ id: 'npm', label: 'npm', state: 'blocked', detail: 'approve it', url: 'https://npm' }],
      branch: 'main',
      branches: ['main', 'v3'],
      runs: [
        { id: 9, workflow: 'Release', title: 'chore: release 5.3.0', state: 'running', rerunnable: false, url: 'https://r/9' }
      ],
      agentPrompt: '/release-agent'
    },
    {
      id: 'Acme/Tool',
      name: 'Tool',
      detected: false,
      flow: 'actions',
      overall: 'failed',
      summary: 'CI failed on main',
      actions: { overall: 'failed', summary: 'CI failed on main' },
      stages: [],
      branch: 'main',
      branches: ['main'],
      runs: [
        { id: 3, workflow: 'CI', title: 'fix: broken thing', state: 'failed', rerunnable: true, url: 'https://r/3' },
        { id: 2, workflow: 'CI', title: 'feat: older', state: 'passed', rerunnable: false, url: 'https://r/2' }
      ]
    }
  ]
}

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
      'project.add': () => ({ ok: true, message: 'Added Acme/Tool' }),
      'project.remove': () => ({ ok: true, message: 'Removed Acme/Tool' }),
      'run.rerun': () => ({ ok: true, message: 'Re-running failed jobs of run 3' }),
      'agent.ask': () => ({ sent: true, message: 'Sent /release-agent' }),
      ...requests.requests
    }
  })

test('shows each project with its state', async () => {
  const view = await mount(panel, { host: host() })
  assert.ok(view.find({ label: 'Widget' }))
  assert.ok(view.find({ type: 'Badge', text: 'Running' }))
  assert.ok(view.find({ type: 'Badge', text: 'Failing' }))
  assert.equal(view.findAll({ type: 'Badge', text: 'This project' }).length, 1)
  assert.ok(view.find({ text: 'Workflows on main' }))
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

test('the Releases tab shows only release projects, with their stages and release state', async () => {
  const view = await mount(panel, { host: host() })
  await view.select({ label: 'View' }, 'releases')
  assert.ok(view.find({ label: 'Widget' }))
  assert.ok(view.find({ label: 'Widget stages' }))
  assert.ok(view.find({ type: 'Badge', text: 'Needs you' }))
  assert.equal(view.find({ label: 'Tool' }), null)
  assert.ok(view.find({ text: 'No release flow: Tool' }))
  assert.equal(view.find({ text: 'Workflows on main' }), null)
  assert.equal(view.find({ label: 'Repository' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('the Releases tab explains itself when no project has a release flow', async () => {
  const onlyActions = { ...snapshot, projects: snapshot.projects.filter((p) => p.flow === 'actions') }
  const view = await mount(panel, { host: host({ requests: { 'status.get': () => onlyActions } }) })
  await view.select({ label: 'View' }, 'releases')
  assert.ok(view.find({ type: 'EmptyState', label: 'No release flow here' }))
  await view.unmount()
})

test('a running run shows a spinner and no retry button', async () => {
  const view = await mount(panel, { host: host() })
  assert.ok(view.find({ type: 'Spinner', label: 'Running: chore: release 5.3.0' }))
  assert.equal(view.findAll({ type: 'Spinner' }).length, 1)
  await view.unmount()
})

test('only failed runs get a retry button, and pressing it re-runs that run', async () => {
  const sent: unknown[] = []
  const view = await mount(panel, {
    host: host({
      requests: {
        'status.get': () => snapshot,
        'run.rerun': (input: unknown) => {
          sent.push(input)
          return { ok: true, message: 'Re-running failed jobs of run 3' }
        }
      }
    })
  })
  assert.equal(view.findAll({ type: 'IconButton', label: /Re-run/ }).length, 1)
  await view.press({ label: 'Re-run failed jobs: fix: broken thing' })
  assert.deepEqual(sent, [{ projectId: 'Acme/Tool', runId: 3 }])
  assert.ok(view.find({ text: 'Re-running failed jobs of run 3' }))
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

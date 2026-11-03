import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { Io } from './facts'
import { register } from './handlers'
import { RELEASE_FLOWS } from './projects'

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

const WIDGET = 'acme/widget'

const run = (id: number, workflowName: string, conclusion: string, displayTitle = workflowName) => ({
  databaseId: id,
  workflowName,
  status: 'COMPLETED',
  conclusion,
  url: `https://r/${id}`,
  displayTitle
})

/** Runs per branch of the widget repo. Other repos get one passing CI run on every branch. */
const WIDGET_RUNS: Record<string, ReturnType<typeof run>[]> = {
  main: [run(5, 'Release', 'SUCCESS'), run(4, 'CI', 'FAILURE'), run(3, 'Release', 'FAILURE', 'Older')],
  v3: [run(9, 'CI', 'FAILURE', 'v3 work'), run(8, 'Lint', 'SUCCESS')]
}

interface World {
  tag: string
  npm: string
  /** Where each checkout folder points. */
  remotes: Record<string, string | null>
  /** Repositories `gh repo view` can read, mapped to their default branch. */
  readable: Record<string, string>
  /** Which workspace folder owns each terminal, as Orca's CLI would say. */
  terminals: Record<string, string>
}

/** A stand-in for GitHub, git, npm and the updater. */
function fakeIo(world: Partial<World> = {}, calls: string[][] = [], terminalLookups: string[][] = []): Io {
  const w: World = {
    tag: 'v5.2.0',
    npm: '5.2.0',
    remotes: { '/p/widget': WIDGET, '/p/widget-v3': WIDGET, '/p/other': 'someone/else' },
    readable: { [WIDGET]: 'main', 'someone/else': 'trunk', 'Acme/Tool': 'main' },
    terminals: {},
    ...world
  }
  return {
    workspacePathOf: async (ids) => {
      terminalLookups.push(ids)
      return ids.map((id) => w.terminals[id]).find(Boolean) ?? null
    },
    repoOf: async (path) => w.remotes[path] ?? null,
    ghText: async (args) => {
      calls.push(args)
      return ''
    },
    ghJson: async (args) => {
      calls.push(args)
      if (args[0] === 'repo') {
        const repo = args[2]
        const found = Object.keys(w.readable).find((r) => r.toLowerCase() === repo.toLowerCase())
        if (!found) {
          throw new Error('Could not resolve to a Repository')
        }
        return { nameWithOwner: found, defaultBranchRef: { name: w.readable[found] } }
      }
      const repo = args[args.indexOf('-R') + 1]
      if (args[0] === 'run') {
        const branch = args[args.indexOf('--branch') + 1]
        return repo === WIDGET ? (WIDGET_RUNS[branch] ?? []) : [run(1, 'CI', 'SUCCESS')]
      }
      if (args[0] === 'pr') {
        return []
      }
      return [{ tagName: w.tag }]
    },
    getJson: async () => ({ latest: w.npm })
  }
}

const workspace = (id: string, name: string, path: string, branch: string | null, hostId: string | null = 'local') => ({
  id,
  kind: 'worktree' as const,
  name,
  path,
  branch,
  hostId
})

const WORKSPACES = [
  workspace('w1', 'widget', '/p/widget', 'main'),
  workspace('w2', 'widget-v3', '/p/widget-v3', 'v3'),
  workspace('w3', 'other', '/p/other', 'feature-x')
]

/** `focus` names the focused workspace; set it to another id to move focus. */
function hostFor(focus: { id: string | null }, storage: Record<string, unknown> = {}) {
  return mockHost({
    storage,
    results: {
      'workspace.readContext': () => {
        const focused = WORKSPACES.find((w) => w.id === focus.id)
        return focused ? { branch: focused.branch ?? '', displayName: focused.name, terminals: [] } : null
      },
      'workspace.list': () => ({ workspaces: WORKSPACES, truncated: false })
    }
  })
}

const mount = (io: Io, host = hostFor({ id: 'w1' })) => mountWorker({ default: (orca) => register(orca, io) }, { host })

test('the project of the focused workspace comes first, with its worktree branches', async () => {
  const worker = await mount(fakeIo())
  const snapshot = await worker.request('status.get')
  assert.deepEqual(snapshot.projects.map((p) => [p.id, p.detected, p.branch]), [[WIDGET, true, 'main']])
  assert.deepEqual(snapshot.projects[0]?.branches, ['main', 'v3'])
  assert.equal(snapshot.projects[0]?.flow, 'release')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a repository with no release flow shows Actions health only', async () => {
  const worker = await mount(fakeIo(), hostFor({ id: 'w3' }))
  const [project] = (await worker.request('status.get')).projects
  assert.equal(project?.id, 'someone/else')
  assert.equal(project?.flow, 'actions')
  assert.deepEqual(project?.stages, [])
  assert.equal(project?.overall, 'ok')
  assert.deepEqual(project?.branches, ['feature-x', 'trunk'])
  await worker.deactivate()
})

test('no focused workspace leaves only added projects and says why', async () => {
  const worker = await mount(fakeIo(), hostFor({ id: null }, { projects: ['Acme/Tool'] }))
  const snapshot = await worker.request('status.get')
  assert.deepEqual(snapshot.projects.map((p) => p.id), ['Acme/Tool'])
  assert.equal(snapshot.detectNote, 'No workspace is focused')
  await worker.deactivate()
})

test('a folder with no GitHub remote detects nothing', async () => {
  const worker = await mount(fakeIo({ remotes: {} }))
  const snapshot = await worker.request('status.get')
  assert.deepEqual(snapshot.projects, [])
  assert.equal(snapshot.detectNote, 'The focused workspace has no GitHub remote')
  await worker.deactivate()
})

test('branch.select shows the runs of another branch, while release stages keep reading main', async () => {
  const calls: string[][] = []
  const worker = await mount(fakeIo({}, calls), hostFor({ id: 'w1' }))
  const before = (await worker.request('status.get')).projects[0]
  assert.deepEqual(before?.runs.map((r) => r.id), [5, 4, 3])
  const after = (await worker.request('branch.select', { projectId: WIDGET, branch: 'v3' })).projects[0]
  assert.equal(after?.branch, 'v3')
  assert.deepEqual(after?.runs.map((r) => [r.id, r.workflow, r.rerunnable]), [[9, 'CI', true], [8, 'Lint', false]])
  assert.equal(after?.stages.find((s) => s.id === 'run')?.state, 'done')
  await worker.deactivate()
})

test('branch.select refuses a branch that was not offered', async () => {
  const worker = await mount(fakeIo())
  await worker.request('status.get')
  const snapshot = await worker.request('branch.select', { projectId: WIDGET, branch: 'nope' })
  assert.equal(snapshot.projects[0]?.branch, 'main')
  await worker.deactivate()
})

test('moving focus to another workspace drops the picked branch', async () => {
  const focus = { id: 'w1' as string | null }
  const worker = await mount(fakeIo(), hostFor(focus))
  await worker.request('status.get')
  assert.equal((await worker.request('branch.select', { projectId: WIDGET, branch: 'v3' })).projects[0]?.branch, 'v3')
  focus.id = 'w2'
  assert.equal((await worker.request('status.get')).projects[0]?.branch, 'v3')
  focus.id = 'w1'
  assert.equal((await worker.request('status.get')).projects[0]?.branch, 'main')
  await worker.deactivate()
})

test('project.add keeps the repository, after the detected project, under GitHub casing', async () => {
  const host = hostFor({ id: 'w1' })
  const worker = await mount(fakeIo(), host)
  const added = await worker.request('project.add', { repo: 'https://github.com/acme/tool.git' })
  assert.deepEqual(added, { ok: true, message: 'Added Acme/Tool' })
  assert.deepEqual(host.data().storage.projects, ['Acme/Tool'])
  const snapshot = await worker.request('status.get')
  assert.deepEqual(snapshot.projects.map((p) => [p.id, p.detected, p.branch]), [[WIDGET, true, 'main'], ['Acme/Tool', false, 'main']])
  await worker.deactivate()
})

test('project.add refuses a duplicate, a bad name and an unreadable repository', async () => {
  const host = hostFor({ id: 'w1' }, { projects: ['Acme/Tool'] })
  const worker = await mount(fakeIo(), host)
  assert.equal((await worker.request('project.add', { repo: 'acme/tool' })).ok, false)
  assert.equal((await worker.request('project.add', { repo: '--help/x' })).ok, false)
  assert.equal((await worker.request('project.add', { repo: 'ghost/missing' })).ok, false)
  assert.deepEqual(host.data().storage.projects, ['Acme/Tool'])
  await worker.deactivate()
})

test('project.remove drops an added repository', async () => {
  const host = hostFor({ id: 'w1' }, { projects: ['Acme/Tool'] })
  const worker = await mount(fakeIo(), host)
  await worker.request('project.remove', { repo: 'Acme/Tool' })
  assert.deepEqual(host.data().storage.projects, [])
  assert.deepEqual((await worker.request('status.get')).projects.map((p) => p.id), [WIDGET])
  await worker.deactivate()
})

test('an added repository that is also detected is listed once', async () => {
  const worker = await mount(fakeIo(), hostFor({ id: 'w1' }, { projects: ['Acme/Widget'] }))
  const projects = (await worker.request('status.get')).projects
  assert.deepEqual(projects.map((p) => [p.id, p.detected]), [[WIDGET, true]])
  await worker.deactivate()
})

test('the first look of a project sets a baseline and sends no notification', async () => {
  const host = hostFor({ id: 'w1' })
  const worker = await mount(fakeIo({ tag: 'v5.3.0' }), host)
  await worker.request('status.get')
  assert.equal(host.callsOf('notifications.show').length, 0)
  await worker.deactivate()
})

test('a release project that newly needs you sends one notification', async () => {
  const host = hostFor({ id: 'w1' }, { overall: { [WIDGET]: 'ok' } })
  const worker = await mount(fakeIo({ tag: 'v5.3.0' }), host)
  await worker.request('status.refresh')
  await worker.request('status.refresh')
  const sent = host.callsOf('notifications.show')
  assert.equal(sent.length, 1)
  assert.equal((sent[0] as { title: string }).title, 'Widget: needs you')
  await worker.deactivate()
})

test('failing Actions on a repository with no release flow never notify', async () => {
  const host = hostFor({ id: 'w3' }, { overall: { 'someone/else': 'ok' } })
  const io = fakeIo()
  const worker = await mount({ ...io, ghJson: async (args) => (args[0] === 'run' ? [run(2, 'CI', 'FAILURE')] : io.ghJson(args)) }, host)
  const [project] = (await worker.request('status.refresh')).projects
  assert.equal(project?.overall, 'failed')
  assert.equal(host.callsOf('notifications.show').length, 0)
  await worker.deactivate()
})

test('a failed lookup does not reset the stored state', async () => {
  const host = hostFor({ id: 'w1' }, { overall: { [WIDGET]: 'blocked' } })
  const io = fakeIo()
  const worker = await mount({ ...io, ghJson: async () => Promise.reject(new Error('rate limited')) }, host)
  const snapshot = await worker.request('status.refresh')
  assert.equal(snapshot.projects[0]?.overall, 'unknown')
  assert.deepEqual(host.data().storage.overall, { [WIDGET]: 'blocked' })
  await worker.deactivate()
})

test('run.rerun retries the chosen failed run of that project', async () => {
  const calls: string[][] = []
  const worker = await mount(fakeIo({}, calls))
  await worker.request('status.get')
  const answer = await worker.request('run.rerun', { projectId: WIDGET, runId: 4 })
  assert.equal(answer.ok, true)
  assert.deepEqual(calls.find((c) => c[1] === 'rerun'), ['run', 'rerun', '4', '-R', WIDGET, '--failed'])
  await worker.deactivate()
})

test('run.rerun refuses a run that is not a failed run of that project', async () => {
  const calls: string[][] = []
  const worker = await mount(fakeIo({}, calls))
  await worker.request('status.get')
  assert.equal((await worker.request('run.rerun', { projectId: WIDGET, runId: 5 })).ok, false)
  assert.equal((await worker.request('run.rerun', { projectId: WIDGET, runId: 99 })).ok, false)
  assert.equal((await worker.request('run.rerun', { projectId: 'someone/else', runId: 4 })).ok, false)
  assert.equal(calls.some((c) => c[1] === 'rerun'), false)
  await worker.deactivate()
})

test('agent.ask types the prompt only into a listed agent terminal', async () => {
  const host = mockHost({
    results: {
      'workspace.readContext': () => ({ branch: 'main', displayName: 'widget', terminals: [] }),
      'workspace.list': () => ({ workspaces: WORKSPACES, truncated: false }),
      'agents.list': () => ({
        agents: [{ terminalId: 't1', title: 'claude', agent: 'claude', state: 'waiting', stateStartedAt: 1 }]
      }),
      'terminal.sendText': () => ({ accepted: true })
    }
  })
  const worker = await mount(fakeIo(), host)
  await worker.request('status.get')
  assert.equal((await worker.request('agent.ask', { projectId: WIDGET, terminalId: 'gone' })).sent, false)
  assert.equal(host.callsOf('terminal.sendText').length, 0)
  assert.equal((await worker.request('agent.ask', { projectId: WIDGET, terminalId: 't1' })).sent, true)
  assert.deepEqual(host.callsOf('terminal.sendText')[0], { terminalId: 't1', text: '/release-agent', enter: true })
  assert.equal((await worker.request('agent.ask', { projectId: 'someone/else', terminalId: 't1' })).sent, false)
  await worker.deactivate()
})

/** Two projects whose checkouts are both a workspace called "main" on the branch "main". */
const TWINS = [
  workspace('a', 'main', '/p/widget', 'main'),
  workspace('b', 'main', '/p/gadget', 'main')
]

function twinHost(terminalId: string) {
  return mockHost({
    results: {
      'workspace.readContext': () => ({ branch: 'main', displayName: 'main', terminals: [{ id: terminalId }] }),
      'workspace.list': () => ({ workspaces: TWINS, truncated: false })
    }
  })
}

const TWIN_REMOTES = { '/p/widget': WIDGET, '/p/gadget': 'acme/gadget' }

test('workspaces with the same name and branch are told apart by their terminal', async () => {
  const world = { remotes: TWIN_REMOTES, terminals: { 't-gadget': '/p/gadget' } }
  const worker = await mount(fakeIo(world), twinHost('t-gadget'))
  const snapshot = await worker.request('status.get')
  assert.deepEqual(snapshot.projects.map((p) => [p.id, p.detected]), [['acme/gadget', true]])
  assert.equal(snapshot.detectNote, undefined)
  await worker.deactivate()
})

test('the terminal lookup runs once per terminal', async () => {
  const lookups: string[][] = []
  const worker = await mount(fakeIo({ remotes: TWIN_REMOTES, terminals: { 't-gadget': '/p/gadget' } }, [], lookups), twinHost('t-gadget'))
  await worker.request('status.get')
  await worker.request('status.refresh')
  assert.equal(lookups.length, 1)
  await worker.deactivate()
})

test('without a terminal answer, identical workspaces stay undetected and say why', async () => {
  const worker = await mount(fakeIo({ remotes: TWIN_REMOTES }), twinHost('t-unknown'))
  const snapshot = await worker.request('status.get')
  assert.deepEqual(snapshot.projects, [])
  assert.match(snapshot.detectNote ?? '', /cannot tell which one is focused/)
  await worker.deactivate()
})

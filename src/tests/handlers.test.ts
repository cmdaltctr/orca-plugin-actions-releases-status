import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { Io } from '../facts'
import { register } from '../handlers'

const WIDGET = 'acme/widget'

const run = (id: number, workflowName: string, conclusion: string, displayTitle = workflowName, headSha = 'sha-other') => ({
  databaseId: id,
  workflowName,
  status: 'COMPLETED',
  conclusion,
  url: `https://r/${id}`,
  displayTitle,
  headSha
})

/** Runs per branch of the widget repo. Other repos get one passing CI run on every branch. */
const WIDGET_RUNS: Record<string, ReturnType<typeof run>[]> = {
  main: [run(5, 'Release', 'SUCCESS', 'Release', 'sha-main'), run(4, 'CI', 'FAILURE', 'CI', 'sha-main'), run(3, 'Release', 'FAILURE', 'Older', 'sha-old')],
  v3: [run(9, 'CI', 'FAILURE', 'v3 work', 'sha-v3'), run(8, 'Lint', 'SUCCESS', 'Lint', 'sha-v3')]
}

const checkRun = (id: number, name: string, conclusion: string | null, runId = 70) => ({
  id,
  name,
  status: conclusion ? 'completed' : 'in_progress',
  conclusion,
  html_url: `https://c/${id}`,
  details_url: `https://github.com/acme/widget/actions/runs/${runId}/job/${id}`
})

/** The checks of each commit, as GitHub's check-runs endpoint answers them. */
const CHECKS_BY_SHA: Record<string, ReturnType<typeof checkRun>[]> = {
  'sha-main': [checkRun(1, 'test (ubuntu-latest)', 'success'), checkRun(2, 'lint', 'failure', 71), checkRun(3, 'Coverage (Codecov)', null)],
  'sha-v3': [checkRun(4, 'build', 'failure', 72), { ...checkRun(5, 'codecov/patch', 'failure'), details_url: null as unknown as string }],
  'sha-other': [checkRun(6, 'build', 'success')],
  'sha-fail': [checkRun(7, 'ci', 'failure')]
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
  /** Root files of each repository, by lower-case name. */
  files: Record<string, string[]>
  /** Workflow names of each repository, by lower-case name. */
  workflows: Record<string, string[]>
  /** The package.json of each repository, by lower-case name. */
  packages: Record<string, { name?: string; private?: boolean }>
  /** While true, every `gh api` call fails. */
  apiDown: boolean
  /** While true, the newest Release run on main failed. */
  releaseFails: boolean
}

/** A stand-in for GitHub, git, npm and the updater. */
function fakeIo(world: Partial<World> = {}, calls: string[][] = [], terminalLookups: string[][] = []): Io {
  const w: World = {
    tag: 'v5.2.0',
    npm: '5.2.0',
    remotes: { '/p/widget': WIDGET, '/p/widget-v3': WIDGET, '/p/other': 'someone/else' },
    readable: { [WIDGET]: 'main', 'someone/else': 'trunk', 'Acme/Tool': 'main' },
    terminals: {},
    files: { [WIDGET]: ['release-please-config.json', '.release-please-manifest.json', 'package.json', 'README.md'] },
    workflows: { 'acme/tool': ['CI', 'Release'] },
    packages: { [WIDGET]: { name: 'widget-pkg' } },
    apiDown: false,
    releaseFails: false,
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
      if (args[0] === 'api') {
        if (world.apiDown) {
          throw new Error('gh: api is down')
        }
        const [, repoPath, rest] = /^repos\/([^/]+\/[^/]+)\/(.*)$/.exec(args[1]) ?? []
        const key = (repoPath ?? '').toLowerCase()
        if (rest === 'contents') {
          return (w.files[key] ?? []).map((name) => ({ name }))
        }
        if (rest === 'contents/package.json') {
          if (!w.packages[key]) {
            throw new Error('Not Found')
          }
          return { content: Buffer.from(JSON.stringify(w.packages[key])).toString('base64') }
        }
        if (rest?.startsWith('actions/workflows')) {
          return { workflows: (w.workflows[key] ?? []).map((name) => ({ name })) }
        }
        const sha = /^commits\/([^/]+)\/check-runs/.exec(rest ?? '')?.[1]
        return { check_runs: CHECKS_BY_SHA[sha ?? ''] ?? [] }
      }
      if (args[0] === 'run' && args[1] === 'view') {
        return {
          jobs: [
            { databaseId: 501, name: 'smoke macos-26', status: 'completed', conclusion: 'cancelled', url: 'https://j/501' },
            { databaseId: 502, name: 'publish', status: 'completed', conclusion: 'success', url: 'https://j/502' }
          ]
        }
      }
      if (args[0] === 'release' && args[1] === 'view') {
        return { assets: [] }
      }
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
        const widgetRuns = (WIDGET_RUNS[branch] ?? []).map((r) =>
          w.releaseFails && r.databaseId === 5 ? { ...r, conclusion: 'FAILURE' } : r
        )
        return repo === WIDGET ? widgetRuns : [run(1, 'CI', 'SUCCESS')]
      }
      if (args[0] === 'pr') {
        // `--head` asks for the pull request of one branch; the release PR lookup has no `--head`.
        const head = args.includes('--head') ? args[args.indexOf('--head') + 1] : null
        return head === 'v3'
          ? [{ number: 7, url: 'https://github.com/x/widget/pull/7', title: 'feat: v3', state: 'MERGED', isDraft: false, mergeable: 'UNKNOWN', statusCheckRollup: [] }]
          : []
      }
      return [{ tagName: w.tag }]
    },
    getJson: async (url) => {
      calls.push(['get', url])
      return { latest: w.npm }
    }
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

test('branch.select shows the checks of another branch, while release stages keep reading main', async () => {
  const calls: string[][] = []
  const worker = await mount(fakeIo({}, calls), hostFor({ id: 'w1' }))
  const before = (await worker.request('status.get')).projects[0]
  assert.deepEqual(before?.checks.map((c) => c.id), [2, 3, 1])
  const after = (await worker.request('branch.select', { projectId: WIDGET, branch: 'v3' })).projects[0]
  assert.equal(after?.branch, 'v3')
  assert.deepEqual(after?.checks.map((c) => [c.id, c.name, c.rerunnable]), [[4, 'build', true], [5, 'codecov/patch', false]])
  assert.equal(after?.stages.find((s) => s.id === 'run')?.state, 'done')
  await worker.deactivate()
})

test('the pull request of the shown branch follows the branch picker', async () => {
  const worker = await mount(fakeIo(), hostFor({ id: 'w1' }))
  assert.equal((await worker.request('status.get')).projects[0]?.branchPr, null)
  const after = (await worker.request('branch.select', { projectId: WIDGET, branch: 'v3' })).projects[0]
  assert.deepEqual(after?.branchPr, { number: 7, url: 'https://github.com/x/widget/pull/7', title: 'feat: v3', state: 'merged' })
  await worker.deactivate()
})

test('a failed pull request lookup shows no pull request and keeps the checks', async () => {
  const io = fakeIo()
  const worker = await mount({ ...io, ghJson: async (args) => (args.includes('--head') ? Promise.reject(new Error('boom')) : io.ghJson(args)) })
  const snapshot = await worker.request('status.get')
  assert.equal(snapshot.projects[0]?.branchPr, null)
  assert.ok((snapshot.projects[0]?.checks.length ?? 0) > 0)
  assert.deepEqual(snapshot.worktreePrs, [])
  await worker.deactivate()
})

test('the PRs tab lists the worktrees of the focused project that have a PR, by worktree name', async () => {
  const worker = await mount(fakeIo())
  const snapshot = await worker.request('status.get')
  // `widget` on main has no PR; `other` belongs to another repository.
  assert.deepEqual(snapshot.worktreePrs, [
    { worktree: 'widget-v3', branch: 'v3', number: 7, url: 'https://github.com/x/widget/pull/7', title: 'feat: v3', state: 'merged', reason: '' }
  ])
  await worker.deactivate()
})

test('a worktree PR read once is kept when GitHub stops answering', async () => {
  let down = false
  const io = fakeIo()
  const worker = await mount({ ...io, ghJson: async (args) => (down && args.includes('--head') ? Promise.reject(new Error('boom')) : io.ghJson(args)) })
  await worker.request('status.get')
  down = true
  assert.deepEqual((await worker.request('status.refresh')).worktreePrs.map((pr) => pr.number), [7])
  await worker.deactivate()
})

test('card.open adds a card for a listed worktree branch, once, and card.close removes it', async () => {
  const worker = await mount(fakeIo())
  await worker.request('status.get')
  const opened = (await worker.request('card.open', { branch: 'v3' })).opened
  assert.deepEqual(opened.map((p) => [p.id, p.branch, p.opened, p.locked, p.detected]), [[WIDGET, 'v3', true, false, false]])
  assert.deepEqual(opened[0]?.checks.map((c) => c.id), [4, 5])
  assert.equal((await worker.request('card.open', { branch: 'v3' })).opened.length, 1)
  assert.deepEqual((await worker.request('card.close', { projectId: WIDGET, branch: 'v3' })).opened, [])
  await worker.deactivate()
})

test('card.pin pins one listed card at a time, keeps it in storage, and unpins', async () => {
  const host = hostFor({ id: 'w1' }, { projects: ['Acme/Tool'] })
  const worker = await mount(fakeIo(), host)
  await worker.request('status.get')
  const pinnedOf = (s: { projects: { id: string; pinned?: boolean }[] }) => s.projects.filter((p) => p.pinned).map((p) => p.id)
  assert.deepEqual(pinnedOf(await worker.request('card.pin', { projectId: WIDGET, pinned: true })), [WIDGET])
  assert.deepEqual(pinnedOf(await worker.request('card.pin', { projectId: 'Acme/Tool', pinned: true })), ['Acme/Tool'])
  assert.equal(host.data().storage.pin, 'acme/tool')
  assert.deepEqual(pinnedOf(await worker.request('card.pin', { projectId: 'nope/none', pinned: true })), ['Acme/Tool'])
  assert.deepEqual(pinnedOf(await worker.request('card.pin', { projectId: 'Acme/Tool', pinned: false })), [])
  await worker.deactivate()
})

test('card.open refuses a branch the PRs tab did not list', async () => {
  const worker = await mount(fakeIo())
  await worker.request('status.get')
  assert.deepEqual((await worker.request('card.open', { branch: 'main' })).opened, [])
  assert.deepEqual((await worker.request('card.open', { branch: 'nope' })).opened, [])
  await worker.deactivate()
})

test('an opened card keeps showing after focus moves to another project, and its failed run can be re-run', async () => {
  const focus = { id: 'w1' as string | null }
  const calls: string[][] = []
  const worker = await mount(fakeIo({}, calls), hostFor(focus))
  await worker.request('status.get')
  await worker.request('card.open', { branch: 'v3' })
  focus.id = 'w3'
  const snapshot = await worker.request('status.get')
  assert.deepEqual(snapshot.opened.map((p) => p.branch), ['v3'])
  assert.deepEqual(snapshot.worktreePrs, [])
  assert.equal((await worker.request('run.rerun', { projectId: WIDGET, runId: 72 })).ok, true)
  assert.ok(calls.some((args) => args.join(' ') === `run rerun 72 -R ${WIDGET} --failed`))
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

test('a locked branch survives moving focus to another project, which then shows next to it', async () => {
  const focus = { id: 'w1' as string | null }
  const host = hostFor(focus)
  const worker = await mount(fakeIo(), host)
  await worker.request('status.get')
  await worker.request('branch.select', { projectId: WIDGET, branch: 'v3' })
  const locked = (await worker.request('branch.lock', { projectId: WIDGET, locked: true })).projects[0]
  assert.equal(locked?.locked, true)
  assert.deepEqual(host.data().storage.locks, { [WIDGET.toLowerCase()]: { repo: WIDGET, branch: 'v3' } })
  focus.id = 'w3'
  const moved = (await worker.request('status.get')).projects
  assert.deepEqual(moved.map((p) => [p.id, p.detected, p.branch, p.locked]), [
    ['someone/else', true, 'feature-x', false],
    [WIDGET, false, 'v3', true]
  ])
  assert.ok(moved[1]?.branches.includes('v3'))
  focus.id = 'w1'
  assert.equal((await worker.request('status.get')).projects[0]?.branch, 'v3')
  await worker.deactivate()
})

test('unlocking returns to the focused branch, and a project only the lock listed disappears', async () => {
  const focus = { id: 'w1' as string | null }
  const worker = await mount(fakeIo(), hostFor(focus))
  await worker.request('status.get')
  await worker.request('branch.select', { projectId: WIDGET, branch: 'v3' })
  await worker.request('branch.lock', { projectId: WIDGET, locked: true })
  focus.id = 'w3'
  await worker.request('status.get')
  const after = await worker.request('branch.lock', { projectId: WIDGET, locked: false })
  assert.deepEqual(after.projects.map((p) => p.id), ['someone/else'])
  focus.id = 'w1'
  const back = (await worker.request('status.get')).projects[0]
  assert.deepEqual([back?.branch, back?.locked], ['main', false])
  await worker.deactivate()
})

test('picking another branch while locked moves the lock to it', async () => {
  const host = hostFor({ id: 'w1' })
  const worker = await mount(fakeIo(), host)
  await worker.request('status.get')
  await worker.request('branch.lock', { projectId: WIDGET, locked: true })
  const after = (await worker.request('branch.select', { projectId: WIDGET, branch: 'v3' })).projects[0]
  assert.deepEqual([after?.branch, after?.locked], ['v3', true])
  assert.deepEqual(host.data().storage.locks, { [WIDGET.toLowerCase()]: { repo: WIDGET, branch: 'v3' } })
  await worker.deactivate()
})

test('branch.lock ignores a project that is not listed, and removing a project clears its lock', async () => {
  const host = hostFor({ id: 'w1' }, { projects: ['Acme/Tool'] })
  const worker = await mount(fakeIo(), host)
  await worker.request('status.get')
  await worker.request('branch.lock', { projectId: 'nobody/nothing', locked: true })
  assert.equal(host.data().storage.locks, undefined)
  await worker.request('branch.lock', { projectId: 'Acme/Tool', locked: true })
  await worker.request('project.remove', { repo: 'Acme/Tool' })
  assert.deepEqual(host.data().storage.locks, {})
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
  assert.equal((sent[0] as { title: string }).title, 'widget: needs you')
  await worker.deactivate()
})

test('failing Actions on a repository with no release flow never notify', async () => {
  const host = hostFor({ id: 'w3' }, { overall: { 'someone/else': 'ok' } })
  const io = fakeIo()
  const worker = await mount({ ...io, ghJson: async (args) => (args[0] === 'run' ? [run(2, 'CI', 'FAILURE', 'CI', 'sha-fail')] : io.ghJson(args)) }, host)
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

test('run.rerun retries the run of a failed check of that project', async () => {
  const calls: string[][] = []
  const worker = await mount(fakeIo({}, calls))
  await worker.request('status.get')
  const answer = await worker.request('run.rerun', { projectId: WIDGET, runId: 71 })
  assert.equal(answer.ok, true)
  assert.deepEqual(calls.find((c) => c[1] === 'rerun'), ['run', 'rerun', '71', '-R', WIDGET, '--failed'])
  await worker.deactivate()
})

test('run.rerun refuses a run with no failed check, an unknown run and another project', async () => {
  const calls: string[][] = []
  const worker = await mount(fakeIo({}, calls))
  await worker.request('status.get')
  assert.equal((await worker.request('run.rerun', { projectId: WIDGET, runId: 70 })).ok, false)
  assert.equal((await worker.request('run.rerun', { projectId: WIDGET, runId: 99 })).ok, false)
  assert.equal((await worker.request('run.rerun', { projectId: 'someone/else', runId: 71 })).ok, false)
  assert.equal(calls.some((c) => c[1] === 'rerun'), false)
  await worker.deactivate()
})

test('agent.ask types the saved prompt only into a listed agent terminal', async () => {
  const host = mockHost({
    storage: { settings: { [WIDGET]: { agentPrompt: '/release-agent', updaterUrl: '' } } },
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

test('release-please files and an npm package give the full npm flow', async () => {
  const worker = await mount(fakeIo())
  const [project] = (await worker.request('status.get')).projects
  assert.equal(project?.flow, 'release')
  assert.equal(project?.flowNote, 'release-please, npm package widget-pkg')
  assert.deepEqual(project?.stages.map((stage) => stage.id), ['pr', 'run', 'npm'])
  await worker.deactivate()
})

test('release-please files with a private or missing package.json end at the GitHub release', async () => {
  for (const packages of [{ [WIDGET]: { name: 'widget-pkg', private: true } }, {}]) {
    const worker = await mount(fakeIo({ packages }))
    const [project] = (await worker.request('status.get')).projects
    assert.equal(project?.flowNote, 'release-please')
    assert.deepEqual(project?.stages.map((stage) => stage.id), ['pr', 'run', 'release'])
    await worker.deactivate()
  }
})

test('a workflow named Release gives the release-workflow flow, and no signs give none', async () => {
  const host = hostFor({ id: 'w1' }, { projects: ['Acme/Tool'] })
  const worker = await mount(fakeIo({ readable: { [WIDGET]: 'main', 'Acme/Tool': 'main' }, files: {} }), host)
  const [widget, tool] = (await worker.request('status.get')).projects
  assert.equal(widget?.flow, 'actions')
  assert.equal(tool?.flowNote, 'A workflow named Release')
  assert.deepEqual(tool?.stages.map((stage) => stage.id), ['run', 'release'])
  await worker.deactivate()
})

test('a repository GitHub cannot be read for shows Actions only and is looked at again next time', async () => {
  const world = { apiDown: true }
  const worker = await mount(fakeIo(world))
  assert.equal((await worker.request('status.get')).projects[0]?.flow, 'actions')
  world.apiDown = false
  assert.equal((await worker.request('status.refresh')).projects[0]?.flow, 'release')
  await worker.deactivate()
})

test('the flow is read from GitHub once per repository', async () => {
  const calls: string[][] = []
  const worker = await mount(fakeIo({}, calls))
  await worker.request('status.get')
  await worker.request('status.refresh')
  assert.equal(calls.filter((c) => c[0] === 'api' && c[1].endsWith('/contents')).length, 1)
  await worker.deactivate()
})

test('project.settings saves, shows in the snapshot and gives the project its agent prompt', async () => {
  const host = hostFor({ id: 'w1' })
  const worker = await mount(fakeIo(), host)
  await worker.request('status.get')
  const answer = await worker.request('project.settings', { projectId: WIDGET, agentPrompt: ' /release-agent ', updaterUrl: '' })
  assert.deepEqual(answer, { ok: true, message: 'Saved settings of widget' })
  assert.deepEqual(host.data().storage.settings, { [WIDGET]: { agentPrompt: '/release-agent', updaterUrl: '' } })
  const [project] = (await worker.request('status.get')).projects
  assert.deepEqual(project?.settings, { agentPrompt: '/release-agent', updaterUrl: '' })
  assert.equal(project?.agentPrompt, '/release-agent')
  await worker.deactivate()
})

test('an updater URL gives a repository with no flow the desktop flow with an Updater stage', async () => {
  const calls: string[][] = []
  const worker = await mount(fakeIo({}, calls), hostFor({ id: 'w3' }))
  await worker.request('status.get')
  assert.equal(calls.some((c) => c[0] === 'get'), false)
  await worker.request('project.settings', { projectId: 'someone/else', agentPrompt: '', updaterUrl: 'https://updates.example.com/latest.json' })
  const [project] = (await worker.request('status.get')).projects
  assert.equal(project?.flow, 'release')
  assert.equal(project?.flowNote, 'Release workflow with an updater URL')
  assert.ok(project?.stages.some((stage) => stage.id === 'updater'))
  // The saved URL changes what is read, so a look cached before it must not be reused.
  assert.ok(calls.some((c) => c[0] === 'get' && c[1] === 'https://updates.example.com/latest.json'))
  await worker.deactivate()
})

test('project.settings refuses bad values and unlisted projects and stores nothing', async () => {
  const host = hostFor({ id: 'w1' })
  const worker = await mount(fakeIo(), host)
  await worker.request('status.get')
  const bad = [
    { projectId: WIDGET, agentPrompt: 'rm -rf /', updaterUrl: '' },
    { projectId: WIDGET, agentPrompt: '/a\n/b', updaterUrl: '' },
    { projectId: WIDGET, agentPrompt: '', updaterUrl: 'http://updates.example.com' },
    { projectId: 'stranger/repo', agentPrompt: '/x', updaterUrl: '' }
  ]
  for (const input of bad) {
    assert.equal((await worker.request('project.settings', input)).ok, false)
  }
  assert.equal(host.data().storage.settings, undefined)
  await worker.deactivate()
})

test('saving empty settings clears them, and removing a project drops its settings', async () => {
  const host = hostFor({ id: 'w1' }, { projects: ['Acme/Tool'], settings: { [WIDGET]: { agentPrompt: '/x', updaterUrl: '' }, 'acme/tool': { agentPrompt: '/y', updaterUrl: '' } } })
  const worker = await mount(fakeIo(), host)
  await worker.request('status.get')
  await worker.request('project.settings', { projectId: WIDGET, agentPrompt: '', updaterUrl: '' })
  assert.deepEqual(host.data().storage.settings, { 'acme/tool': { agentPrompt: '/y', updaterUrl: '' } })
  await worker.request('project.remove', { repo: 'Acme/Tool' })
  assert.deepEqual(host.data().storage.settings, {})
  await worker.deactivate()
})

test('a failed release run lists its jobs, and its cancelled job can be re-run', async () => {
  const calls: string[][] = []
  const worker = await mount(fakeIo({ releaseFails: true }, calls))
  const [project] = (await worker.request('status.get')).projects
  const [group] = project?.releaseJobs ?? []
  assert.equal(group?.label, 'Release run')
  assert.deepEqual(group?.jobs.map((job) => [job.name, job.state, job.rerunnable]), [['smoke macos-26', 'cancelled', true], ['publish', 'passed', false]])
  assert.deepEqual(calls.find((c) => c[0] === 'run' && c[1] === 'view'), ['run', 'view', '5', '-R', WIDGET, '--json', 'jobs'])
  const answer = await worker.request('run.rerun', { projectId: WIDGET, runId: 5 })
  assert.equal(answer.ok, true)
  assert.deepEqual(calls.find((c) => c[1] === 'rerun'), ['run', 'rerun', '5', '-R', WIDGET, '--failed'])
  await worker.deactivate()
})

test('a release run that passed lists no jobs and asks GitHub for none', async () => {
  const calls: string[][] = []
  const worker = await mount(fakeIo({}, calls))
  const [project] = (await worker.request('status.get')).projects
  assert.deepEqual(project?.releaseJobs, [])
  assert.equal(calls.some((c) => c[0] === 'run' && c[1] === 'view'), false)
  await worker.deactivate()
})

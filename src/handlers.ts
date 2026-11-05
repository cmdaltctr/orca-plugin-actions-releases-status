// The worker's logic. `register` takes the Io so tests can replace GitHub, git, npm and the updater.
import type { OrcaWorkerApi } from 'orca/worker'
import { defaultBranch, detectFlow, gatherFacts, worktreePrOf, type Io } from './facts'
import { NO_SETTINGS, parseRepo, projectDef, sameRepo, settingsProblem, type DetectedFlow, type ProjectDef } from './projects'
import type { Overall, ProjectSettings, ProjectStatus, StatusSnapshot, WorktreePr } from './protocol'
import { classify, prState, unknownStatus, type Facts, type View } from './status'

const FRESH_MS = 20_000
const OVERALL_KEY = 'overall'
const PROJECTS_KEY = 'projects'
const SETTINGS_KEY = 'settings'
const LOCKS_KEY = 'locks'

/** A branch the user locked. The repository keeps its GitHub casing so the card can list it with no workspace. */
interface Lock {
  repo: string
  branch: string
}

/** One row of the host's `workspace.list`. */
interface Workspace {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  path: string
  branch: string | null
  hostId: string | null
}

/** The project of the focused workspace, and the branches its local checkouts have. */
interface Detected {
  workspaceId: string
  repo: string
  focusedBranch: string | null
  branches: string[]
  /** Every local worktree of the repository that is on a branch, the focused one first. */
  worktrees: { name: string; branch: string }[]
}

/** Orca names the machine it runs on `local`; SSH and paired hosts have other ids. */
const isLocal = (workspace: Workspace): boolean => workspace.hostId === null || workspace.hostId === 'local'

/** The one workspace Orca shows. Branch and name must pick exactly one. */
function pickFocused(workspaces: Workspace[], branch: string, displayName: string): Workspace | string {
  const byBranch = workspaces.filter((w) => (w.branch ?? '') === branch)
  const matches = byBranch.length > 1 ? byBranch.filter((w) => w.name === displayName) : byBranch
  if (matches.length === 1) {
    return matches[0]
  }
  return byBranch.length === 0
    ? 'Orca did not list the focused workspace'
    : `Several workspaces share the branch "${branch}", so Orca cannot tell which one is focused`
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function register(orca: OrcaWorkerApi, io: Io): void {
  let snapshot: StatusSnapshot | null = null
  /** What GitHub said, per project and branch, so a quick second look costs no request. */
  const cache = new Map<string, { at: number; facts: Facts }>()
  /** The branch the user picked, per lower-case repository. */
  const chosen = new Map<string, string>()
  /** Remotes and default branches change rarely, so each is read once while the worker lives. */
  const remotes = new Map<string, string | null>()
  const defaults = new Map<string, string>()
  /** The release flow GitHub showed for each repository. Only a successful look is kept. */
  const flows = new Map<string, DetectedFlow | null>()
  /** A terminal never changes workspace, so each is looked up once. */
  const terminalPaths = new Map<string, string>()
  const prCache = new Map<string, { at: number; pr: Awaited<ReturnType<typeof worktreePrOf>> }>()
  /** Cards opened from the PRs tab. Kept in memory only, so they go when Orca restarts. */
  let opened: Lock[] = []
  /** The repository the PRs tab listed last, so `card.open` only opens its branches. */
  let prRepo: string | null = null
  let focusedBefore: string | null = null
  let lastAskedAt = Date.now()
  let chain: Promise<unknown> = Promise.resolve()

  const remoteOf = async (path: string): Promise<string | null> => {
    if (!remotes.has(path)) {
      remotes.set(path, await io.repoOf(path))
    }
    return remotes.get(path) ?? null
  }

  async function defaultBranchOf(repo: string): Promise<string | null> {
    const key = repo.toLowerCase()
    if (!defaults.has(key)) {
      const found = await defaultBranch(repo, io)
      if (found) {
        defaults.set(key, found)
      }
    }
    return defaults.get(key) ?? null
  }

  /** Many workspaces share the branch `main`, so the terminals are the exact way to tell which one is focused. */
  async function focusedPath(terminalIds: string[]): Promise<string | null> {
    const known = terminalIds.find((id) => terminalPaths.has(id))
    if (known) {
      return terminalPaths.get(known) ?? null
    }
    const path = await io.workspacePathOf(terminalIds)
    if (path) {
      for (const id of terminalIds) {
        terminalPaths.set(id, path)
      }
    }
    return path
  }

  async function flowOf(repo: string): Promise<DetectedFlow | null> {
    const key = repo.toLowerCase()
    if (!flows.has(key)) {
      try {
        flows.set(key, await detectFlow(repo, io))
      } catch {
        // GitHub could not be read now: show Actions only and look again next time.
        return null
      }
    }
    return flows.get(key) ?? null
  }

  async function detect(): Promise<Detected | string> {
    const context = await orca.host.call('workspace.readContext')
    if (!context) {
      return 'No workspace is focused'
    }
    const { workspaces } = await orca.host.call('workspace.list')
    const path = await focusedPath(context.terminals.map((t) => t.id))
    const focused = workspaces.find((w) => w.path === path) ?? pickFocused(workspaces, context.branch, context.displayName)
    if (typeof focused === 'string') {
      return focused
    }
    if (!isLocal(focused)) {
      return 'Remote workspaces are not supported yet'
    }
    const repo = await remoteOf(focused.path)
    if (!repo) {
      return 'The focused workspace has no GitHub remote'
    }
    // Every local checkout of the same repository: its branches are the ones worth switching to.
    const others = await Promise.all(
      workspaces
        .filter((w) => w.id !== focused.id && w.branch && isLocal(w))
        .map(async (w) => {
          const other = await remoteOf(w.path)
          return other && sameRepo(other, repo) ? w : null
        })
    )
    const worktrees = [focused, ...others].flatMap((w) => (w?.branch ? [{ name: w.name, branch: w.branch }] : []))
    return {
      workspaceId: focused.id,
      repo,
      focusedBranch: focused.branch,
      branches: [...new Set(worktrees.map((w) => w.branch))],
      worktrees
    }
  }

  async function viewOf(repo: string, detected: Detected | null, lock: Lock | undefined): Promise<View> {
    const fallback = await defaultBranchOf(repo)
    const options = [...new Set([...(detected?.branches ?? []), ...(fallback ? [fallback] : [])])]
    const picked = chosen.get(repo.toLowerCase())
    // A lock holds its branch even when no workspace offers it any more.
    const branch = lock?.branch ?? (picked && options.includes(picked) ? picked : (detected?.focusedBranch ?? fallback ?? 'main'))
    return {
      branch,
      branches: options.includes(branch) ? options : [...options, branch],
      detected: detected !== null,
      locked: lock !== undefined
    }
  }

  async function look(def: ProjectDef, view: View, force: boolean): Promise<ProjectStatus> {
    // The flow and the updater change what is read, so they belong in the key.
    const key = `${def.id.toLowerCase()}@${view.branch}@${def.kind ?? ''}@${def.updaterUrl ?? ''}`
    try {
      let hit = cache.get(key)
      if (force || !hit || Date.now() - hit.at >= FRESH_MS) {
        hit = { at: Date.now(), facts: await gatherFacts(def, view.branch, io) }
        cache.set(key, hit)
        lastAskedAt = hit.at
      }
      return classify(def, hit.facts, view)
    } catch (error) {
      return unknownStatus(def, error, view)
    }
  }

  /** The newest PR of each worktree branch, by `repo@branch`. A failed read keeps the last answer. */
  async function worktreePrs(found: Detected | null, force: boolean): Promise<WorktreePr[]> {
    if (!found) {
      return []
    }
    const rows = await Promise.all(
      found.worktrees.map(async ({ name, branch }) => {
        const key = `${found.repo.toLowerCase()}@${branch}`
        let hit = prCache.get(key)
        if (force || !hit || Date.now() - hit.at >= FRESH_MS) {
          try {
            hit = { at: Date.now(), pr: await worktreePrOf(found.repo, branch, io) }
            prCache.set(key, hit)
          } catch {
            // GitHub could not be read now: show what it said last time.
          }
        }
        const pr = hit?.pr
        return pr ? { worktree: name, branch, number: pr.number, url: pr.url, title: pr.title, ...prState(pr) } : null
      })
    )
    return rows.filter((row): row is WorktreePr => row !== null)
  }

  const savedRepos = async (): Promise<string[]> => ((await orca.storage.get(PROJECTS_KEY)) as string[] | null) ?? []
  const savedSettings = async (): Promise<Record<string, ProjectSettings>> =>
    ((await orca.storage.get(SETTINGS_KEY)) as Record<string, ProjectSettings> | null) ?? {}

  const savedLocks = async (): Promise<Record<string, Lock>> =>
    ((await orca.storage.get(LOCKS_KEY)) as Record<string, Lock> | null) ?? {}

  /** Notifies when a release project newly needs you or newly fails. A project seen for the first time only sets the baseline. */
  async function notifyChanges(projects: ProjectStatus[]): Promise<void> {
    const before = ((await orca.storage.get(OVERALL_KEY)) as Record<string, Overall> | null) ?? {}
    const after = { ...before }
    for (const project of projects) {
      // A failed lookup says nothing about the release, so keep the last known state.
      after[project.id] = project.overall === 'unknown' ? (before[project.id] ?? 'unknown') : project.overall
    }
    await orca.storage.set(OVERALL_KEY, after)
    for (const project of projects) {
      // Actions on a feature branch fail all the time, so only release flows notify.
      const known = before[project.id] !== undefined && project.flow === 'release'
      if (known && after[project.id] !== before[project.id] && (project.overall === 'blocked' || project.overall === 'failed')) {
        await orca.host.call('notifications.show', {
          title: `${project.name}: ${project.overall === 'failed' ? 'release failed' : 'needs you'}`,
          body: project.summary
        })
      }
    }
  }

  async function lookAll(force: boolean): Promise<StatusSnapshot> {
    const detected = await detect()
    const found = typeof detected === 'string' ? null : detected
    if (found) {
      // Moving to another workspace drops the branch picked for the old one.
      if (found.workspaceId !== focusedBefore) {
        chosen.delete(found.repo.toLowerCase())
      }
      focusedBefore = found.workspaceId
    }
    const locks = await savedLocks()
    const repos = [...(found ? [found.repo] : []), ...(await savedRepos()), ...Object.values(locks).map((lock) => lock.repo)]
    const unique = repos.filter((repo, i) => repos.findIndex((other) => sameRepo(other, repo)) === i)
    const settings = await savedSettings()
    const projects = await Promise.all(
      unique.map(async (repo) => {
        const owner = found && sameRepo(found.repo, repo) ? found : null
        const def = projectDef(repo, await flowOf(repo), settings[repo.toLowerCase()] ?? NO_SETTINGS)
        return look(def, await viewOf(repo, owner, locks[repo.toLowerCase()]), force)
      })
    )
    // An opened card shows Actions only, so it skips the release flow and its lookups.
    const [openedCards, prs] = await Promise.all([
      Promise.all(
        opened.map((card) =>
          look(projectDef(card.repo, null), { branch: card.branch, branches: [card.branch], detected: false, locked: false, opened: true }, force)
        )
      ),
      worktreePrs(found, force)
    ])
    prRepo = found?.repo ?? null
    snapshot = {
      projects,
      opened: openedCards,
      worktreePrs: prs,
      ...(typeof detected === 'string' ? { detectNote: detected } : {}),
      checkedAt: lastAskedAt
    }
    await notifyChanges(projects)
    orca.panels.post('status.changed', snapshot)
    return snapshot
  }

  /** One look at a time, so a branch switch never races a poll. */
  function refresh(force: boolean): Promise<StatusSnapshot> {
    const next = chain.then(() => lookAll(force))
    chain = next.catch(() => undefined)
    return next
  }

  orca.panels.handle('status.get', () => refresh(false))
  orca.panels.handle('status.refresh', () => refresh(true))

  orca.panels.handle('branch.select', async ({ projectId, branch }) => {
    // `viewOf` ignores a branch the project does not offer.
    const key = projectId.toLowerCase()
    chosen.set(key, branch)
    // A locked card follows a new pick, so the lock keeps what the reader sees.
    const locks = await savedLocks()
    const listed = snapshot?.projects.find((p) => p.id.toLowerCase() === key)
    if (locks[key] && listed?.branches.includes(branch)) {
      await orca.storage.set(LOCKS_KEY, { ...locks, [key]: { repo: locks[key].repo, branch } })
    }
    return refresh(false)
  })

  orca.panels.handle('branch.lock', async ({ projectId, locked }) => {
    // Only a project the panel listed, locked on the branch it shows.
    const listed = snapshot?.projects.find((p) => p.id === projectId)
    if (listed) {
      const { [listed.id.toLowerCase()]: _old, ...rest } = await savedLocks()
      await orca.storage.set(LOCKS_KEY, locked ? { ...rest, [listed.id.toLowerCase()]: { repo: listed.id, branch: listed.branch } } : rest)
    }
    return refresh(false)
  })

  orca.panels.handle('card.open', ({ branch }) => {
    // Only a worktree branch the PRs tab listed, and never twice.
    const listed = prRepo !== null && snapshot?.worktreePrs.some((pr) => pr.branch === branch)
    const repo = prRepo
    if (listed && repo && !opened.some((card) => sameRepo(card.repo, repo) && card.branch === branch)) {
      opened = [...opened, { repo, branch }]
    }
    return refresh(false)
  })

  orca.panels.handle('card.close', ({ projectId, branch }) => {
    opened = opened.filter((card) => !(sameRepo(card.repo, projectId) && card.branch === branch))
    return refresh(false)
  })

  orca.panels.handle('project.add', async ({ repo: text }) => {
    const repo = parseRepo(text)
    if (!repo) {
      return { ok: false, message: 'Use owner/name or a GitHub repository URL' }
    }
    let canonical: string
    try {
      canonical = ((await io.ghJson(['repo', 'view', repo, '--json', 'nameWithOwner'])) as { nameWithOwner: string }).nameWithOwner
    } catch (error) {
      return { ok: false, message: `Cannot read ${repo}: ${message(error)}` }
    }
    const saved = await savedRepos()
    if (saved.some((other) => sameRepo(other, canonical))) {
      return { ok: false, message: `${canonical} is already added` }
    }
    await orca.storage.set(PROJECTS_KEY, [...saved, canonical])
    await refresh(false)
    return { ok: true, message: `Added ${canonical}` }
  })

  orca.panels.handle('project.settings', async ({ projectId, agentPrompt, updaterUrl }) => {
    // Only a project the panel listed, so the store never collects settings for strangers.
    const listed = snapshot?.projects.find((p) => p.id === projectId)
    if (!listed) {
      return { ok: false, message: 'That project is not listed' }
    }
    const next = { agentPrompt: agentPrompt.trim(), updaterUrl: updaterUrl.trim() }
    const problem = settingsProblem(next)
    if (problem) {
      return { ok: false, message: problem }
    }
    const all = await savedSettings()
    const key = listed.id.toLowerCase()
    if (next.agentPrompt || next.updaterUrl) {
      all[key] = next
    } else {
      delete all[key]
    }
    await orca.storage.set(SETTINGS_KEY, all)
    await refresh(false)
    return { ok: true, message: `Saved settings of ${listed.name}` }
  })

  orca.panels.handle('project.remove', async ({ repo }) => {
    const saved = await savedRepos()
    const all = await savedSettings()
    delete all[repo.toLowerCase()]
    const { [repo.toLowerCase()]: _unlocked, ...locks } = await savedLocks()
    await orca.storage.set(SETTINGS_KEY, all)
    await orca.storage.set(LOCKS_KEY, locks)
    await orca.storage.set(PROJECTS_KEY, saved.filter((other) => !sameRepo(other, repo)))
    await refresh(false)
    return { ok: true, message: `Removed ${repo}` }
  })

  orca.panels.handle('run.rerun', async ({ projectId, runId }) => {
    // Only a failed run the panel listed for this project, on any of its cards, never an id from elsewhere.
    const cards = [...(snapshot?.projects ?? []), ...(snapshot?.opened ?? [])].filter((p) => p.id === projectId)
    const rerunnable = cards.flatMap((card) => [...card.checks, ...card.releaseJobs.flatMap((group) => group.jobs)])
    if (!rerunnable.some((check) => check.runId === runId && check.rerunnable)) {
      return { ok: false, message: 'No failed run to re-run' }
    }
    try {
      await io.ghText(['run', 'rerun', String(runId), '-R', projectId, '--failed'])
    } catch (error) {
      return { ok: false, message: message(error) }
    }
    await refresh(true)
    return { ok: true, message: `Re-running failed jobs of run ${runId}` }
  })

  orca.panels.handle('agent.ask', async ({ projectId, terminalId }) => {
    const prompt = snapshot?.projects.find((p) => p.id === projectId)?.agentPrompt
    if (!prompt) {
      return { sent: false, message: 'This project has no agent prompt' }
    }
    // Type only into a terminal Orca still lists as an agent, never into a stale id.
    const { agents } = await orca.host.call('agents.list')
    if (!agents.some((agent) => agent.terminalId === terminalId)) {
      return { sent: false, message: 'That agent terminal is gone' }
    }
    const { accepted } = await orca.host.call('terminal.sendText', { terminalId, text: prompt, enter: true })
    return { sent: accepted, message: accepted ? `Sent ${prompt}` : 'Orca did not accept the text' }
  })
}

// The worker's logic. `register` takes the Io so tests can replace GitHub, git, npm and the updater.
import type { OrcaWorkerApi } from 'orca/worker'
import { defaultBranch, gatherFacts, type Io } from './facts'
import { parseRepo, projectDef, sameRepo, type ProjectDef } from './projects'
import type { Overall, ProjectStatus, StatusSnapshot } from './protocol'
import { classify, unknownStatus, type Facts, type View } from './status'

const FRESH_MS = 20_000
const OVERALL_KEY = 'overall'
const PROJECTS_KEY = 'projects'

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
  /** A terminal never changes workspace, so each is looked up once. */
  const terminalPaths = new Map<string, string>()
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
          return other && sameRepo(other, repo) ? w.branch : null
        })
    )
    const branches = [focused.branch, ...others].filter((b): b is string => Boolean(b))
    return { workspaceId: focused.id, repo, focusedBranch: focused.branch, branches: [...new Set(branches)] }
  }

  async function viewOf(repo: string, detected: Detected | null): Promise<View> {
    const fallback = await defaultBranchOf(repo)
    const options = [...new Set([...(detected?.branches ?? []), ...(fallback ? [fallback] : [])])]
    const picked = chosen.get(repo.toLowerCase())
    const branch = picked && options.includes(picked) ? picked : (detected?.focusedBranch ?? fallback ?? 'main')
    return { branch, branches: options.includes(branch) ? options : [...options, branch], detected: detected !== null }
  }

  async function look(def: ProjectDef, view: View, force: boolean): Promise<ProjectStatus> {
    const key = `${def.id.toLowerCase()}@${view.branch}`
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

  const savedRepos = async (): Promise<string[]> => ((await orca.storage.get(PROJECTS_KEY)) as string[] | null) ?? []

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
    const repos = [...(found ? [found.repo] : []), ...(await savedRepos())]
    const unique = repos.filter((repo, i) => repos.findIndex((other) => sameRepo(other, repo)) === i)
    const projects = await Promise.all(
      unique.map(async (repo) => {
        const owner = found && sameRepo(found.repo, repo) ? found : null
        return look(projectDef(repo), await viewOf(repo, owner), force)
      })
    )
    snapshot = {
      projects,
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
    chosen.set(projectId.toLowerCase(), branch)
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

  orca.panels.handle('project.remove', async ({ repo }) => {
    const saved = await savedRepos()
    await orca.storage.set(PROJECTS_KEY, saved.filter((other) => !sameRepo(other, repo)))
    await refresh(false)
    return { ok: true, message: `Removed ${repo}` }
  })

  orca.panels.handle('run.rerun', async ({ projectId, runId }) => {
    const project = snapshot?.projects.find((p) => p.id === projectId)
    // Only a failed run the panel listed for this project, never an id from elsewhere.
    if (!project?.runs.find((r) => r.id === runId)?.rerunnable) {
      return { ok: false, message: 'No failed run to re-run' }
    }
    try {
      await io.ghText(['run', 'rerun', String(runId), '-R', project.id, '--failed'])
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

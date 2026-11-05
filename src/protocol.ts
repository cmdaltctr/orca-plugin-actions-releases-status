// The panel <-> worker contract, declared once: src/panel.tsx and src/handlers.ts both read it.
export type StageState = 'done' | 'running' | 'idle' | 'blocked' | 'failed'
/** `blocked` means the next step is yours (approve, finalise). `unknown` means a lookup failed. */
export type Overall = 'ok' | 'running' | 'blocked' | 'failed' | 'unknown'

export interface Stage {
  id: string
  label: string
  state: StageState
  detail: string
  url?: string
}

export type RunState = 'running' | 'passed' | 'failed' | 'cancelled' | 'idle'
/** One check of the newest commit on a branch: a workflow job, or an outside check such as Codecov. */
export interface CheckRow {
  id: number
  name: string
  state: RunState
  /** The workflow run the check belongs to; null for a check outside GitHub Actions. */
  runId: number | null
  /** true for a failed or cancelled check of a workflow run: `run.rerun` can retry that run's failed jobs. */
  rerunnable: boolean
  url: string
}
/** The newest pull request whose head is the viewed branch, open, merged or closed. */
export interface BranchPr {
  number: number
  url: string
  title: string
  state: 'open' | 'merged' | 'closed'
}
/**
 * Where a worktree's pull request stands. `running`: checks still run, or it is a draft, has
 * conflicts, or GitHub has not said yet whether it can merge. `ready`: checks passed and it can merge.
 */
export type PrState = 'running' | 'ready' | 'failed' | 'merged' | 'closed'
/** The newest pull request of one local worktree of the focused project. */
export interface WorktreePr {
  /** The worktree's name in Orca. */
  worktree: string
  branch: string
  number: number
  url: string
  title: string
  state: PrState
  /** Why an open PR is not ready, in a few words; empty otherwise. */
  reason: string
}
/** What the user can set per project. Empty strings mean not set. */
/** The jobs of one release run that did not pass, so the reader can see what failed and retry it. */
export interface RunJobs {
  /** `Release run` or `Finalize run`. */
  label: string
  title: string
  url: string
  jobs: CheckRow[]
}

export interface ProjectSettings {
  /** Slash command that hands the release to an agent. Starts with `/`. */
  agentPrompt: string
  /** https URL that answers JSON with the `version` clients are served. Turns on the Updater stage. */
  updaterUrl: string
}

export interface ProjectStatus {
  /** The repository, `owner/name`. */
  id: string
  name: string
  /** true for the project of the focused workspace. */
  detected: boolean
  /** true when the branch is locked: the card stays on it when focus moves to another project. */
  locked: boolean
  /** true for a card opened from the PRs tab: one fixed branch, closed by the user. */
  opened: boolean
  /** true for the one pinned card: cards opened from the PRs tab sit under it. */
  pinned?: boolean
  /** `release` projects have a release flow and stages. `actions` projects show GitHub Actions only. */
  flow: 'release' | 'actions'
  /** The headline state: the release state for a `release` project, the Actions state otherwise. */
  overall: Overall
  /** One line: the first problem, else what is running, else the latest version. */
  summary: string
  /** One line on how the release flow was found, or that none was. */
  flowNote: string
  settings: ProjectSettings
  /** The state of the workflows on `branch`, whatever the flow. The Actions tab reads this. */
  actions: { overall: Overall; summary: string }
  /** Release stages. Empty for an `actions` project. */
  stages: Stage[]
  /** The jobs of each release run that has not passed. Empty when every release run passed. */
  releaseJobs: RunJobs[]
  /** The branch `runs` belong to. */
  branch: string
  /** Branches the panel can switch to: the git worktrees of this repository, then the default branch. */
  branches: string[]
  /** Checks of the newest commit on `branch`: failed first, then running, passed and skipped. */
  checks: CheckRow[]
  /** The pull request of `branch`; null when the branch has none or GitHub could not say. */
  branchPr: BranchPr | null
  /** The slash command that hands this project's release to an agent. */
  agentPrompt?: string
}

export interface StatusSnapshot {
  projects: ProjectStatus[]
  /** Cards opened from the PRs tab, oldest first. They last until closed or until Orca restarts. */
  opened: ProjectStatus[]
  /** The pull requests of the focused project's local worktrees. Worktrees with no PR are left out. */
  worktreePrs: WorktreePr[]
  /** Why no project was detected from the focused workspace. Unset when one was. */
  detectNote?: string
  /** When GitHub was last asked. */
  checkedAt: number
}

declare module 'orca' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginRequests {
    /** The last snapshot, or a fresh one when it is older than 20 seconds. */
    'status.get': { output: StatusSnapshot }
    /** Always looks again. */
    'status.refresh': { output: StatusSnapshot }
    /** Shows the runs of another branch of one project. */
    'branch.select': { input: { projectId: string; branch: string }; output: StatusSnapshot }
    /** Locks the branch now shown for a project, or unlocks it. A locked card stays on its branch and stays listed. */
    'branch.lock': { input: { projectId: string; locked: boolean }; output: StatusSnapshot }
    /** Opens a card on the Actions tab for the branch of a worktree the PRs tab listed. */
    'card.open': { input: { branch: string }; output: StatusSnapshot }
    /** Pins one listed project card, or unpins it. Pinning another card moves the pin. */
    'card.pin': { input: { projectId: string; pinned: boolean }; output: StatusSnapshot }
    /** Closes a card opened from the PRs tab. */
    'card.close': { input: { projectId: string; branch: string }; output: StatusSnapshot }
    /** Adds a repository (`owner/name` or a GitHub URL) after checking that `gh` can read it. */
    'project.add': { input: { repo: string }; output: { ok: boolean; message: string } }
    /** Saves the agent prompt and updater URL of one project the panel listed. Empty clears one. */
    'project.settings': {
      input: { projectId: string } & ProjectSettings
      output: { ok: boolean; message: string }
    }
    /** Removes an added repository. The detected project cannot be removed. */
    'project.remove': { input: { repo: string }; output: { ok: boolean; message: string } }
    /** `gh run rerun --failed` on one failed run listed for the project. */
    'run.rerun': { input: { projectId: string; runId: number }; output: { ok: boolean; message: string } }
    /** Types the project's agent prompt into an agent terminal and presses Enter. */
    'agent.ask': {
      input: { projectId: string; terminalId: string }
      output: { sent: boolean; message: string }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginPanelEvents {
    /** Posted after every look, so a second open panel stays in step. */
    'status.changed': StatusSnapshot
  }
}

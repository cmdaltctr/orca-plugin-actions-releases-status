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

export type RunState = 'running' | 'passed' | 'failed' | 'idle'
/** One workflow run in the "Recent runs" list. */
export interface RunRow {
  id: number
  workflow: string
  title: string
  state: RunState
  /** true for a completed failed run that `run.rerun` can retry. */
  rerunnable: boolean
  url: string
}
export interface ProjectStatus {
  /** The repository, `owner/name`. */
  id: string
  name: string
  /** true for the project of the focused workspace. */
  detected: boolean
  /** `release` projects have a release flow and stages. `actions` projects show GitHub Actions only. */
  flow: 'release' | 'actions'
  /** The headline state: the release state for a `release` project, the Actions state otherwise. */
  overall: Overall
  /** One line: the first problem, else what is running, else the latest version. */
  summary: string
  /** The state of the workflows on `branch`, whatever the flow. The Actions tab reads this. */
  actions: { overall: Overall; summary: string }
  /** Release stages. Empty for an `actions` project. */
  stages: Stage[]
  /** The branch `runs` belong to. */
  branch: string
  /** Branches the panel can switch to: the git worktrees of this repository, then the default branch. */
  branches: string[]
  /** Every workflow's runs on `branch`, newest first. */
  runs: RunRow[]
  /** The slash command that hands this project's release to an agent. */
  agentPrompt?: string
}

export interface StatusSnapshot {
  projects: ProjectStatus[]
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
    /** Adds a repository (`owner/name` or a GitHub URL) after checking that `gh` can read it. */
    'project.add': { input: { repo: string }; output: { ok: boolean; message: string } }
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

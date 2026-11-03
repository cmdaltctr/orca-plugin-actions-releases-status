// Any GitHub repository can be shown. The plugin looks at the repository on GitHub for a release flow:
//  - release-please-npm: release-please files and an npm package. A release-please PR, then a Release
//    run stages an npm version that the maintainer approves with 2FA.
//  - release-please: the same without an npm package; the stages end at the GitHub release.
//  - release-workflow: a workflow named "Release" on the release branch, then a GitHub release.
//  - release-workflow-desktop: as above, plus an updater endpoint the user set. A "Finalize Desktop
//    Release" run publishes the binary there.
import type { ProjectSettings } from './protocol'

export type Kind = 'release-please-npm' | 'release-please' | 'release-workflow' | 'release-workflow-desktop'

/** The branch the release workflows run on. */
export const RELEASE_BRANCH = 'main'

/** What the repository itself shows about its release flow. */
export interface DetectedFlow {
  kind: 'release-please-npm' | 'release-please' | 'release-workflow'
  npmPackage?: string
}

export interface ProjectDef {
  /** The repository, `owner/name`. */
  id: string
  name: string
  repo: string
  /** Absent for a repository with no release flow: it shows GitHub Actions only. */
  kind?: Kind
  /** npm package whose `latest` dist-tag must reach the newest GitHub release. */
  npmPackage?: string
  /** The release-please PR's head branch starts with this. */
  releasePrBranch?: string
  /** Returns JSON with the `version` clients are served. */
  updaterUrl?: string
  /** Slash command that hands the release to an agent. */
  agentPrompt?: string
  /** The saved values, set or not. */
  settings: ProjectSettings
}

export const NO_SETTINGS: ProjectSettings = { agentPrompt: '', updaterUrl: '' }

export const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** An updater URL turns a repository with no flow, or a Release workflow, into a desktop flow. */
function kindOf(flow: DetectedFlow | null, updaterUrl: string): Kind | undefined {
  if (updaterUrl && (!flow || flow.kind === 'release-workflow')) {
    return 'release-workflow-desktop'
  }
  return flow?.kind
}

export function projectDef(repo: string, flow: DetectedFlow | null, settings: ProjectSettings = NO_SETTINGS): ProjectDef {
  const kind = kindOf(flow, settings.updaterUrl)
  return {
    id: repo,
    name: repo.split('/')[1] ?? repo,
    repo,
    settings,
    ...(kind ? { kind } : {}),
    ...(flow?.npmPackage ? { npmPackage: flow.npmPackage } : {}),
    ...(kind?.startsWith('release-please') ? { releasePrBranch: 'release-please--branches--' } : {}),
    ...(kind === 'release-workflow-desktop' ? { updaterUrl: settings.updaterUrl } : {}),
    ...(settings.agentPrompt ? { agentPrompt: settings.agentPrompt } : {})
  }
}

const PLAIN = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/
const GITHUB_URL = /^(?:git@github\.com:|(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/

/** `owner/name` from a GitHub remote URL or from `owner/name` itself; null for anything else. */
export function parseRepo(text: string): string | null {
  const trimmed = text.trim()
  const candidate = GITHUB_URL.exec(trimmed)?.[1] ?? trimmed
  return PLAIN.test(candidate) ? candidate : null
}

/** A settings problem in words, or null when the values can be saved. */
export function settingsProblem(settings: ProjectSettings): string | null {
  const { agentPrompt, updaterUrl } = settings
  if (agentPrompt && (!agentPrompt.startsWith('/') || agentPrompt.length > 200 || /[\r\n]/.test(agentPrompt))) {
    return 'The agent prompt must start with / and fit on one line'
  }
  if (updaterUrl) {
    try {
      if (new URL(updaterUrl).protocol !== 'https:' || updaterUrl.length > 300) {
        return 'The updater URL must be an https URL'
      }
    } catch {
      return 'The updater URL must be an https URL'
    }
  }
  return null
}

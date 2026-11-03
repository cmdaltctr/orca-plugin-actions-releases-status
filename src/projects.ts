// Any GitHub repository can be shown. A repository that has a release flow below also gets release stages.
//  - release-please-npm: a release-please PR, then a Release run stages an npm version that the
//    maintainer approves with 2FA.
//  - semantic-release: a Release run on `main` tags and creates the GitHub Release.
//  - semantic-release-desktop: as above, then a Mac-built binary is published to the updater
//    endpoint by a "Finalize Desktop Release" run.
export type Kind = 'release-please-npm' | 'semantic-release' | 'semantic-release-desktop'

/** The branch the release workflows run on. */
export const RELEASE_BRANCH = 'main'

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
}

type ReleaseFlow = Omit<ProjectDef, 'id' | 'repo'>

/**
 * Release flows, keyed by lower-case `owner/name`. Empty by default: add your own here and the Releases
 * tab shows that repository's stages. For example:
 *
 *   'acme/widget': { name: 'Widget', kind: 'release-please-npm', npmPackage: 'widget',
 *     releasePrBranch: 'release-please--branches--main', agentPrompt: '/release-widget' }
 */
export const RELEASE_FLOWS: Record<string, ReleaseFlow> = {}

export const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export function projectDef(repo: string): ProjectDef {
  const flow = RELEASE_FLOWS[repo.toLowerCase()]
  return { name: repo.split('/')[1] ?? repo, ...flow, id: repo, repo }
}

const PLAIN = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/
const GITHUB_URL = /^(?:git@github\.com:|(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/

/** `owner/name` from a GitHub remote URL or from `owner/name` itself; null for anything else. */
export function parseRepo(text: string): string | null {
  const trimmed = text.trim()
  const candidate = GITHUB_URL.exec(trimmed)?.[1] ?? trimmed
  return PLAIN.test(candidate) ? candidate : null
}

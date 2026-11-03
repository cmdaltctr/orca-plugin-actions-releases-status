# Actions and Releases Status

An Orca right-sidebar panel that shows GitHub Actions and release state for the project you are working in.

Orca's own Checks panel follows the workspace you have open. This panel also lets you look at another branch from where you are. Work in `main`, pick `v3`, and read the Actions of `v3`.

## Which projects it shows

1. **This project** comes first. The panel reads the focused workspace, finds its GitHub `origin` remote and shows that repository. When focus moves to another project, this card changes with it.
2. **Added projects** come after. Type `owner/name` or a GitHub URL in **Add a project**. The plugin checks that `gh` can read the repository, then stores it. The remove button on a card drops it.

Many workspaces share the name and branch `main`. The plugin asks Orca's CLI (`orca terminal list`) which workspace owns the focused terminal. If the CLI is not found, it falls back to matching branch and name, and says so when that is ambiguous.

## Two tabs

- **Actions** (opens first): every project with its workflows, branch picker, retry buttons, remove buttons and the **Add a project** card.
- **Releases**: only projects with a release flow, with their stages, release state and **Ask agent**. Other projects are named in a one-line note.

## What each card shows

- **GitHub Actions**: the latest runs of every workflow on one branch. A spinner marks a queued or running run. A failed run has a retry button that runs `gh run rerun --failed` on that run. Click a run to open it on GitHub.
- **Branch picker**: lists the branches of your local checkouts of the same repository (every Orca worktree), then the default branch. The pick resets when you focus another workspace.
- **State**: **Passing**, **Running** or **Failing**, from the newest run of each workflow on the shown branch.

## Release flows

The plugin ships with no release flows. A repository with a flow shows stages in the Releases tab and gets a release badge: **Up to date**, **In progress**, **Needs you** or **Failed**. Stages always read the `main` branch, whatever branch the Actions list shows.

Add a flow in `src/projects.ts`, in `RELEASE_FLOWS`. The key is the lower-case `owner/name`.

```ts
export const RELEASE_FLOWS: Record<string, ReleaseFlow> = {
  'acme/widget': {
    name: 'Widget',
    kind: 'release-please-npm',
    npmPackage: 'widget',
    releasePrBranch: 'release-please--branches--main--components--widget',
    agentPrompt: '/release-widget'
  }
}
```

| `kind` | Stages shown | Extra fields |
| --- | --- | --- |
| `release-please-npm` | Release PR, Release run, npm | `npmPackage`, `releasePrBranch` |
| `semantic-release` | Release run, GitHub release | none |
| `semantic-release-desktop` | Release run, GitHub release, Updater | `updaterUrl` (JSON with a `version`) |

The release run is the newest workflow named `Release` on `main`. A desktop flow also reads the newest run named `Finalize Desktop Release`.

**Needs you** means the next step is yours, for example approving a staged npm version.

## What it does

- Looks again every minute while the panel tab is open, on **Refresh**, and when the focused workspace changes.
- Sends a desktop notification when a release project newly needs you or newly fails. Other projects never notify.
- **Ask agent** types the flow's `agentPrompt` slash command into an agent terminal you pick. It never merges or approves anything itself.

## Needs

- Orca 1.4.246 or later.
- The `gh` CLI, signed in as a user who can read the repositories. The plugin reads no token.
- The `workspace:read` capability, which Orca asks you to approve.
- Local workspaces only. A workspace on an SSH host is not detected.

## Develop

```sh
orca plugin test .       # unit tests, no Orca window
orca plugin check .      # renders the panel once
orca plugin dev watch .  # loads it into Orca; prints the approval command on first load
```

## Not included

An always-visible status bar item. The panel looks again only while its tab is open.

## Licence

MIT. See [LICENSE](./LICENSE).

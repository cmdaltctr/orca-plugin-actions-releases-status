# PRs, Actions and Releases Status

Shows the pull requests, GitHub Actions checks and release state of the project in your focused Orca workspace. It is for developers who ship from GitHub. Read the checks of any branch or added repository, re-run failed checks, and ask an agent to take over a release.

## Install

1. In Orca, open **Settings → Plugins**.
2. Choose **Add plugin**, then **From a Git URL…**.
3. Paste this URL and choose **Install**: `https://github.com/cmdaltctr/orca-plugin-prs-actions-releases-status#v0.1.0`
4. Read the access list that Orca shows, then enable the plugin.
5. Sign in to the `gh` CLI on your machine: `gh auth login`.

When the plugin is in the [Orca plugin directory](https://www.onorca.dev/plugins/cmdaltctr/orca-plugin-prs-actions-releases-status), you can also install it from there.

### Access the plugin asks for

The plugin runs its own code in a separate Node.js process with your user account's access (a `trusted-worker`). It asks Orca for these capabilities:

| Capability | Used for |
| --- | --- |
| `workspace:read` | Read the name, branch and terminals of the focused workspace. |
| `storage:own` | Save locks, the pins, added projects and settings in the plugin's own storage. |
| `notifications:show` | Send a desktop notification when a release needs you or fails. |
| `agent:read` | Read agent status, to list the agent terminals you can pick. |
| `terminal:send` | Type your release slash command into the agent terminal you pick. |

It also runs the `gh`, `git` and `orca` commands on your machine. It asks the npm registry for the latest version of a public package, and your own updater URL if you set one. It reads no GitHub token and sends no data about you anywhere.

Orca's own Checks panel follows the workspace you have open. This panel also lets you look at another branch from where you are. Work in `main`, pick `v3`, and read the checks of `v3`.

## Which projects it shows

1. **This project** comes first. The panel reads the focused workspace, finds its GitHub `origin` remote and shows that repository. When focus moves to another project, this card changes with it, unless you locked its branch.
2. **Added projects** come after. Type `owner/name` or a GitHub URL in **Add a project**. The plugin checks that `gh` can read the repository, then stores it. The remove button on a card drops it.

Many workspaces share the name and branch `main`. The plugin asks Orca's CLI (`orca terminal list`) which workspace owns the focused terminal. If the CLI is not found, it falls back to matching branch and name, and says so when that is ambiguous.

## Three tabs

- **PRs**: the pull requests of the focused project's local worktrees, by worktree name.
- **Actions** (opens first): every project with the checks of one branch, the branch picker, retry buttons, remove buttons and the **Add a project** card.
- **Releases**: every project with its release stages and state, or a note on what was looked for when no release flow was found. Each card has optional **Settings**.

## PRs tab

The plugin lists every Orca worktree of the focused project. A worktree shows when its branch has a pull request, open, merged or closed. The row shows a coloured dot, the worktree name and a badge in the same colour: **Running**, **Ready**, **Failed**, **Merged** or **Closed**. Hover the name to read the state, the reason and the PR title.

| Dot | Meaning |
| --- | --- |
| 🟠 orange | Checks still run, or the PR is a draft, has merge conflicts, or GitHub has not yet said if it can merge. |
| 🟢 green | Ready to merge: every check passed and the PR can merge. Reviews are not read. |
| 🔴 red | A check failed. |
| 🟣 purple | The PR was merged. Orca's components have no purple tone, so a purple emoji carries the colour. |
| ⚪ grey | The PR was closed without a merge. |

- Click the worktree name to open its card on the Actions tab, below the other cards. The card shows the checks of that branch, with retry buttons. Its X closes it. Opened cards go when Orca restarts.
- Click the open button to open the PR on GitHub.
- A worktree you delete leaves the list. Its opened card closes, and a lock on its branch is released, so that card goes back to the focused branch. A lock on the default branch, or on a project with no local worktree, stays.

## Actions tab

- **Checks**: the checks of the newest commit on the shown branch. They are the workflow jobs, such as `test (ubuntu-latest)`, and outside checks, such as Codecov. Failed checks come first, then running, passed and skipped. The first eight show; the rest fold into one row.
- **PR**: the newest pull request whose head is the shown branch, on one line: `PR #237: fix(web): say when memory...` and a state badge (open, merged or closed). A long title is cut with three dots; hover the line for the full title. Click it to open the PR. Both tabs show it. It changes when you pick another branch. A branch with no pull request says "No PR for <branch>".
- **Retry**: a failed or cancelled check of a GitHub Actions run has a retry button. It runs `gh run rerun --failed` on that run. A failed check from outside GitHub Actions, such as Codecov, has no retry. It has an info icon instead: hover over it to read `Not a GitHub Actions job, cannot re-run.` Click a check to open it on GitHub.
- **Branch picker**: lists the branches of your local checkouts of the same repository (every Orca worktree), then the default branch. The pick resets when you focus another workspace.
- **Lock branch**: each card has a switch. Hover the ⓘ icon beside it to see what the lock does. Turn it on and the card keeps its project and branch when you focus a workspace of another project, and it stays listed. The badge reads **Locked** or **Unlocked**. Picking another branch while locked moves the lock to it. Turn the switch off to follow the focused workspace again. A card that was listed only because of its lock then disappears. The lock is stored on your machine and survives a restart.
- **Pin**: every card has a pin button, also an opened card and a worktree card. It is a star, as in the OpenSpec plugin. The star has an outline when the card is pinned. Pinned cards form a **Pinned** group above the other cards. You can pin as many cards as you like. A card opened from the PRs tab sits under the card of its own project. Pins are stored on your machine and survive a restart. A pin from an earlier version (one pinned project) is not carried over: pin the card again.
- **State**: **Passing**, **Running** or **Failing**, from those checks.
- **This worktree and All worktrees**: when the focused project has two or more worktrees, two tabs appear at the top of the Actions tab. **This worktree** shows the project cards, as before. **All worktrees** shows one card per worktree branch of the focused project, the focused worktree first and marked **This worktree**. Each card shows the checks of that branch. A **Show worktree** select narrows the list to one worktree. These cards have a pin button and no lock, branch picker or close button.
- **Search, state filter and sort**: above the cards, in both tabs. **Search cards** keeps the cards whose project, branch or worktree name holds the text, in any case. **Show state** keeps only failing, running or passing cards. **Sort cards** orders them: default order, failing first, passing first, name A to Z or name Z to A. Pinned cards stay above the rest. A line reads "Showing 2 of 4 cards" while a filter hides some.

## Releases tab

The plugin looks at the repository on GitHub. It needs no setup and no list of projects.

| Found in the repository | Flow | Stages |
| --- | --- | --- |
| `release-please-config.json` or `.release-please-manifest.json`, and a public `package.json` | release-please and npm | Release PR, Release run, npm |
| The same files, no public npm package | release-please | Release PR, Release run, GitHub release |
| A workflow named `Release` | Release workflow | Release run, GitHub release |
| None of these | no release flow | The card says what was looked for |

When a release run has not passed, its card lists that run's jobs under the stages, failed and cancelled first. A failed or cancelled job has a retry button that runs `gh run rerun --failed` on the run. A run that passed lists no jobs. A desktop flow lists the jobs of the `Finalize Desktop Release` run the same way.

Stages read the `main` branch, whatever branch the Actions tab shows. The release run is the newest run of the `Release` workflow on `main`. The badge is **Up to date**, **In progress**, **Needs you** or **Failed**. **Needs you** means the next step is yours, for example approving a staged npm version.

### Settings

Each card on the Releases tab has an optional **Settings** section. The values stay in the plugin's own storage on your machine.

- **Agent prompt**: a slash command, on one line, that starts with `/`. **Ask agent** types it into an agent terminal you pick when a release needs you. It never merges or approves anything itself.
- **Updater URL**: an https URL that answers JSON with a `version`. It adds an **Updater** stage for a desktop app: the newest GitHub release must carry a binary, and the endpoint must serve that version. The plugin then also reads the newest `Finalize Desktop Release` run.

## What it does

- Looks again every minute while the panel tab is open, on **Refresh**, and when the focused workspace changes.
- Sends a desktop notification when a project with a release flow newly needs you or newly fails. Other projects never notify.

## Needs

- Orca 1.4.246 or later.
- The `gh` CLI, signed in as a user who can read the repositories. The plugin reads no token.
- The `workspace:read` capability, which Orca asks you to approve.
- Local workspaces only. A workspace on an SSH host is not detected.

## Limits

- A check has no expandable steps. Click it to open the run on GitHub.
- The checks come from the newest commit of a branch. A branch with no workflow runs shows no checks.
- Always-visible status bar item: not included. The panel looks again only while its tab is open.

## Develop

```sh
orca plugin test .       # unit tests, no Orca window
orca plugin check .      # renders the panel once
orca plugin dev watch .  # loads it into Orca; prints the approval command on first load
```

## Licence

MIT. See [LICENSE](./LICENSE).

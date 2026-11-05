# AGENTS.md

An Orca right-sidebar plugin. It shows the pull requests, GitHub Actions checks and release state of the project in the focused Orca workspace. `README.md` describes what the user sees. This file holds the rules for changing the code.

## Commands

```sh
orca plugin test .         # unit tests, no Orca window
orca plugin check .        # renders the panel once
orca plugin dev reload .   # loads the change into the running Orca
```

- Put a time limit on test runs: `timeout 90 orca plugin test .`. A panel test that looks for an element the panel does not draw can hang the run.
- `orca plugin types .` can fail on an installed Orca. The typings for the component kit are in the Orca source checkout: `../../orca/resources/plugins/declarative/orca-components*.d.ts`.

## Files

| File | Does |
| --- | --- |
| `src/protocol.ts` | The panel to worker contract: request names, `StatusSnapshot`, `ProjectStatus`, `WorktreePr`. Change it first. |
| `src/handlers.ts` | The worker: detects the focused project, reads GitHub, holds locks, the pin and opened cards. |
| `src/facts.ts` | Every `gh`, git, npm and HTTP call, behind the `Io` interface. |
| `src/status.ts` | Pure rules: run and check states, release stages, `prState` for the PRs tab. |
| `src/projects.ts` | Release flow detection, repository parsing, settings checks. |
| `src/panel.tsx` | The panel: the PRs, Actions and Releases tabs. |
| `src/tests/*.test.ts(x)` | All tests, one file per source file: `handlers.test.ts`, `status.test.ts`, `panel.test.tsx`. They import from `../`. |
| `src/panel.check.ts` | Scenarios for `orca plugin check`. It must stay next to `panel.tsx`; Orca does not find it in `src/tests/`. |

## Colour convention

Use these colours everywhere a state shows: badges, dots and PR lines.

| State | Colour | Kit value |
| --- | --- | --- |
| Running, in progress, unlocked | orange | `tone="warning"` |
| Passed, ready to merge, locked, open PR | green | `tone="success"` |
| Failed | red | `tone="danger"` |
| Merged | purple | `🟣` emoji in a `neutral` badge or muted text |
| Closed, skipped, no data | grey | `tone="neutral"` or `muted` |

- Do not use `accent` for a state. It draws the theme colour, which is green in the user's theme, so it looks like "passed".
- A PR state shows as a coloured dot plus a badge of the same colour. The words are `Running`, `Ready`, `Failed`, `🟣 Merged`, `Closed`.

## Orca component kit limits

The kit is fixed. Check these before you promise a look to the user.

- Five tones only: `neutral`, `accent`, `success`, `warning`, `danger`. There is no purple and no blue.
- An `IconButton` uses `tone` for `danger` only. Other tones have no effect on it. A `Button` cannot take a text colour.
- There is no pull-request, pin or lock icon. The icon list is in `IconName` in the typings.
- When the kit cannot draw something, use an emoji or a word, and tell the user why. Pin: `📌` when unpinned, `🎯 Pinned` when pinned.
- A `Switch` always has 12px of space before it, for its label. The panel hides the label with a zero-width space. To make the gaps on both sides of a switch equal, use `gap="sm"` after it, because a ghost button adds 8px of its own padding.
- Gaps: `xs` 4px, `sm` 8px, `md` 12px, `lg` 16px.
- Give `wrap` to every `Row` that holds badges, a PR line or buttons. Without it the row overflows on a narrow panel.
- `Text` can take a tone, so a coloured `●` is the way to draw a status dot.

## Behaviour patterns

- One card per project, keyed by repository. Cards opened from the PRs tab are keyed by repository and branch.
- An opened card sits under the pinned card. With no pin, it sits under its own project's card. Opened cards live in worker memory and go when Orca restarts.
- Lock and pin are saved in plugin storage (`locks`, `pin`). One card is pinned at a time.
- Each look first drops what a deleted worktree left behind (`dropDeletedWorktrees`): its opened card and a lock on its branch. It keeps a lock on the default branch and on a project with no local worktree. It does nothing when `workspace.list` is truncated.
- A handler acts only on what the last snapshot listed: a project, a branch or a run id. It never acts on an id the panel did not show.
- A failed GitHub read keeps the last answer. It does not clear the list.
- Release stages always read `main`, whatever branch the Actions tab shows.

## Tests

- Write the test first and see it fail. Then write the code.
- After a change, break the code on purpose and check that the new test fails. A test that passes on broken code is worse than none.
- Put new tests in `src/tests/`, never next to the source files.
- Worker tests use `fakeIo` and `hostFor` in `src/tests/handlers.test.ts`. Read storage with `host.data().storage`. The object you pass to `hostFor` is copied, so your own copy does not change.
- Panel tests stub each request in `host()` in `src/tests/panel.test.tsx`. Add a stub for every new request.

## Writing

- British English in docs, comments and UI text.
- Short, plain UI text: `Checks on main`, `No PR for main`.
- Update `README.md` in the same change as the feature.
- Conventional Commits: `feat:`, `fix:`, `docs:`.
- Commit and push only when the user asks.

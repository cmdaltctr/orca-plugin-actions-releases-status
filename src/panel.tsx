// No build step: Orca strips the types and compiles the JSX when it loads.
import {
  atom,
  Badge,
  Button,
  Card,
  Collapsible,
  EmptyState,
  Heading,
  host,
  IconButton,
  Input,
  List,
  ListItem,
  on,
  plugin,
  read,
  Row,
  Select,
  set,
  shell,
  Link,
  Spinner,
  Stack,
  Switch,
  Tab,
  Tabs,
  Text,
  type PanelContext
} from 'orca'
import type { CheckRow, Overall, PrState, ProjectSettings, ProjectStatus, StageState, StatusSnapshot, WorktreePr } from './protocol'

const POLL_MS = 60_000
const REQUEST = { timeoutMs: 60_000 }

const snapshot = atom<StatusSnapshot | null>(null)
const problem = atom<string | null>(null)
const notice = atom<string | null>(null)
const agentOptions = atom<{ value: string; label: string }[]>([])
const agentChoice = atom('')
const draft = atom('')
type View = 'prs' | 'actions' | 'releases'
const view = atom<View>('actions')
/** Unsaved edits of the Settings fields, by project. */
const settingsDraft = atom<Record<string, Partial<ProjectSettings>>>({})
/** Value of "everything" in the state and worktree filters. */
const EVERY = 'every'
/** 'here' shows the project cards; 'all' shows one card per worktree branch of the focused project. */
const scope = atom('here')
/** Worktree name the All worktrees scope shows; EVERY shows them all. */
const worktreeShown = atom(EVERY)
/** Search text; a card shows when its project, branch or worktree name holds it, in any case. */
const query = atom('')
/** Actions state the cards are filtered to; EVERY shows them all. */
const stateShown = atom(EVERY)
/** How the cards are ordered; 'default' keeps the order the worker gave. */
const sortBy = atom('default')

/** Orca needs a non-empty Switch label; this one shows nothing. */
const ZERO_WIDTH = '\u200b'
const TONE = { ok: 'success', running: 'accent', blocked: 'warning', failed: 'danger', unknown: 'neutral' } as const
const RELEASE_WORDS: Record<Overall, string> = {
  ok: 'Up to date',
  running: 'In progress',
  blocked: 'Needs you',
  failed: 'Failed',
  unknown: 'Unknown'
}
const ACTIONS_WORDS: Record<Overall, string> = {
  ok: 'Passing',
  running: 'Running',
  blocked: 'Needs you',
  failed: 'Failing',
  unknown: 'Unknown'
}
/** Merged is purple, and Orca's kit has no purple tone: this emoji carries the colour. */
const PURPLE = '🟣'
const ICON: Record<StageState, string> = { done: 'check', running: 'refresh', idle: 'info', blocked: 'warning', failed: 'error' }

async function show(task: () => Promise<StatusSnapshot>): Promise<void> {
  try {
    set(snapshot, await task())
    set(problem, null)
  } catch (error) {
    set(problem, error instanceof Error ? error.message : String(error))
  }
}

const load = (fresh = false) => show(() => plugin.request(fresh ? 'status.refresh' : 'status.get', undefined, REQUEST))
const selectBranch = (projectId: string, branch: string) =>
  show(() => plugin.request('branch.select', { projectId, branch }, REQUEST))
const openCard = async (branch: string): Promise<void> => {
  set(view, 'actions')
  await show(() => plugin.request('card.open', { branch }, REQUEST))
}
/** An opened or worktree card is pinned by its branch; a project card by its repository alone. */
const pinCard = (card: ProjectStatus, pinned: boolean) =>
  show(() => plugin.request('card.pin', { projectId: card.id, ...(card.opened || card.worktree ? { branch: card.branch } : {}), pinned }, REQUEST))
const closeCard = (projectId: string, branch: string) =>
  show(() => plugin.request('card.close', { projectId, branch }, REQUEST))

async function loadAgents(): Promise<void> {
  try {
    const { agents } = await host.call('agents.list')
    const options = agents.flatMap((agent) =>
      agent.terminalId ? [{ value: agent.terminalId, label: `${agent.title ?? agent.terminalId} (${agent.state})` }] : []
    )
    set(agentOptions, options)
    if (!options.some((option) => option.value === read(agentChoice))) {
      set(agentChoice, '')
    }
  } catch {
    set(agentOptions, [])
  }
}

async function act(task: () => Promise<{ message: string }>): Promise<void> {
  try {
    set(notice, (await task()).message)
  } catch (error) {
    set(notice, error instanceof Error ? error.message : String(error))
  }
}

/** A worktree card is locked by its branch; a project card by its repository alone. */
const lockBranch = (card: ProjectStatus, locked: boolean) =>
  show(() => plugin.request('branch.lock', { projectId: card.id, ...(card.worktree ? { branch: card.branch } : {}), locked }, REQUEST))
const lockHelp = (card: ProjectStatus): string =>
  card.worktree
    ? 'Lock: keep this card in All worktrees when you focus another project.'
    : `Lock: keep this card on ${card.branch} when you focus another project.`
const rerun = (projectId: string, runId: number) =>
  act(() => plugin.request('run.rerun', { projectId, runId }, REQUEST))
const addProject = () =>
  act(async () => {
    const answer = await plugin.request('project.add', { repo: read(draft) }, REQUEST)
    if (answer.ok) {
      set(draft, '')
    }
    return answer
  })
const removeProject = (repo: string) => act(() => plugin.request('project.remove', { repo }, REQUEST))
const editSettings = (projectId: string, patch: Partial<ProjectSettings>) =>
  set(settingsDraft, { ...read(settingsDraft), [projectId]: { ...read(settingsDraft)[projectId], ...patch } })
const saveSettings = (project: ProjectStatus) =>
  act(async () => {
    const edits = read(settingsDraft)[project.id]
    const answer = await plugin.request(
      'project.settings',
      {
        projectId: project.id,
        agentPrompt: edits?.agentPrompt ?? project.settings.agentPrompt,
        updaterUrl: edits?.updaterUrl ?? project.settings.updaterUrl
      },
      REQUEST
    )
    if (answer.ok) {
      const { [project.id]: _saved, ...rest } = read(settingsDraft)
      set(settingsDraft, rest)
    }
    return answer
  })
const ask = (projectId: string) =>
  act(() => plugin.request('agent.ask', { projectId, terminalId: read(agentChoice) }, REQUEST))

/** Runs once before the first render. The panel keeps polling while its tab stays open. */
export function setup(ctx: PanelContext): void {
  void load()
  void loadAgents()
  const timer = setInterval(() => void load(), POLL_MS)
  ctx.subscriptions.push(
    plugin.on('status.changed', (next) => set(snapshot, next)),
    on('agent.status.changed', () => void loadAgents()),
    // The panel follows the focused workspace, so a new focus means a new detected project.
    on('workspace.changed', () => void load()),
    { dispose: () => clearInterval(timer) }
  )
}

const CHECK_BADGE = {
  passed: ['success', 'Passed'],
  failed: ['danger', 'Failed'],
  cancelled: ['warning', 'Cancelled'],
  idle: ['neutral', 'Skipped']
} as const
/** Checks shown before the rest fold into one "more" row. */
const CHECKS_SHOWN = 8

function CheckLine({ project, check }: { project: ProjectStatus; check: CheckRow }) {
  return (
    <Row gap="xs" align="center" justify="between">
      <Row gap="xs" align="center">
        {check.state === 'running' ? (
          <Spinner label={`Running: ${check.name}`} labelHidden />
        ) : (
          <Badge tone={CHECK_BADGE[check.state][0]}>{CHECK_BADGE[check.state][1]}</Badge>
        )}
        <Text truncate>
          <Link href={check.url}>{check.name}</Link>
        </Text>
      </Row>
      {check.rerunnable && check.runId !== null ? (
        <IconButton
          icon="refresh"
          label={`Re-run failed jobs: ${check.name}`}
          variant="ghost"
          onPress={() => void rerun(project.id, check.runId as number)}
        />
      ) : null}
      {(check.state === 'failed' || check.state === 'cancelled') && check.runId === null ? (
        <IconButton
          icon="info"
          label={`${check.name}: ${NOT_ACTIONS}`}
          tooltip={NOT_ACTIONS}
          variant="ghost"
        />
      ) : null}
    </Row>
  )
}

/** Shown on a failed check from outside GitHub Actions, such as Codecov: `gh run rerun` has no run to retry. */
const NOT_ACTIONS = 'Not a GitHub Actions job, cannot re-run.'

/** Longest title shown on the PR line. Orca's Button does not clip text, so the cut happens here. */
const PR_TITLE_SHOWN = 26

const shorten = (title: string): string => (title.length > PR_TITLE_SHOWN ? `${title.slice(0, PR_TITLE_SHOWN).trimEnd()}...` : title)

/** The PR of the viewed branch on one line. The full title shows on hover and the button opens the PR. */
function BranchPrLine({ project }: { project: ProjectStatus }) {
  const pr = project.branchPr
  if (!pr) {
    return <Text muted size="xs">{`No PR for ${project.branch}`}</Text>
  }
  return (
    <Row gap="xs" align="center" wrap>
      <Button
        variant="ghost"
        size="xs"
        tooltip={`#${pr.number} ${pr.title}`}
        onPress={() => void shell.openExternal(pr.url)}
      >
        {`PR #${pr.number}: ${shorten(pr.title)}`}
      </Button>
      <Badge tone={pr.state === 'open' ? 'success' : 'neutral'}>{pr.state === 'merged' ? `${PURPLE} merged` : pr.state}</Badge>
    </Row>
  )
}

/** The Actions tab: the checks of one branch's newest commit, with the branch picker and project controls. */
/** The star, as in the OpenSpec plugin: `outline` when pinned, `ghost` when not. Any card can be pinned. */
function PinButton({ project }: { project: ProjectStatus }) {
  const name = project.opened || project.worktree ? `${project.id} ${project.branch}` : project.id
  return (
    <IconButton
      icon="star"
      label={`${project.pinned ? 'Unpin' : 'Pin'} ${name}`}
      tooltip={project.pinned ? 'Pinned to the top. Press to unpin.' : 'Pin to the top'}
      variant={project.pinned ? 'outline' : 'ghost'}
      size="xs"
      onPress={() => void pinCard(project, !project.pinned)}
    />
  )
}

function ActionsCard({ project }: { project: ProjectStatus }) {
  return (
    <Card title={project.name} description={project.actions.summary}>
      <Stack gap="sm">
        <Row gap="xs" align="center" justify="between">
          <Row gap="xs" align="center" wrap>
            <Badge tone={TONE[project.actions.overall]}>{ACTIONS_WORDS[project.actions.overall]}</Badge>
            {project.worktree ? <Badge tone="neutral">{project.worktree}</Badge> : null}
            {project.detected ? <Badge tone="neutral">{project.worktree ? 'This worktree' : 'This project'}</Badge> : null}
            {project.opened ? (
              <>
                <Badge tone="neutral">{project.branch}</Badge>
                <PinButton project={project} />
              </>
            ) : (
              <>
                <Badge tone={project.locked ? 'success' : 'warning'}>{project.locked ? 'Locked' : 'Unlocked'}</Badge>
                {/* Orca puts 12px before a switch for its hidden label; `sm` plus the button's 8px padding matches it after. */}
                <Row gap="sm" align="center" wrap>
                  <Switch
                    label={ZERO_WIDTH}
                    checked={project.locked}
                    onChange={(value) => void lockBranch(project, value)}
                  />
                  <IconButton
                    icon="info"
                    label={lockHelp(project)}
                    tooltip={lockHelp(project)}
                    variant="ghost"
                  />
                  <PinButton project={project} />
                </Row>
              </>
            )}
          </Row>
          {project.opened ? (
            <IconButton
              icon="close"
              label={`Close ${project.name} ${project.branch}`}
              variant="ghost"
              onPress={() => void closeCard(project.id, project.branch)}
            />
          ) : project.detected || project.worktree ? null : (
            <IconButton
              icon="close"
              label={`Remove ${project.name}`}
              variant="ghost"
              onPress={() => void removeProject(project.id)}
            />
          )}
        </Row>
        {project.branches.length > 1 && !project.opened ? (
          <Select
            label={`Branch of ${project.name}`}
            labelHidden
            value={project.branch}
            options={project.branches.map((branch) => ({ value: branch, label: branch }))}
            onChange={(value) => void selectBranch(project.id, value)}
          />
        ) : null}
        <BranchPrLine project={project} />
        <Stack gap="xs">
          <Text muted size="xs">{`Checks on ${project.branch}`}</Text>
          {project.checks.slice(0, CHECKS_SHOWN).map((check) => (
            <CheckLine key={check.id} project={project} check={check} />
          ))}
          {project.checks.length > CHECKS_SHOWN ? (
            <Collapsible title={`${project.checks.length - CHECKS_SHOWN} more checks`}>
              <Stack gap="xs">
                {project.checks.slice(CHECKS_SHOWN).map((check) => (
                  <CheckLine key={check.id} project={project} check={check} />
                ))}
              </Stack>
            </Collapsible>
          ) : null}
          {project.checks.length === 0 ? (
            <Text muted>{project.actions.overall === 'unknown' ? 'Checks unavailable' : `No checks on ${project.branch}`}</Text>
          ) : null}
        </Stack>
      </Stack>
    </Card>
  )
}

/** Optional values the repository cannot show: the agent hand-off and the updater endpoint. */
function SettingsForm({ project }: { project: ProjectStatus }) {
  const edits = read(settingsDraft)[project.id]
  return (
    <Collapsible title="Settings" description="Optional">
      <Stack gap="xs">
        <Input
          label={`Agent prompt of ${project.name}`}
          placeholder="/your-release-command"
          value={edits?.agentPrompt ?? project.settings.agentPrompt}
          onChange={(value) => editSettings(project.id, { agentPrompt: value })}
        />
        <Input
          label={`Updater URL of ${project.name}`}
          placeholder="https://example.com/updates/latest.json"
          value={edits?.updaterUrl ?? project.settings.updaterUrl}
          onChange={(value) => editSettings(project.id, { updaterUrl: value })}
        />
        <Row gap="xs">
          <Button variant="outline" onPress={() => void saveSettings(project)}>
            Save settings
          </Button>
        </Row>
      </Stack>
    </Collapsible>
  )
}

/** The Releases tab: where the release is stuck, and the agent hand-off. */
function ReleaseCard({ project }: { project: ProjectStatus }) {
  const hasFlow = project.flow === 'release'
  const needsHelp = project.overall === 'blocked' || project.overall === 'failed'
  return (
    <Card title={project.name} description={hasFlow ? project.summary : project.flowNote}>
      <Stack gap="sm">
        <Row gap="xs" align="center" wrap>
          {hasFlow ? (
            <Badge tone={TONE[project.overall]}>{RELEASE_WORDS[project.overall]}</Badge>
          ) : (
            <Badge tone="neutral">No release flow</Badge>
          )}
          {project.detected ? <Badge tone="neutral">This project</Badge> : null}
        </Row>
        {hasFlow ? <Text muted size="xs">{`Found: ${project.flowNote}`}</Text> : null}
        <BranchPrLine project={project} />
        {project.stages.length > 0 ? (
          <List label={`${project.name} stages`}>
            {project.stages.map((stage) => (
              <ListItem
                key={stage.id}
                title={stage.label}
                description={stage.detail}
                icon={ICON[stage.state]}
                {...(stage.url ? { onPress: () => void shell.openExternal(stage.url as string) } : {})}
              />
            ))}
          </List>
        ) : null}
        {project.releaseJobs.map((group) => (
          <Stack key={group.label} gap="xs">
            <Text muted size="xs">{`Jobs of the ${group.label}`}</Text>
            <Text truncate>
              <Link href={group.url}>{group.title}</Link>
            </Text>
            {group.jobs.map((job) => (
              <CheckLine key={job.id} project={project} check={job} />
            ))}
            {group.jobs.length === 0 ? <Text muted>Jobs unavailable. Open the run to see them.</Text> : null}
          </Stack>
        ))}
        {hasFlow && needsHelp && project.agentPrompt ? (
          <Row gap="xs" wrap>
            <Button
              variant="outline"
              icon="bot"
              disabled={!read(agentChoice)}
              tooltip={read(agentChoice) ? undefined : 'Pick an agent terminal first'}
              onPress={() => void ask(project.id)}
            >
              {`Ask agent: ${project.agentPrompt}`}
            </Button>
          </Row>
        ) : null}
        <SettingsForm project={project} />
      </Stack>
    </Card>
  )
}

/** Opened cards go under their own repository's card; one with no such card goes last. */
function cardOrder(projects: ProjectStatus[], opened: ProjectStatus[]): ProjectStatus[] {
  const placed = new Set<ProjectStatus>()
  const order = projects.flatMap((project) => {
    const below = opened.filter((card) => !placed.has(card) && card.id === project.id)
    below.forEach((card) => placed.add(card))
    return [project, ...below]
  })
  return [...order, ...opened.filter((card) => !placed.has(card))]
}

/** Which Actions states sort first. `unknown` is last either way. */
const FAILING_FIRST: Overall[] = ['failed', 'blocked', 'running', 'ok', 'unknown']
const PASSING_FIRST: Overall[] = ['ok', 'running', 'blocked', 'failed', 'unknown']

const labelOf = (card: ProjectStatus): string => card.worktree ?? card.name
const byName = (a: ProjectStatus, b: ProjectStatus): number => labelOf(a).localeCompare(labelOf(b)) || a.branch.localeCompare(b.branch)
const byState = (order: Overall[]) => (a: ProjectStatus, b: ProjectStatus): number =>
  order.indexOf(a.actions.overall) - order.indexOf(b.actions.overall) || byName(a, b)

function sortCards(cards: ProjectStatus[]): ProjectStatus[] {
  switch (read(sortBy)) {
    case 'failing':
      return [...cards].sort(byState(FAILING_FIRST))
    case 'passing':
      return [...cards].sort(byState(PASSING_FIRST))
    case 'name-asc':
      return [...cards].sort(byName)
    case 'name-desc':
      return [...cards].sort(byName).reverse()
    default:
      return cards
  }
}

function matches(card: ProjectStatus): boolean {
  const text = read(query).trim().toLowerCase()
  const state = read(stateShown)
  return (
    (state === EVERY || card.actions.overall === state) &&
    (text === '' || [card.id, card.name, card.branch, card.worktree ?? ''].some((part) => part.toLowerCase().includes(text)))
  )
}

const cardKey = (card: ProjectStatus): string =>
  card.worktree ? `worktree:${card.id}@${card.branch}` : card.opened ? `${card.id}@${card.branch}` : card.id

/** The controls above the cards: worktree (All worktrees only), state filter, sort and search. */
function CardControls({ worktrees, all }: { worktrees: ProjectStatus[]; all: boolean }) {
  return (
    <Stack gap="sm">
      {all ? (
        <Select
          label="Show worktree"
          value={shownWorktree(worktrees)}
          options={[
            { value: EVERY, label: 'All worktrees' },
            ...worktrees.map((card) => ({ value: card.worktree ?? card.branch, label: card.detected ? `${card.worktree} (this worktree)` : (card.worktree ?? card.branch) }))
          ]}
          onChange={(value) => set(worktreeShown, value)}
        />
      ) : null}
      <Select
        label="Show state"
        value={read(stateShown)}
        options={[
          { value: EVERY, label: 'All states' },
          { value: 'failed', label: 'Failing' },
          { value: 'running', label: 'Running' },
          { value: 'ok', label: 'Passing' }
        ]}
        onChange={(value) => set(stateShown, value)}
      />
      <Select
        label="Sort cards"
        value={read(sortBy)}
        options={[
          { value: 'default', label: 'Default order' },
          { value: 'failing', label: 'Failing first' },
          { value: 'passing', label: 'Passing first' },
          { value: 'name-asc', label: 'Name A to Z' },
          { value: 'name-desc', label: 'Name Z to A' }
        ]}
        onChange={(value) => set(sortBy, value)}
      />
      <Input label="Search cards" labelHidden placeholder="Search cards" value={read(query)} onChange={(value) => set(query, value)} />
    </Stack>
  )
}

/** A worktree that has gone since it was picked falls back to every worktree. */
const shownWorktree = (worktrees: ProjectStatus[]): string =>
  worktrees.some((card) => (card.worktree ?? card.branch) === read(worktreeShown)) ? read(worktreeShown) : EVERY

function ActionsView({ projects, opened, worktrees }: { projects: ProjectStatus[]; opened: ProjectStatus[]; worktrees: ProjectStatus[] }) {
  // The worker sends no worktree cards when there is nothing to switch between.
  const hasSiblings = worktrees.length > 0
  const all = hasSiblings && read(scope) === 'all'
  const only = shownWorktree(worktrees)
  const pool = all ? worktrees.filter((card) => only === EVERY || (card.worktree ?? card.branch) === only) : cardOrder(projects, opened)
  const total = all ? worktrees.length : pool.length
  const shown = pool.filter(matches)
  const pinned = sortCards(shown.filter((card) => card.pinned))
  const rest = sortCards(shown.filter((card) => !card.pinned))
  return (
    <Stack gap="md">
      {hasSiblings ? (
        <Tabs label="Actions scope" value={read(scope)} onChange={(value) => set(scope, value)}>
          <Tab value="here" label="This worktree" />
          <Tab value="all" label="All worktrees" />
        </Tabs>
      ) : null}
      {total > 0 ? <CardControls worktrees={worktrees} all={all} /> : null}
      {shown.length < total ? <Text muted size="xs">{`Showing ${shown.length} of ${total} cards`}</Text> : null}
      {shown.length === 0 && total > 0 ? <Text muted>No card matches</Text> : null}
      {pinned.length > 0 ? (
        <Stack gap="xs">
          <Row gap="xs" align="center">
            <Text>Pinned</Text>
            <Badge tone="neutral">{String(pinned.length)}</Badge>
          </Row>
          {pinned.map((card) => (
            <ActionsCard key={cardKey(card)} project={card} />
          ))}
        </Stack>
      ) : null}
      {pinned.length > 0 && rest.length > 0 ? <Text>Others</Text> : null}
      {rest.map((card) => (
        <ActionsCard key={cardKey(card)} project={card} />
      ))}
      {all ? null : (
        <Card title="Add a project" description="Any GitHub repository that gh can read.">
          <Row gap="xs" align="end">
            <Input
              label="Repository"
              labelHidden
              placeholder="owner/name or GitHub URL"
              value={read(draft)}
              onChange={(value) => set(draft, value)}
              onSubmit={() => void addProject()}
            />
            <Button variant="outline" icon="add" disabled={!read(draft).trim()} onPress={() => void addProject()}>
              Add
            </Button>
          </Row>
        </Card>
      )}
    </Stack>
  )
}

/** Orca's kit has no purple tone, so merged is a grey badge with a purple emoji; closed is muted grey. */
const PR_DOT: Record<PrState, ['warning' | 'success' | 'danger' | undefined, string]> = {
  running: ['warning', 'Running'],
  ready: ['success', 'Ready to merge'],
  failed: ['danger', 'Failing'],
  merged: [undefined, 'Merged'],
  closed: [undefined, 'Closed']
}
/** The badge beside the dot: same colour, one short word. */
const PR_BADGE_WORD: Record<PrState, string> = {
  running: 'Running',
  ready: 'Ready',
  failed: 'Failed',
  merged: '🟣 Merged',
  closed: 'Closed'
}

/** One worktree with a PR: a coloured dot, the name that opens its card on the Actions tab, and the PR link. */
function PrLine({ pr }: { pr: WorktreePr }) {
  const [tone, word] = PR_DOT[pr.state]
  const state = pr.reason ? `${word}: ${pr.reason}` : word
  return (
    <Row gap="xs" align="center" justify="between" wrap>
      <Row gap="xs" align="center">
        {tone ? <Text tone={tone}>●</Text> : <Text muted>{pr.state === 'merged' ? PURPLE : '●'}</Text>}
        <Button variant="ghost" size="xs" tooltip={`${state}. #${pr.number} ${pr.title}`} onPress={() => void openCard(pr.branch)}>
          {pr.worktree}
        </Button>
      </Row>
      <Row gap="xs" align="center">
        <Badge tone={tone ?? 'neutral'}>{PR_BADGE_WORD[pr.state]}</Badge>
        <IconButton icon="open-external" label={`Open PR #${pr.number}`} variant="ghost" onPress={() => void shell.openExternal(pr.url)} />
      </Row>
    </Row>
  )
}

function PrsView({ prs }: { prs: WorktreePr[] }) {
  if (prs.length === 0) {
    return (
      <EmptyState
        icon="branch"
        title="No pull requests"
        description="None of this project's worktrees has a pull request."
      />
    )
  }
  return (
    <Stack gap="xs">
      {prs.map((pr) => (
        <PrLine key={pr.branch} pr={pr} />
      ))}
    </Stack>
  )
}

function ReleasesView({ projects }: { projects: ProjectStatus[] }) {
  const options = read(agentOptions)
  if (projects.length === 0) {
    return (
      <EmptyState
        icon="rocket"
        title="No project yet"
        description="Focus a workspace with a GitHub origin, or add a repository on the Actions tab."
      />
    )
  }
  return (
    <Stack gap="md">
      {options.length > 0 ? (
        <Select
          label="Send to agent"
          placeholder="Pick an agent terminal"
          value={read(agentChoice)}
          options={options}
          onChange={(value) => set(agentChoice, value)}
        />
      ) : null}
      {projects.map((project) => (
        <ReleaseCard key={project.id} project={project} />
      ))}
    </Stack>
  )
}

export default function Panel() {
  const current = read(snapshot)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>PRs, Actions and Releases</Heading>
        <Button variant="ghost" icon="refresh" onPress={() => void load(true)}>
          Refresh
        </Button>
      </Row>
      {read(problem) ? <Text tone="danger">{read(problem)}</Text> : null}
      {read(notice) ? <Text muted>{read(notice)}</Text> : null}
      {current?.detectNote ? <Text muted>{`No project detected: ${current.detectNote}`}</Text> : null}
      {current ? (
        <Tabs label="View" value={read(view)} onChange={(value) => set(view, value as View)}>
          <Tab value="prs" label="PRs" icon="branch">
            <PrsView prs={current.worktreePrs} />
          </Tab>
          <Tab value="actions" label="Actions" icon="play">
            <ActionsView projects={current.projects} opened={current.opened} worktrees={current.worktrees} />
          </Tab>
          <Tab value="releases" label="Releases" icon="rocket">
            <ReleasesView projects={current.projects} />
          </Tab>
        </Tabs>
      ) : read(problem) ? (
        <EmptyState icon="error" title="No status yet" description="The lookup failed. Press Refresh to try again." />
      ) : (
        <Spinner label="Checking projects" />
      )}
      {current ? (
        <Text muted size="xs">{`Checked ${new Date(current.checkedAt).toLocaleTimeString()}. Looks again every minute while this tab is open.`}</Text>
      ) : null}
    </Stack>
  )
}

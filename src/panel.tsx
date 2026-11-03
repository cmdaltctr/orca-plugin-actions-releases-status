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
  Tab,
  Tabs,
  Text,
  type PanelContext
} from 'orca'
import type { CheckRow, Overall, ProjectSettings, ProjectStatus, StageState, StatusSnapshot } from './protocol'

const POLL_MS = 60_000
const REQUEST = { timeoutMs: 60_000 }

const snapshot = atom<StatusSnapshot | null>(null)
const problem = atom<string | null>(null)
const notice = atom<string | null>(null)
const agentOptions = atom<{ value: string; label: string }[]>([])
const agentChoice = atom('')
const draft = atom('')
const view = atom<'actions' | 'releases'>('actions')
/** Unsaved edits of the Settings fields, by project. */
const settingsDraft = atom<Record<string, Partial<ProjectSettings>>>({})

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

const lockBranch = (projectId: string, locked: boolean) =>
  show(() => plugin.request('branch.lock', { projectId, locked }, REQUEST))
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
    </Row>
  )
}

/** The Actions tab: the checks of one branch's newest commit, with the branch picker and project controls. */
function ActionsCard({ project }: { project: ProjectStatus }) {
  return (
    <Card title={project.name} description={project.actions.summary}>
      <Stack gap="sm">
        <Row gap="xs" align="center" justify="between">
          <Row gap="xs" align="center">
            <Badge tone={TONE[project.actions.overall]}>{ACTIONS_WORDS[project.actions.overall]}</Badge>
            {project.detected ? <Badge tone="neutral">This project</Badge> : null}
            <Badge tone={project.locked ? 'accent' : 'neutral'}>{project.locked ? 'Locked' : 'Unlocked'}</Badge>
            {/* Orca's icon set has no lock, so the button text carries the emoji. */}
            <Button
              variant="ghost"
              tooltip={project.locked ? 'Unlock: follow the focused workspace again' : `Lock ${project.branch}: keep it when you switch project`}
              onPress={() => void lockBranch(project.id, !project.locked)}
            >
              {project.locked ? '🔒' : '🔓'}
            </Button>
          </Row>
          {project.detected ? null : (
            <IconButton
              icon="close"
              label={`Remove ${project.name}`}
              variant="ghost"
              onPress={() => void removeProject(project.id)}
            />
          )}
        </Row>
        {project.branches.length > 1 ? (
          <Select
            label={`Branch of ${project.name}`}
            labelHidden
            value={project.branch}
            options={project.branches.map((branch) => ({ value: branch, label: branch }))}
            onChange={(value) => void selectBranch(project.id, value)}
          />
        ) : null}
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
        <Row gap="xs" align="center">
          {hasFlow ? (
            <Badge tone={TONE[project.overall]}>{RELEASE_WORDS[project.overall]}</Badge>
          ) : (
            <Badge tone="neutral">No release flow</Badge>
          )}
          {project.detected ? <Badge tone="neutral">This project</Badge> : null}
        </Row>
        {hasFlow ? <Text muted size="xs">{`Found: ${project.flowNote}`}</Text> : null}
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

function ActionsView({ projects }: { projects: ProjectStatus[] }) {
  return (
    <Stack gap="md">
      {projects.map((project) => (
        <ActionsCard key={project.id} project={project} />
      ))}
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
        <Heading>Actions and Releases</Heading>
        <Button variant="ghost" icon="refresh" onPress={() => void load(true)}>
          Refresh
        </Button>
      </Row>
      {read(problem) ? <Text tone="danger">{read(problem)}</Text> : null}
      {read(notice) ? <Text muted>{read(notice)}</Text> : null}
      {current?.detectNote ? <Text muted>{`No project detected: ${current.detectNote}`}</Text> : null}
      {current ? (
        <Tabs label="View" value={read(view)} onChange={(value) => set(view, value as 'actions' | 'releases')}>
          <Tab value="actions" label="Actions" icon="play">
            <ActionsView projects={current.projects} />
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

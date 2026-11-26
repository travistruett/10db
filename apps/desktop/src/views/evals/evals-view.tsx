import {
  EvalAssessmentState,
  NewEvalOrigin,
  evalGapPath,
  type EvalCallSiteCountDto,
  type EvalDriftDto,
  type EvalGapDto,
  type EvalsDto,
  type ProjectViewDto,
} from '@10db/contracts';
import { Button, Code, Container, Group, Paper, Stack, Tabs, Text, Tooltip } from '@mantine/core';
import { IconFlask, IconListCheck, IconPlus } from '@tabler/icons-react';
import { DataTable } from 'mantine-datatable';
import { useState, type ReactNode } from 'react';
import { useEvals } from '../../daemon/evals-queries';
import { ContentWidth } from '../../shell/content-width';
import { CountBadge } from '../../shell/count-badge';
import { EmptyState } from '../../shell/empty-state';
import { absoluteTime, fromNow, useNow } from '../../shell/relative';
import { PageIntro } from '../../shell/page-intro';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { RaisedPanel } from '../../shell/raised-panel';
import { TitleRow } from '../../shell/title-row';
import { useSelectedProject } from '../../shell/selected-project';
import { AssessAction, useEvalAssessment, type EvalAssessment } from './assess-action';
import { ByModel } from './by-model';
import { asBehavior, NewEvalModal, type NewEvalPrefill } from './new-eval-modal';
import { SuiteDrawer } from './suite-drawer';
import { SuiteTable } from './suite-table';

const EvalsTab = { Suites: 'suites', Models: 'models', Gaps: 'gaps' } as const;
type EvalsTab = (typeof EvalsTab)[keyof typeof EvalsTab];
const isEvalsTab = (value: string | null): value is EvalsTab =>
  value === EvalsTab.Suites || value === EvalsTab.Models || value === EvalsTab.Gaps;

/** How many unlinked eval files show before the rest fold away. */
const UNLINKED_SHOWN = 6;

/** How the page reads: what is found and, in words, when it was last assessed. */
function Byline({ evals }: { readonly evals: EvalsDto }) {
  const now = useNow();
  const assessing = evals.assessment.state === EvalAssessmentState.Assessing;
  const when = assessing
    ? 'Assessing…'
    : evals.assessedAt === null
      ? 'Not assessed yet'
      : `Assessed ${fromNow(evals.assessedAt, now)}`;
  const commit = evals.commit === null ? null : evals.commit.slice(0, 7);
  const withResults = evals.suites.filter((s) => s.latest !== null);
  const failing = withResults.filter((s) => s.latest?.passed === false).length;
  const found =
    evals.suites.length === 0
      ? evals.unlinked.length === 0
        ? null
        : `${counted(evals.unlinked.length, 'eval file', 'eval files')}, none linked to a suite yet`
      : [
          counted(evals.suites.length, 'suite', 'suites'),
          `${String(withResults.length - failing)} passing`,
          ...(failing > 0 ? [`${String(failing)} failing`] : []),
          ...(withResults.length < evals.suites.length
            ? [`${String(evals.suites.length - withResults.length)} with no results`]
            : []),
        ].join(' · ');
  return (
    <>
      {found === null ? null : `${found} · `}
      <Tooltip
        label={
          evals.assessedAt === null
            ? 'Suites are found by file names until the evals are assessed.'
            : `${absoluteTime(evals.assessedAt)}${commit === null ? '' : ` · read at ${commit}`}`
        }
      >
        <span>{when}</span>
      </Tooltip>
    </>
  );
}

/** One bordered line on the Suites tab: a sentence and what to do about it. */
function Notice({
  lead,
  children,
  action,
  below,
}: {
  readonly lead: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly below?: ReactNode;
}) {
  return (
    <Paper withBorder radius="md" px="md" py="sm" bg="var(--mantine-color-body)">
      <Stack gap={8}>
        <Group justify="space-between" wrap="nowrap" gap="md" align="center">
          <Text size="sm">
            <Text span fw={600} c="var(--mantine-color-bright)">
              {lead}
            </Text>
            {children === undefined ? null : <> {children}</>}
          </Text>
          {action === undefined ? null : <div style={{ flexShrink: 0 }}>{action}</div>}
        </Group>
        {below}
      </Stack>
    </Paper>
  );
}

/** What the assessment is doing or has just said, above the suites. */
function AssessmentNotice({
  evals,
  assessment,
  project,
}: {
  readonly evals: EvalsDto;
  readonly assessment: EvalAssessment;
  readonly project: ProjectViewDto;
}) {
  const action = <AssessAction assessment={assessment} project={project} />;
  if (assessment.busy)
    return (
      <Notice lead="Assessing your evals…">
        Reading the eval files and the code that calls a model. This takes a minute or two.
      </Notice>
    );
  if (assessment.unavailable)
    return (
      <Notice lead="10db can't assess these on its own." action={action}>
        {evals.assessment.reason ?? 'It has no model to ask for this project.'}
      </Notice>
    );
  if (assessment.failure !== null)
    return (
      <Notice lead="The last assessment failed." action={action}>
        {assessment.failure}
      </Notice>
    );
  if (evals.assessedAt === null)
    return (
      <Notice lead="Not assessed yet." action={action}>
        Assessing adds each suite's bar, the code it covers and the LLM work with no eval.
      </Notice>
    );
  return null;
}

/** A count and its noun, singular for one. */
const counted = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** What changed since the last assessment that it misses, and the button that brings it up to date. */
function SinceAssessment({
  drift,
  assessment,
  project,
}: {
  readonly drift: EvalDriftDto;
  readonly assessment: EvalAssessment;
  readonly project: ProjectViewDto;
}) {
  const parts = [
    ...(drift.newEvalFiles.length > 0
      ? [counted(drift.newEvalFiles.length, 'new eval file', 'new eval files')]
      : []),
    ...(drift.newGaps.length > 0
      ? [counted(drift.newGaps.length, 'new LLM call with no eval', 'new LLM calls with no eval')]
      : []),
    ...(drift.missingPaths.length > 0
      ? [counted(drift.missingPaths.length, 'path it names is gone', 'paths it names are gone')]
      : []),
  ];
  return (
    <Notice
      lead="Changed since the last assessment:"
      action={<AssessAction assessment={assessment} project={project} />}
      below={
        <PathList
          paths={[
            ...drift.newEvalFiles,
            ...drift.newGaps.map((g) => g.where),
            ...drift.missingPaths,
          ]}
        />
      }
    >
      {`${parts.join(' · ')}.`}
    </Notice>
  );
}

/** Paths as code, folded past six. */
function PathList({ paths }: { readonly paths: readonly string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? paths : paths.slice(0, UNLINKED_SHOWN);
  return (
    <Group gap={6}>
      {shown.map((path) => (
        <Code key={path}>{path}</Code>
      ))}
      {paths.length > UNLINKED_SHOWN ? (
        <Button
          size="compact-xs"
          variant="subtle"
          onClick={() => {
            setAll(!all);
          }}
        >
          {all ? 'Show Fewer' : `${String(paths.length - UNLINKED_SHOWN)} More`}
        </Button>
      ) : null}
    </Group>
  );
}

function Unlinked({ paths }: { readonly paths: readonly string[] }) {
  if (paths.length === 0) return null;
  return (
    <Stack gap={6}>
      <Text size="sm" fw={600} c="var(--mantine-color-bright)">
        Eval Files Not Linked to a Suite
      </Text>
      <Text size="xs" c="dimmed">
        Found by file name; no suite uses them yet.
      </Text>
      <PathList paths={paths} />
    </Stack>
  );
}

/** What each call pattern found at HEAD, so a pattern that is too broad shows. */
function callSitesText(counts: readonly EvalCallSiteCountDto[]): string {
  return counts
    .map(
      (c) =>
        `${c.label} ${c.count === null ? 'refused by git' : `${String(c.count)}${c.capped ? '+' : ''}`}`,
    )
    .join(' · ');
}

function Gaps({
  gaps,
  callSites,
  project,
  assessment,
  said,
  onNewEval,
}: {
  readonly gaps: readonly EvalGapDto[] | null;
  readonly callSites: readonly EvalCallSiteCountDto[];
  readonly project: ProjectViewDto;
  readonly assessment: EvalAssessment;
  /** Why 10db can't assess or the last assessment changed nothing, when it did not. */
  readonly said: string | null;
  readonly onNewEval: (prefill: NewEvalPrefill) => void;
}) {
  if (gaps === null)
    return (
      <EmptyState
        icon={IconListCheck}
        title={assessment.busy ? 'Assessing your evals…' : 'Not assessed yet'}
        extra={
          assessment.busy ? undefined : <AssessAction assessment={assessment} project={project} />
        }
      >
        {assessment.busy
          ? 'Reading the code that calls a model to find what has no eval.'
          : (said ?? 'Assess Now to find the LLM work that has no eval.')}
      </EmptyState>
    );
  if (gaps.length === 0)
    return (
      <EmptyState icon={IconListCheck} title="Every LLM task has an eval">
        Every model call found is covered by a suite.
      </EmptyState>
    );
  return (
    <Stack gap={6}>
      {callSites.length === 0 ? null : (
        <Text size="xs" c="dimmed">
          {`Sites found at HEAD by call pattern: ${callSitesText(callSites)}`}
        </Text>
      )}
      <RaisedPanel>
        <DataTable<EvalGapDto>
          aria-label="LLM work with no eval"
          records={[...gaps]}
          idAccessor={(gap) => `${gap.where}|${gap.label}`}
          backgroundColor="transparent"
          verticalSpacing="sm"
          horizontalSpacing="md"
          columns={[
            {
              accessor: 'label',
              title: 'LLM Work',
              render: (gap) => (
                <Text size="sm" fw={500} c="var(--mantine-color-bright)">
                  {gap.label}
                </Text>
              ),
            },
            {
              accessor: 'where',
              title: 'Where',
              render: (gap) => (
                <Stack gap={2} align="flex-start">
                  <Code>{gap.where}</Code>
                  <Text size="xs" c="dimmed">
                    {gap.source === 'found' ? 'found at HEAD' : 'assessed'}
                  </Text>
                </Stack>
              ),
            },
            {
              accessor: 'why',
              title: 'Why It Counts',
              render: (gap) => (
                <Text size="sm" c="dimmed">
                  {gap.why}
                </Text>
              ),
            },
            {
              accessor: 'newEval',
              title: '',
              textAlign: 'right',
              render: (gap) => (
                <Button
                  size="compact-xs"
                  variant="default"
                  aria-label={`New Eval for ${gap.label}`}
                  onClick={() => {
                    onNewEval({
                      behavior: asBehavior(gap.label),
                      evidence: gap.why,
                      where: [evalGapPath(gap.where)],
                      origin: NewEvalOrigin.Gap,
                    });
                  }}
                >
                  New Eval
                </Button>
              ),
            },
          ]}
        />
      </RaisedPanel>
    </Stack>
  );
}

/** A project with no eval file and no result: write one, or have 10db look for the ones it already has. */
function NoEvals({
  evals,
  assessment,
  project,
  onNewEval,
}: {
  readonly evals: EvalsDto;
  readonly assessment: EvalAssessment;
  readonly project: ProjectViewDto;
  readonly onNewEval: () => void;
}) {
  if (assessment.busy)
    return (
      <EmptyState icon={IconFlask} title="Assessing your evals…">
        Looking for evals this project already has.
      </EmptyState>
    );
  const said = assessment.failure ?? (assessment.unavailable ? evals.assessment.reason : null);
  return (
    <EmptyState
      icon={IconFlask}
      title="No evals yet"
      action={{ label: 'New Eval', icon: IconPlus, emphasis: 'filled', onClick: onNewEval }}
      extra={<AssessAction assessment={assessment} project={project} />}
    >
      {said ?? 'Write one with New Eval, or Assess Now to find the ones this project already has.'}
    </EmptyState>
  );
}

function ProjectEvals({ project }: { readonly project: ProjectViewDto }) {
  const evals = useEvals(project.id);
  const assessment = useEvalAssessment(
    evals.data?.assessment ?? { state: EvalAssessmentState.Idle, reason: null },
    project.id,
  );
  const [tab, setTab] = useState<EvalsTab>(EvalsTab.Suites);
  const [open, setOpen] = useState<string | null>(null);
  const [newEval, setNewEval] = useState<NewEvalPrefill | null>(null);
  const header = (description?: ReactNode) => (
    <>
      <TitleRow
        title="Evals"
        meta={project.name}
        actions={
          <Button
            size="xs"
            leftSection={<IconPlus size={14} stroke={1.5} />}
            onClick={() => {
              setNewEval({ origin: NewEvalOrigin.Page });
            }}
          >
            New Eval
          </Button>
        }
      />
      <PageIntro
        {...(description === undefined ? {} : { description })}
        toolbar={
          <Tabs
            value={tab}
            onChange={(next) => {
              if (isEvalsTab(next)) setTab(next);
            }}
          >
            <Tabs.List>
              <Tabs.Tab value={EvalsTab.Suites}>Suites</Tabs.Tab>
              <Tabs.Tab value={EvalsTab.Models}>By Model</Tabs.Tab>
              <Tabs.Tab
                value={EvalsTab.Gaps}
                rightSection={
                  evals.data?.gaps && evals.data.gaps.length > 0 ? (
                    <CountBadge count={evals.data.gaps.length} phrase="with no eval" />
                  ) : undefined
                }
              >
                No Eval
              </Tabs.Tab>
            </Tabs.List>
          </Tabs>
        }
      />
    </>
  );
  const newEvalModal = (
    <NewEvalModal
      projectId={project.id}
      prefill={newEval}
      onClose={() => {
        setNewEval(null);
      }}
    />
  );
  if (evals.data === undefined)
    return (
      <>
        {header()}
        {evals.isError ? (
          <Text size="sm" c="red">
            {evals.error.message}
          </Text>
        ) : (
          <PageLoading shape={PageLoadingShape.List} label="Loading the suites" />
        )}
        {newEvalModal}
      </>
    );
  const data = evals.data;
  return (
    <>
      {header(<Byline evals={data} />)}
      {tab === EvalsTab.Suites ? (
        <Stack gap="md">
          {data.suites.length === 0 && data.unlinked.length === 0 ? null : (
            <AssessmentNotice evals={data} assessment={assessment} project={project} />
          )}
          {data.drift === null ? null : (
            <SinceAssessment drift={data.drift} assessment={assessment} project={project} />
          )}
          {data.suites.length === 0 && data.unlinked.length === 0 ? (
            <NoEvals
              evals={data}
              assessment={assessment}
              project={project}
              onNewEval={() => {
                setNewEval({ origin: NewEvalOrigin.Page });
              }}
            />
          ) : data.suites.length === 0 ? null : (
            <SuiteTable
              suites={data.suites}
              openKey={open}
              onOpen={(suite) => {
                setOpen(suite.key);
              }}
            />
          )}
          <Unlinked paths={data.unlinked} />
        </Stack>
      ) : tab === EvalsTab.Models ? (
        <ByModel projectId={project.id} />
      ) : (
        <Gaps
          gaps={data.gaps}
          callSites={data.callSites}
          project={project}
          assessment={assessment}
          said={assessment.failure ?? (assessment.unavailable ? data.assessment.reason : null)}
          onNewEval={setNewEval}
        />
      )}
      {newEvalModal}
      <SuiteDrawer
        projectId={project.id}
        suiteKey={open}
        onClose={() => {
          setOpen(null);
        }}
      />
    </>
  );
}

/**
 * A project's evals: each suite found in its repository at HEAD, its last result per model, trend and
 * cost, and the LLM work no eval covers. It reads eval files at HEAD and result files in the checkout, and never runs an eval.
 */
export function EvalsView() {
  const { project } = useSelectedProject();
  return (
    <Container size={ContentWidth.Page} w="100%">
      <Stack>
        {project ? <ProjectEvals key={project.id} project={project} /> : <TitleRow title="Evals" />}
      </Stack>
    </Container>
  );
}

import {
  EvalAssessmentState,
  NewEvalOrigin,
  type EvalCallSiteCountDto,
  type EvalDriftDto,
  type EvalsDto,
  type ProjectViewDto,
} from '@10db/contracts';
import {
  Box,
  Button,
  Code,
  Container,
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconFlask, IconPlus } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { useEvals } from '../../daemon/evals-queries';
import { ContentWidth } from '../../shell/content-width';
import { EmptyState } from '../../shell/empty-state';
import { absoluteTime, fromNow, useNow } from '../../shell/relative';
import { PageIntro } from '../../shell/page-intro';
import { StatTile } from '../../shell/stat-tile';
import { TitleRow } from '../../shell/title-row';
import { useSelectedProject } from '../../shell/selected-project';
import { AssessAction, useEvalAssessment, type EvalAssessment } from './assess-action';
import { ByModel } from './by-model';
import { EvalFilter, EvalsTable, evalRows, rowMatches, suiteFilter } from './evals-table';
import { EvalsSkeleton } from './evals-skeleton';
import { NewEvalModal, type NewEvalPrefill } from './new-eval-modal';
import { SuiteDrawer } from './suite-drawer';

const EvalsPage = { Evals: 'evals', Models: 'models' } as const;
type EvalsPage = (typeof EvalsPage)[keyof typeof EvalsPage];
const isEvalsPage = (value: string): value is EvalsPage =>
  value === EvalsPage.Evals || value === EvalsPage.Models;

/** How many unlinked eval files show before the rest fold away. */
const UNLINKED_SHOWN = 6;

/** When the evals were last assessed, in words, with the exact time and commit in a tooltip. */
function Byline({ evals }: { readonly evals: EvalsDto }) {
  const now = useNow();
  const assessing = evals.assessment.state === EvalAssessmentState.Assessing;
  const when = assessing
    ? 'Assessing…'
    : evals.assessedAt === null
      ? 'Not assessed yet'
      : `Assessed ${fromNow(evals.assessedAt, now)}`;
  const commit = evals.commit === null ? null : evals.commit.slice(0, 7);
  return (
    <Tooltip
      label={
        evals.assessedAt === null
          ? 'Suites are found by file names until the evals are assessed.'
          : `${absoluteTime(evals.assessedAt)}${commit === null ? '' : ` · read at ${commit}`}`
      }
    >
      <span>{when}</span>
    </Tooltip>
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

/** What each call pattern found at HEAD, so a pattern that is too broad shows. */
function callSitesText(counts: readonly EvalCallSiteCountDto[]): string {
  return counts
    .map(
      (c) =>
        `${c.label} ${c.count === null ? 'refused by git' : `${String(c.count)}${c.capped ? '+' : ''}`}`,
    )
    .join(' · ');
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

/** A small filled dot in a tile's color; decorative, the label beside it carries the meaning. */
function TileDot({ color }: { readonly color: string }) {
  return (
    <Box
      component="span"
      aria-hidden
      w={8}
      h={8}
      style={{
        display: 'inline-block',
        flex: 'none',
        borderRadius: '50%',
        background: `var(--mantine-color-${color}-filled)`,
      }}
    />
  );
}

const TILES = [
  { filter: EvalFilter.Passing, color: 'green', label: 'Passing' },
  { filter: EvalFilter.Failing, color: 'red', label: 'Failing' },
  { filter: EvalFilter.NotRun, color: 'gray', label: 'Not Run Yet' },
  { filter: EvalFilter.NoEval, color: 'yellow', label: 'No Eval' },
] as const;

/** The four counts, each a toggle that narrows the table to what it counts; the active one clears itself. */
function EvalTiles({
  counts,
  filter,
  onFilter,
}: {
  readonly counts: Readonly<Record<EvalFilter, number>>;
  readonly filter: EvalFilter | null;
  readonly onFilter: (filter: EvalFilter | null) => void;
}) {
  return (
    <SimpleGrid component="section" aria-label="Evals at a glance" cols={4} spacing={12}>
      {TILES.map((tile) => (
        <StatTile
          key={tile.filter}
          n={counts[tile.filter]}
          mark={<TileDot color={tile.color} />}
          label={tile.label}
          color={tile.color}
          selected={filter === tile.filter}
          onToggle={() => {
            onFilter(filter === tile.filter ? null : tile.filter);
          }}
        />
      ))}
    </SimpleGrid>
  );
}

function ProjectEvals({ project }: { readonly project: ProjectViewDto }) {
  const evals = useEvals(project.id);
  const assessment = useEvalAssessment(
    evals.data?.assessment ?? { state: EvalAssessmentState.Idle, reason: null },
    project.id,
  );
  const [page, setPage] = useState<EvalsPage>(EvalsPage.Evals);
  const [filter, setFilter] = useState<EvalFilter | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [newEval, setNewEval] = useState<NewEvalPrefill | null>(null);
  const header = (description?: ReactNode) => (
    <>
      <TitleRow
        title="Evals"
        meta={project.name}
        actions={
          <>
            <SegmentedControl
              size="xs"
              aria-label="Evals view"
              value={page}
              data={[
                { value: EvalsPage.Evals, label: 'Evals' },
                { value: EvalsPage.Models, label: 'Models' },
              ]}
              onChange={(next) => {
                if (isEvalsPage(next)) setPage(next);
              }}
            />
            <Button
              size="xs"
              leftSection={<IconPlus size={14} stroke={1.5} />}
              onClick={() => {
                setNewEval({ origin: NewEvalOrigin.Page });
              }}
            >
              New Eval
            </Button>
          </>
        }
      />
      <PageIntro {...(description === undefined ? {} : { description })} />
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
        {header(<Skeleton height={10} width={120} my={5} />)}
        {evals.isError ? (
          <Text size="sm" c="red">
            {evals.error.message}
          </Text>
        ) : (
          <EvalsSkeleton />
        )}
        {newEvalModal}
      </>
    );
  const data = evals.data;
  const gaps = data.gaps ?? [];
  const rows = evalRows(data.suites, data.gaps, data.unlinked);
  const counts: Record<EvalFilter, number> = {
    [EvalFilter.Passing]: 0,
    [EvalFilter.Failing]: 0,
    [EvalFilter.NotRun]: 0,
    [EvalFilter.NoEval]: gaps.length + data.unlinked.length,
  };
  for (const suite of data.suites) counts[suiteFilter(suite)] += 1;
  const nothing = rows.length === 0;
  return (
    <>
      {header(<Byline evals={data} />)}
      {page === EvalsPage.Models ? (
        <ByModel projectId={project.id} />
      ) : (
        <Stack gap="md">
          {nothing ? null : (
            <>
              <EvalTiles counts={counts} filter={filter} onFilter={setFilter} />
              <AssessmentNotice evals={data} assessment={assessment} project={project} />
            </>
          )}
          {data.drift === null ? null : (
            <SinceAssessment drift={data.drift} assessment={assessment} project={project} />
          )}
          {nothing ? (
            <NoEvals
              evals={data}
              assessment={assessment}
              project={project}
              onNewEval={() => {
                setNewEval({ origin: NewEvalOrigin.Page });
              }}
            />
          ) : (
            <Stack gap={6}>
              {filter === EvalFilter.NoEval && data.callSites.length > 0 ? (
                <Text size="xs" c="dimmed">
                  {`Sites found at HEAD by call pattern: ${callSitesText(data.callSites)}`}
                </Text>
              ) : null}
              <EvalsTable
                rows={rows.filter((row) => rowMatches(row, filter))}
                filter={filter}
                openKey={open}
                project={project}
                assessment={assessment}
                onOpen={(suite) => {
                  setOpen(suite.key);
                }}
                onNewEval={setNewEval}
              />
            </Stack>
          )}
        </Stack>
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

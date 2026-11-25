import type { EvalGapDto, EvalsDto, ProjectViewDto } from '@10db/contracts';
import { Button, Code, Container, Group, Paper, Stack, Tabs, Text } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconCopy, IconFlask, IconListCheck } from '@tabler/icons-react';
import { DataTable } from 'mantine-datatable';
import { useState, type ReactNode } from 'react';
import { useEvals } from '../../daemon/evals-queries';
import { ContentWidth } from '../../shell/content-width';
import { CountBadge } from '../../shell/count-badge';
import { EmptyState } from '../../shell/empty-state';
import { PageIntro } from '../../shell/page-intro';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { RaisedPanel } from '../../shell/raised-panel';
import { TitleRow } from '../../shell/title-row';
import { useSelectedProject } from '../../shell/selected-project';
import { SuiteDrawer } from './suite-drawer';
import { SuiteTable } from './suite-table';

const EvalsTab = { Suites: 'suites', Gaps: 'gaps' } as const;
type EvalsTab = (typeof EvalsTab)[keyof typeof EvalsTab];
const isEvalsTab = (value: string | null): value is EvalsTab =>
  value === EvalsTab.Suites || value === EvalsTab.Gaps;

/** How many unlinked eval files show before the rest fold away. */
const UNLINKED_SHOWN = 6;

/** What to paste in any Claude Code or Codex session to have an agent assess the project's evals. */
function assessAsk(project: ProjectViewDto): string {
  return `Use the 10db-task skill to assess the evals of the 10db project ${project.name} (${project.id}).`;
}

/** The ask as an EmptyState action, which says Copied once it is on the clipboard. */
function useCopyAsk(project: ProjectViewDto) {
  const clipboard = useClipboard({ timeout: 1500 });
  return {
    label: clipboard.copied ? 'Copied' : 'Copy the Ask',
    icon: IconCopy,
    onClick: () => {
      clipboard.copy(assessAsk(project));
    },
  };
}

function CopyAskButton({ project }: { readonly project: ProjectViewDto }) {
  const clipboard = useClipboard({ timeout: 1500 });
  return (
    <Button
      size="xs"
      variant="default"
      leftSection={<IconCopy size={14} stroke={1.5} />}
      onClick={() => {
        clipboard.copy(assessAsk(project));
      }}
    >
      {clipboard.copied ? 'Copied' : 'Copy the Ask'}
    </Button>
  );
}

/** The one line that says what the page read, in figures. */
function summary(evals: EvalsDto): string {
  const withResults = evals.suites.filter((s) => s.latest !== null);
  const failing = withResults.filter((s) => s.latest?.passed === false).length;
  const parts = [
    `${String(evals.suites.length)} suites`,
    `${String(withResults.length - failing)} passing`,
    ...(failing > 0 ? [`${String(failing)} failing`] : []),
    `${String(evals.suites.length - withResults.length)} with no results`,
  ];
  const at = evals.commit === null ? '' : ` at ${evals.commit.slice(0, 7)}`;
  return `${parts.join(' · ')}. Read from the files committed${at}; nothing here ran a model.`;
}

/** Before an assessment: what file names alone found, and the ask that fills in the rest. */
function NotAssessed({ project }: { readonly project: ProjectViewDto }) {
  return (
    <Paper withBorder radius="md" px="md" py="sm" bg="var(--mantine-color-body)">
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Text size="sm">
          <Text span fw={600} c="var(--mantine-color-bright)">
            Found by file names.
          </Text>{' '}
          An agent's assessment adds each suite's bar, the code it covers, its commands and the LLM
          work with no eval.
        </Text>
        <CopyAskButton project={project} />
      </Group>
    </Paper>
  );
}

function Unlinked({ paths }: { readonly paths: readonly string[] }) {
  const [all, setAll] = useState(false);
  if (paths.length === 0) return null;
  const shown = all ? paths : paths.slice(0, UNLINKED_SHOWN);
  return (
    <Stack gap={6}>
      <Text size="sm" fw={600} c="var(--mantine-color-bright)">
        Eval Files Not Linked to a Suite
      </Text>
      <Text size="xs" c="dimmed">
        Found by name; the assessment says which suite each defines.
      </Text>
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
    </Stack>
  );
}

function Gaps({
  gaps,
  project,
}: {
  readonly gaps: readonly EvalGapDto[] | null;
  readonly project: ProjectViewDto;
}) {
  const copyAsk = useCopyAsk(project);
  if (gaps === null)
    return (
      <EmptyState icon={IconListCheck} title="Not assessed yet" action={copyAsk}>
        Only an agent reading the project can say which LLM work has no eval.
      </EmptyState>
    );
  if (gaps.length === 0)
    return (
      <EmptyState icon={IconListCheck} title="Every LLM task has an eval">
        The last assessment found no model call that a suite doesn't cover.
      </EmptyState>
    );
  return (
    <RaisedPanel>
      <DataTable<EvalGapDto>
        aria-label="LLM work with no eval"
        records={[...gaps]}
        idAccessor="where"
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
          { accessor: 'where', title: 'Where', render: (gap) => <Code>{gap.where}</Code> },
          {
            accessor: 'why',
            title: 'Why It Counts',
            render: (gap) => (
              <Text size="sm" c="dimmed">
                {gap.why}
              </Text>
            ),
          },
        ]}
      />
    </RaisedPanel>
  );
}

function ProjectEvals({ project }: { readonly project: ProjectViewDto }) {
  const evals = useEvals(project.id);
  const [tab, setTab] = useState<EvalsTab>(EvalsTab.Suites);
  const [open, setOpen] = useState<string | null>(null);
  const copyAsk = useCopyAsk(project);
  const header = (description?: ReactNode) => (
    <>
      <TitleRow title="Evals" meta={project.name} />
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
      </>
    );
  const data = evals.data;
  return (
    <>
      {header(summary(data))}
      {tab === EvalsTab.Suites ? (
        <Stack gap="md">
          {data.assessedAt === null ? <NotAssessed project={project} /> : null}
          {data.suites.length === 0 ? (
            <EmptyState icon={IconFlask} title="No evals found" action={copyAsk}>
              No eval files or committed results at HEAD. An agent's assessment can still find them.
            </EmptyState>
          ) : (
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
      ) : (
        <Gaps gaps={data.gaps} project={project} />
      )}
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
 * cost, and the LLM work no eval covers. It reads committed files only and never runs an eval.
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

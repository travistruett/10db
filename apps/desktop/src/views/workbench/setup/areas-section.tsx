import {
  AreaRole,
  pageLabel,
  type AreaDef,
  type PageRow,
  type ProjectDto,
  type WorkbenchSetupAreas,
} from '@10db/contracts';
import { Button, Checkbox, Code, Collapse, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useId } from 'react';
import { CountBadge } from '../../../shell/count-badge';
import { areasSummary } from './setup-rules';

export interface PageRowsProps {
  readonly pages: readonly PageRow[];
  readonly unticked: readonly string[];
  readonly onTick: (page: string, ticked: boolean) => void;
}

const SHOWN_FOLDERS = 2;

/** The first few of a page's folders and how many more, so a page with dozens of files stays one line. */
function foldersLine(folders: readonly string[]): string {
  const shown = folders.slice(0, SHOWN_FOLDERS).join(', ');
  const more = folders.length - SHOWN_FOLDERS;
  return more > 0 ? `${shown} and ${String(more)} more` : shown;
}

/**
 * A row per new page the builder may untick, named by the label it will save and its area name. A page
 * unticked here is left out: it is not made, and not asked for again.
 */
export function PageRows({ pages, unticked, onTick }: PageRowsProps) {
  if (pages.length === 0) return null;
  return (
    <Stack gap="xs">
      {pages.map((page) => (
        <Checkbox
          key={page.name}
          checked={!unticked.includes(page.name)}
          onChange={(event) => {
            onTick(page.name, event.currentTarget.checked);
          }}
          label={
            <>
              {`Make ${pageLabel(page)} (`}
              <Code>{page.name}</Code>
              {`)${
                page.route === undefined
                  ? ' a page, which no single path shows'
                  : ` a page at ${page.route}`
              }`}
            </>
          }
          description={foldersLine(page.folders)}
        />
      ))}
    </Stack>
  );
}

export interface AreasSectionProps {
  readonly project: ProjectDto;
  readonly areas: WorkbenchSetupAreas;
  /** The list Apply would save, with the unticked pages folded back. */
  readonly result: readonly AreaDef[];
  readonly unticked: readonly string[];
  readonly onTick: (page: string, ticked: boolean) => void;
  /** False when the Rebuild areas line above already says what the list comes to. */
  readonly summarized: boolean;
}

/**
 * The setup's Areas: what the rebuild comes to in one line, each new page as a row the builder may
 * untick, the other areas behind Show, and what is kept or left out with why.
 */
export function AreasSection({
  project,
  areas,
  result,
  unticked,
  onTick,
  summarized,
}: AreasSectionProps) {
  const [othersOpen, others] = useDisclosure(false);
  const othersId = useId();
  const rest = result.filter((a) => a.role !== AreaRole.Page);
  return (
    <Stack gap="sm" component="section" aria-labelledby={`${othersId}-title`}>
      <Title order={3} id={`${othersId}-title`}>
        Areas
      </Title>
      {summarized ? null : <Text size="sm">{areasSummary(project.areas, result)}</Text>}
      <PageRows pages={areas.pages} unticked={unticked} onTick={onTick} />
      {areas.kept.length === 0 ? null : (
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Kept as They Are
          </Text>
          {areas.kept.map((kept) => (
            <Text key={kept.name} size="sm" c="dimmed">
              <Code>{kept.name}</Code> {kept.reason}
            </Text>
          ))}
        </Stack>
      )}
      <div>
        <Button
          variant="subtle"
          size="compact-sm"
          px={0}
          aria-expanded={othersOpen}
          aria-controls={othersId}
          onClick={others.toggle}
          rightSection={othersOpen ? null : <CountBadge count={rest.length} />}
        >
          {othersOpen ? 'Hide Other Areas' : 'Show Other Areas'}
        </Button>
        <Collapse expanded={othersOpen} id={othersId}>
          <Stack gap={4} pt="xs">
            {rest.map((area) => (
              <Text key={area.name} size="sm" style={{ overflowWrap: 'anywhere' }}>
                <Code>{area.name}</Code>
                {area.role === AreaRole.Shared ? ' shared' : ''}
                {area.catchAll === true ? ' catch-all' : ''}: {area.globs.join(' ')}
              </Text>
            ))}
          </Stack>
        </Collapse>
      </div>
      {areas.skipped.length === 0 ? null : (
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Left Out
          </Text>
          {areas.skipped.map((skip) => (
            <Text key={`${skip.name}:${skip.reason}`} size="sm" c="dimmed">
              {`${skip.name}: ${skip.reason}`}
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

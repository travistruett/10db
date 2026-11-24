import {
  AreaRole,
  pageLabel,
  type AreaDef,
  type PageRow,
  type ProjectDto,
  type SplitRow,
  type WorkbenchSetupAreas,
} from '@10db/contracts';
import { Button, Checkbox, Code, Collapse, Group, Stack, Text } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { useId, useState } from 'react';
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

const SHOWN_PARTS = 3;

/**
 * A row per area open tasks name that splits along its packages: ticked, it becomes its core and one
 * area per package, and every open task naming it names all of them, so none loses a file.
 */
export function SplitRows({
  splits,
  unticked,
  onTick,
}: {
  readonly splits: readonly SplitRow[];
  readonly unticked: readonly string[];
  readonly onTick: (from: string, ticked: boolean) => void;
}) {
  if (splits.length === 0) return null;
  return (
    <Stack gap="xs">
      {splits.map((row) => {
        const [core, ...parts] = row.into;
        const shown = parts.slice(0, SHOWN_PARTS).map((p) => p.name);
        const more = parts.length - shown.length;
        return (
          <Checkbox
            key={row.from}
            checked={!unticked.includes(row.from)}
            onChange={(event) => {
              onTick(row.from, event.currentTarget.checked);
            }}
            label={
              <>
                {'Split '}
                <Code>{row.from}</Code>
                {` into ${String(row.into.length)} areas, one per package`}
              </>
            }
            description={`${core?.name ?? row.from} (core), ${shown.join(', ')}${
              more > 0 ? ` and ${String(more)} more` : ''
            }${
              row.tasks === 0
                ? ''
                : ` · ${String(row.tasks)} open ${row.tasks === 1 ? 'task gets' : 'tasks get'} all of them`
            }`}
          />
        );
      })}
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

/** One folded list under the changes: its name and count, opened in place. */
const Fold = {
  Kept: 'kept',
  Others: 'others',
  LeftOut: 'left-out',
} as const;
type Fold = (typeof Fold)[keyof typeof Fold];

/**
 * The setup's Areas: the changes alone (each new page as a row the builder may untick), then what stays
 * as it is, the other areas and what was left out, each folded to a count that opens in place.
 */
export function AreasSection({
  project,
  areas,
  result,
  unticked,
  onTick,
  summarized,
}: AreasSectionProps) {
  const [open, setOpen] = useState<Fold | null>(null);
  const id = useId();
  const rest = result.filter((a) => a.role !== AreaRole.Page);
  const folds = [
    { key: Fold.Kept, label: 'Kept as they are', count: areas.kept.length },
    { key: Fold.Others, label: 'Other areas', count: rest.length },
    { key: Fold.LeftOut, label: 'Left out', count: areas.skipped.length },
  ].filter((fold) => fold.count > 0);
  const toggle = (fold: Fold) => {
    setOpen((was) => (was === fold ? null : fold));
  };
  return (
    <Stack gap="sm" component="section" aria-label="Areas">
      {summarized ? null : <Text size="sm">{areasSummary(project.areas, result)}</Text>}
      <PageRows pages={areas.pages} unticked={unticked} onTick={onTick} />
      <SplitRows splits={areas.splits} unticked={unticked} onTick={onTick} />
      {folds.length === 0 ? null : (
        <Group gap="xs">
          {folds.map((fold) => (
            <Button
              key={fold.key}
              variant={open === fold.key ? 'light' : 'subtle'}
              color="gray"
              size="compact-sm"
              aria-expanded={open === fold.key}
              aria-controls={`${id}-${fold.key}`}
              onClick={() => {
                toggle(fold.key);
              }}
              rightSection={<CountBadge count={fold.count} />}
              leftSection={
                <IconChevronRight
                  size={14}
                  style={{
                    transform: open === fold.key ? 'rotate(90deg)' : undefined,
                    transition: 'transform 120ms',
                  }}
                />
              }
            >
              {fold.label}
            </Button>
          ))}
        </Group>
      )}
      <Collapse expanded={open === Fold.Kept} id={`${id}-${Fold.Kept}`}>
        <Stack gap={4} pl="xs">
          {areas.kept.map((kept) => (
            <Text key={kept.name} size="sm" c="dimmed">
              <Code>{kept.name}</Code> {kept.reason}
            </Text>
          ))}
        </Stack>
      </Collapse>
      <Collapse expanded={open === Fold.Others} id={`${id}-${Fold.Others}`}>
        <Stack gap={4} pl="xs">
          {rest.map((area) => (
            <Text key={area.name} size="sm" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
              <Code>{area.name}</Code>
              {area.role === AreaRole.Shared ? ' shared' : ''}
              {area.catchAll === true ? ' catch-all' : ''}: {area.globs.join(' ')}
            </Text>
          ))}
        </Stack>
      </Collapse>
      <Collapse expanded={open === Fold.LeftOut} id={`${id}-${Fold.LeftOut}`}>
        <Stack gap={4} pl="xs">
          {areas.skipped.map((skip) => (
            <Text key={`${skip.name}:${skip.reason}`} size="sm" c="dimmed">
              {`${skip.name}: ${skip.reason}`}
            </Text>
          ))}
        </Stack>
      </Collapse>
    </Stack>
  );
}

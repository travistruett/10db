import {
  PassLackKind,
  type PassLackDto,
  type PassStartDto,
  type ProjectViewDto,
} from '@10db/contracts';
import { Anchor, Group, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { SettingsSectionKey } from '../settings/sections';
import { tickedPages, type PickTicks } from './start-pass-rules';

export interface StartLinesProps {
  readonly ticks: PickTicks;
  readonly start: PassStartDto;
  readonly project: ProjectViewDto;
}

const plural = (count: number, one: string, many: string) =>
  `${String(count)} ${count === 1 ? one : many}`;

/** A lack in words, and whether Settings › General is where it is fixed. */
function lackLine(
  lack: PassLackDto,
  project: ProjectViewDto,
): { readonly text: string; readonly settings: boolean } {
  switch (lack.kind) {
    case PassLackKind.DockerOff:
      return { text: 'Docker is off: the gate needs it.', settings: true };
    case PassLackKind.AheadOfBase:
      return {
        text: `${lack.branch ?? 'This branch'} has ${plural(lack.count ?? 0, 'commit', 'commits')} origin/${project.baseBranch} lacks: the pull request will carry them.`,
        settings: false,
      };
    case PassLackKind.NoAppUrl:
      return { text: 'No app address: Open Page has nowhere to go.', settings: true };
    case PassLackKind.NoChangedCheck:
      return { text: 'No changed-files check: turns run unchecked.', settings: true };
  }
}

function Line({ children }: { readonly children: React.ReactNode }) {
  return (
    <Text size="sm" c="dimmed">
      {children}
    </Text>
  );
}

/**
 * What Start Pass says above its button (Workbench spec §4.2), each line only when it has something:
 * the changed files each ticked page takes in, the changed files that stay, what the project lacks
 * (none blocks the pass).
 */
export function StartLines({ ticks, start, project }: StartLinesProps) {
  const pages = tickedPages(ticks);
  const dirty = pages.flatMap((name) => {
    const page = start.pages.find((p) => p.area === name);
    return page && page.uncommitted > 0 ? [page] : [];
  });
  const lacks = start.lacks.map((lack) => lackLine(lack, project));
  if (dirty.length === 0 && start.otherUncommitted === 0 && lacks.length === 0) return null;
  return (
    <Stack gap={4}>
      {dirty.map((page) => (
        <Line key={page.area}>
          {`${page.area}: ${plural(page.uncommitted, 'file', 'files')} already changed in your folder will be part of this page's work.`}
        </Line>
      ))}
      {start.otherUncommitted > 0 ? (
        <Line>
          {start.otherUncommitted === 1
            ? '1 other changed file stays as it is.'
            : `${String(start.otherUncommitted)} other changed files stay as they are.`}
        </Line>
      ) : null}
      {lacks.map((lack) => (
        <Group key={lack.text} gap="xs" wrap="nowrap">
          <Line>{lack.text}</Line>
          {lack.settings ? (
            <Anchor
              size="sm"
              renderRoot={(props) => (
                <Link
                  {...props}
                  to="/settings/$section"
                  params={{ section: SettingsSectionKey.General }}
                />
              )}
            >
              Open Settings
            </Anchor>
          ) : null}
        </Group>
      ))}
    </Stack>
  );
}

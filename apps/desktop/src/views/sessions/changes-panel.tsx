import type { ChangedFileDto, WorkstreamChangesDto } from '@10db/contracts';
import { Anchor, Box, Group, ScrollArea, Stack, Text } from '@mantine/core';
import type { UseQueryResult } from '@tanstack/react-query';
import { HunkDiff } from '../../conversation/hunk-diff';
import type { GutterLine } from '../../conversation/hunk-gutter';
import { ExternalLink } from '../board/pull-request-link';
import { changesTotals, parseChanges } from './changes-files';

// A session's changes in the Changes drawer: a jump list of files, then every file's diff under a sticky
// header. A number quotes its line into the composer. The diff is repository text, drawn as text.

export interface ChangesPanelProps {
  readonly changes: UseQueryResult<WorkstreamChangesDto>;
  /** The pull request, which has the changes once the worktree is gone. */
  readonly pullRequest: string | null;
  /** The quote to put in the composer for a clicked line. */
  readonly onQuote: (text: string) => void;
}

/**
 * `@path:42` and the line, as a quote the agent reads. A removed line's number counts the old file, so it
 * says so instead of pointing at a line the file no longer has.
 */
function quoteOf(path: string, line: GutterLine): string {
  const at =
    line.kind === 'removed'
      ? `@${path} (line ${String(line.number)} before the change, removed)`
      : `@${path}:${String(line.number)}`;
  return `${at}\n> ${line.text}\n`;
}

/** What a line's number button is called: removed and added lines of one number are told apart. */
function quoteLabelOf(path: string, line: GutterLine): string {
  const kind = line.kind === 'context' ? '' : `${line.kind} `;
  return `Quote ${kind}line ${String(line.number)} of ${path}`;
}

function Files({
  files,
  statuses,
}: {
  readonly files: readonly ChangedFileDto[];
  readonly statuses: ReadonlyMap<string, string>;
}) {
  return (
    <Stack
      gap={0}
      component="ul"
      m={0}
      p={0}
      style={{ listStyle: 'none' }}
      aria-label="Changed files"
    >
      {files.map((file) => (
        <li key={file.path}>
          <Anchor
            href={`#changes-${file.path}`}
            underline="never"
            c="inherit"
            onClick={(event) => {
              event.preventDefault();
              document.getElementById(`changes-${file.path}`)?.scrollIntoView({ block: 'start' });
            }}
          >
            <Group gap="xs" wrap="nowrap" justify="space-between" px="md">
              <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 'none' }}>
                {statuses.get(file.path) ?? 'M'}
              </Text>
              <Text size="xs" ff="monospace" truncate style={{ minWidth: 0, flex: 1 }}>
                {file.path}
              </Text>
              <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 'none' }}>
                {file.added === null
                  ? 'binary'
                  : `+${String(file.added)} −${String(file.removed ?? 0)}`}
              </Text>
            </Group>
          </Anchor>
        </li>
      ))}
    </Stack>
  );
}

export function ChangesPanel({ changes, pullRequest, onQuote }: ChangesPanelProps) {
  const data = changes.data;
  const totals = data === undefined ? null : changesTotals(data.files);
  const diffs = data === undefined ? [] : parseChanges(data.diff);
  return (
    <Box
      aria-label="Changes"
      role="region"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <Group pb="xs" justify="space-between" wrap="wrap" style={{ flex: 'none' }}>
        <Text size="xs" c="dimmed">
          {totals === null
            ? ''
            : `${String(totals.files)} ${totals.files === 1 ? 'file' : 'files'} +${String(totals.added)} −${String(totals.removed)}`}
        </Text>
        <Text size="xs" c="dimmed">
          {data === undefined ? '' : `against ${data.baseHead.slice(0, 7)}`}
        </Text>
      </Group>
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        {changes.isPending ? (
          <Text size="sm" c="dimmed" px="md" role="status">
            Reading the changes…
          </Text>
        ) : changes.isError ? (
          pullRequest === null ? (
            <Text size="sm" c="red" px="md">
              {changes.error.message}
            </Text>
          ) : (
            <Stack gap="xs" px="md">
              <Text size="sm">
                This session’s worktree is gone. Its pull request has the changes.
              </Text>
              <Group>
                <ExternalLink url={pullRequest} label="Open Pull Request" />
              </Group>
            </Stack>
          )
        ) : data?.files.length === 0 ? (
          <Text size="sm" c="dimmed" px="md">
            No changes yet.
          </Text>
        ) : data === undefined ? null : (
          <Stack gap="md" pb="md">
            <Files
              files={data.files}
              statuses={new Map(diffs.map((file) => [file.path, file.status]))}
            />
            {diffs.map((file) => (
              <Box key={file.path} id={`changes-${file.path}`}>
                <Text
                  size="xs"
                  ff="monospace"
                  fw={600}
                  px="md"
                  py={4}
                  style={{
                    position: 'sticky',
                    top: 0,
                    background: 'var(--mantine-color-body)',
                    zIndex: 1,
                  }}
                >
                  {`${file.status}  ${file.path}`}
                </Text>
                <Stack gap="xs" px="md">
                  {file.hunks.map((hunk, index) => (
                    <HunkDiff
                      key={`${String(hunk.oldStart)}:${String(hunk.newStart)}:${String(index)}`}
                      hunk={hunk}
                      first={index === 0}
                      onQuote={(line) => {
                        onQuote(quoteOf(file.path, line));
                      }}
                      quoteLabel={(line) => quoteLabelOf(file.path, line)}
                    />
                  ))}
                </Stack>
              </Box>
            ))}
            {data.truncated ? (
              <Text size="xs" c="dimmed" px="md">
                The diff is longer than we show. The file list above is complete.
              </Text>
            ) : null}
          </Stack>
        )}
      </ScrollArea>
    </Box>
  );
}

import type { ChangedFileDto, WorkstreamChangesDto } from '@10db/contracts';
import { Box, Group, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import type { UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';
import { HunkDiff } from '../../conversation/hunk-diff';
import type { GutterLine } from '../../conversation/hunk-gutter';
import { ExternalLink } from '../board/pull-request-link';
import { changesTotals, parseChanges, type ChangedFileView } from './changes-files';
import classes from './changes-panel.module.css';

// A session's changes in the Changes drawer: every file as a fold, its header sticky while its diff scrolls,
// the first open. A number quotes its line into the composer. The diff is repository text, drawn as text.

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

/** One file's fold: its header row (status, path, lines changed) and, while open, its hunks. */
function FileFold({
  file,
  view,
  open,
  onToggle,
  onQuote,
}: {
  readonly file: ChangedFileDto;
  /** Its part of the diff; absent when the diff was cut before it. */
  readonly view: ChangedFileView | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onQuote: (text: string) => void;
}) {
  const bodyId = `changes-${file.path}`;
  return (
    <li>
      <UnstyledButton
        className={classes['head']}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <IconChevronDown
          size={12}
          stroke={2}
          className={classes['chevron']}
          data-open={open ? '' : undefined}
          aria-hidden="true"
        />
        <span className={classes['status']}>{view?.status ?? 'M'}</span>
        <span className={classes['path']}>{file.path}</span>
        <span className={classes['lines']}>
          {file.added === null ? 'binary' : `+${String(file.added)} −${String(file.removed ?? 0)}`}
        </span>
      </UnstyledButton>
      {open ? (
        <Stack gap="xs" pt={4} pb="sm" id={bodyId}>
          {view === undefined || view.hunks.length === 0 ? (
            <Text size="xs" c="dimmed">
              {file.added === null ? 'A binary file.' : 'Past the part of the diff we show.'}
            </Text>
          ) : (
            view.hunks.map((hunk, index) => (
              <HunkDiff
                key={`${String(hunk.oldStart)}:${String(hunk.newStart)}:${String(index)}`}
                hunk={hunk}
                first={index === 0}
                onQuote={(line) => {
                  onQuote(quoteOf(file.path, line));
                }}
                quoteLabel={(line) => quoteLabelOf(file.path, line)}
              />
            ))
          )}
        </Stack>
      ) : null}
    </li>
  );
}

export function ChangesPanel({ changes, pullRequest, onQuote }: ChangesPanelProps) {
  const data = changes.data;
  const totals = data === undefined ? null : changesTotals(data.files);
  const views = new Map(
    (data === undefined ? [] : parseChanges(data.diff)).map((file) => [file.path, file]),
  );
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(() => new Set());
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
          <Text size="sm" c="dimmed" role="status">
            Reading the changes…
          </Text>
        ) : changes.isError ? (
          pullRequest === null ? (
            <Text size="sm" c="red">
              {changes.error.message}
            </Text>
          ) : (
            <Stack gap="xs">
              <Text size="sm">
                This session’s worktree is gone. Its pull request has the changes.
              </Text>
              <Group>
                <ExternalLink url={pullRequest} label="Open Pull Request" />
              </Group>
            </Stack>
          )
        ) : data?.files.length === 0 ? (
          <Text size="sm" c="dimmed">
            No changes yet.
          </Text>
        ) : data === undefined ? null : (
          <Stack gap={0} pb="md">
            <Stack
              gap={0}
              component="ul"
              m={0}
              p={0}
              style={{ listStyle: 'none' }}
              aria-label="Changed files"
            >
              {data.files.map((file, index) => (
                <FileFold
                  key={file.path}
                  file={file}
                  view={views.get(file.path)}
                  // The first file starts open and the rest folded; a click flips one from where it started.
                  open={(index === 0) !== flipped.has(file.path)}
                  onToggle={() => {
                    setFlipped((was) => {
                      const next = new Set(was);
                      if (!next.delete(file.path)) next.add(file.path);
                      return next;
                    });
                  }}
                  onQuote={onQuote}
                />
              ))}
            </Stack>
            {data.truncated ? (
              <Text size="xs" c="dimmed">
                The diff is longer than we show. The file list is complete.
              </Text>
            ) : null}
          </Stack>
        )}
      </ScrollArea>
    </Box>
  );
}

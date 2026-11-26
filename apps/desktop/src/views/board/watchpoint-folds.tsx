import {
  WatchpointLoudness,
  type WatchpointFileView,
  type WatchpointHitsDto,
  type WorkstreamId,
} from '@10db/contracts';
import { Accordion, Badge, Box, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { HunkDiff } from '../../conversation/hunk-diff';
import { useWorkstreamChanges } from '../../daemon/queries';
import { ChangesPanel } from '../sessions/changes-panel';
import { parseChanges } from '../sessions/changes-files';

// The folds of a watchpoint reading, one per watchpoint, each file with the agent's reason, the reviewer's check and
// only its matching hunks. The task's For You and the Inbox's Look card both draw them.

const LOUDNESS_COLOR: Readonly<Record<WatchpointLoudness, string>> = {
  [WatchpointLoudness.Show]: 'gray',
  [WatchpointLoudness.Ask]: 'yellow',
  [WatchpointLoudness.Hold]: 'red',
};

const LOUDNESS_LABEL: Readonly<Record<WatchpointLoudness, string>> = {
  [WatchpointLoudness.Show]: 'Show',
  [WatchpointLoudness.Ask]: 'Ask',
  [WatchpointLoudness.Hold]: 'Hold',
};

export type Hit = WatchpointHitsDto['hits'][number];

export const count = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** The reviewer's ✓ reads green and its ⚠ yellow. */
function checkTone(note: string): 'green' | 'yellow' | undefined {
  if (note.startsWith('✓')) return 'green';
  return note.startsWith('⚠') ? 'yellow' : undefined;
}

/** One row of a file's notes: who wrote it, then what they wrote, in the notes' two columns. */
function Note({
  who,
  children,
  tone,
}: {
  readonly who: string;
  readonly children: string;
  readonly tone?: 'green' | 'yellow' | undefined;
}) {
  return (
    <>
      <Text size="xs" fw={600} c="dimmed">
        {who}
      </Text>
      <Text
        size="sm"
        {...(tone === undefined ? {} : { c: tone })}
        style={{ overflowWrap: 'anywhere', minWidth: 0 }}
      >
        {children}
      </Text>
    </>
  );
}

/** The Eval, Agent and Reviewer notes in two columns, the names in one and the notes in the other. */
const NOTES_GRID = {
  display: 'grid',
  gridTemplateColumns: '64px minmax(0, 1fr)',
  columnGap: 'var(--mantine-spacing-xs)',
  rowGap: 'var(--mantine-spacing-xs)',
  alignItems: 'baseline',
} as const;

/** A file after the first starts under a hairline, with as much room above it as below. */
const NEXT_FILE = {
  borderTop: '1px solid var(--mantine-color-default-border)',
  paddingTop: 'var(--mantine-spacing-lg)',
} as const;

function FileHunks({
  file,
  first,
}: {
  readonly file: WatchpointFileView;
  readonly first: boolean;
}) {
  const hunks = parseChanges(file.patch).flatMap((f) => f.hunks);
  const notes =
    file.evalDefinition !== undefined || file.agentNote !== null || file.reviewerNote !== null;
  return (
    <Stack gap="sm" role="listitem" style={first ? undefined : NEXT_FILE}>
      <Group gap="xs" wrap="nowrap">
        <Text size="sm" ff="monospace" style={{ overflowWrap: 'anywhere' }}>
          {file.path}
        </Text>
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
          {file.status === 'A'
            ? 'new'
            : file.added === null
              ? 'binary'
              : `+${String(file.added)} −${String(file.removed ?? 0)}`}
        </Text>
      </Group>
      {notes ? (
        <Box style={NOTES_GRID}>
          {file.evalDefinition === undefined ? null : (
            <Note who="Eval">{file.evalDefinition.reason}</Note>
          )}
          {file.agentNote === null ? null : <Note who="Agent">{file.agentNote}</Note>}
          {file.reviewerNote === null ? null : (
            <Note who="Reviewer" tone={checkTone(file.reviewerNote)}>
              {file.reviewerNote}
            </Note>
          )}
        </Box>
      ) : null}
      {hunks.map((hunk, index) => (
        <HunkDiff
          key={`${String(hunk.oldStart)}:${String(hunk.newStart)}:${String(index)}`}
          hunk={hunk}
          first={index === 0}
        />
      ))}
      {file.clipped ? (
        <Text size="xs" c="dimmed">
          {hunks.length === 0
            ? 'The changes in this file are past what 10db keeps.'
            : 'Cut where 10db stops keeping the changes.'}
        </Text>
      ) : null}
    </Stack>
  );
}

function Fold({ hit }: { readonly hit: Hit }) {
  const { watchpoint, files } = hit;
  return (
    <Accordion.Item value={watchpoint.key}>
      <Accordion.Control>
        <Group gap="xs" wrap="nowrap">
          <Text size="sm" fw={600}>
            {watchpoint.label}
          </Text>
          <Badge size="xs" variant="light" color={LOUDNESS_COLOR[watchpoint.loudness]}>
            {LOUDNESS_LABEL[watchpoint.loudness]}
          </Badge>
          <Text size="xs" c="dimmed">
            {count(files.length, 'file', 'files')}
          </Text>
        </Group>
      </Accordion.Control>
      <Accordion.Panel>
        <Stack gap="md">
          {watchpoint.guidance === '' ? null : (
            <Text size="sm" c="dimmed">
              You asked: {watchpoint.guidance}
            </Text>
          )}
          <Stack gap="lg" role="list" aria-label={`Files under ${watchpoint.label}`}>
            {files.map((file, index) => (
              <FileHunks key={file.path} file={file} first={index === 0} />
            ))}
          </Stack>
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}

/** Full Diff: the run's whole change in a modal. `size` fits it to where it sits: a card's bar, or a section head. */
export function WholeDiff({
  workstreamId,
  size = 'sm',
}: {
  readonly workstreamId: WorkstreamId;
  readonly size?: 'sm' | 'compact-xs';
}) {
  const [open, setOpen] = useState(false);
  const changes = useWorkstreamChanges(open ? workstreamId : undefined, null);
  return (
    <>
      <Button
        variant="default"
        size={size}
        onClick={() => {
          setOpen(true);
        }}
      >
        Full Diff
      </Button>
      <Modal
        opened={open}
        onClose={() => {
          setOpen(false);
        }}
        title="Changes"
        size="xl"
      >
        <ChangesPanel changes={changes} pullRequest={null} onQuote={() => undefined} />
      </Modal>
    </>
  );
}

/** The reading's folds. `open` says which start open: those that ask or hold, or all of them. */
export function WatchpointFolds({
  hits,
  open,
}: {
  readonly hits: readonly Hit[];
  readonly open: 'asked' | 'all';
}) {
  return (
    <Accordion
      multiple
      variant="separated"
      defaultValue={hits
        .filter((h) => open === 'all' || h.watchpoint.loudness !== WatchpointLoudness.Show)
        .map((h) => h.watchpoint.key)}
    >
      {hits.map((hit) => (
        <Fold key={hit.watchpoint.key} hit={hit} />
      ))}
    </Accordion>
  );
}

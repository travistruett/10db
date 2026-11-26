import {
  WatchpointLoudness,
  type WatchpointFileView,
  type WatchpointHitsDto,
  type WorkstreamId,
} from '@10db/contracts';
import { Accordion, Badge, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { HunkDiff } from '../../conversation/hunk-diff';
import { useWorkstreamChanges } from '../../daemon/queries';
import { useWatchpointHits } from '../../daemon/watchpoint-queries';
import { ChangesPanel } from '../sessions/changes-panel';
import { parseChanges } from '../sessions/changes-files';

// A task's For You: the changes that touch what the builder watches, one fold per watchpoint, each file with the
// agent's reason, the reviewer's check and only its matching hunks. The hunks are kept with the run, so a task
// that is Done still shows them. A run that touched nothing the builder watches shows nothing.

const LOUDNESS_COLOR: Readonly<Record<WatchpointLoudness, string>> = {
  [WatchpointLoudness.Show]: 'gray',
  [WatchpointLoudness.Ask]: 'yellow',
  [WatchpointLoudness.Hold]: 'red',
};

type Hit = WatchpointHitsDto['hits'][number];

const count = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** The reviewer's ✓ reads green and its ⚠ yellow. */
function checkTone(note: string): 'green' | 'yellow' | undefined {
  if (note.startsWith('✓')) return 'green';
  return note.startsWith('⚠') ? 'yellow' : undefined;
}

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
    <Group gap={6} align="baseline" wrap="nowrap">
      <Text size="xs" fw={600} c="dimmed" w={64} style={{ flexShrink: 0 }}>
        {who}
      </Text>
      <Text
        size="sm"
        {...(tone === undefined ? {} : { c: tone })}
        style={{ overflowWrap: 'anywhere' }}
      >
        {children}
      </Text>
    </Group>
  );
}

function FileHunks({ file }: { readonly file: WatchpointFileView }) {
  const hunks = parseChanges(file.patch).flatMap((f) => f.hunks);
  return (
    <Stack gap={6} role="listitem">
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
      {file.evalDefinition === undefined ? null : (
        <Note who="Eval">{file.evalDefinition.reason}</Note>
      )}
      {file.agentNote === null ? null : <Note who="Agent">{file.agentNote}</Note>}
      {file.reviewerNote === null ? null : (
        <Note who="Reviewer" tone={checkTone(file.reviewerNote)}>
          {file.reviewerNote}
        </Note>
      )}
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
            {watchpoint.loudness}
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
          <Stack gap="md" role="list" aria-label={`Files under ${watchpoint.label}`}>
            {files.map((file) => (
              <FileHunks key={file.path} file={file} />
            ))}
          </Stack>
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}

function WholeDiff({ workstreamId }: { readonly workstreamId: WorkstreamId }) {
  const [open, setOpen] = useState(false);
  const changes = useWorkstreamChanges(open ? workstreamId : undefined, null);
  return (
    <>
      <Button
        variant="subtle"
        size="compact-xs"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open the whole diff
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

export function TaskForYou({ workstreamId }: { readonly workstreamId: WorkstreamId | undefined }) {
  const reading = useWatchpointHits(workstreamId).data;
  if (workstreamId === undefined || reading === undefined) return null;
  if (reading.skipped !== null)
    return (
      <Stack gap={4}>
        <Text size="xs" fw={600} c="dimmed" tt="uppercase">
          For You
        </Text>
        <Text size="sm" c="dimmed">
          Couldn&apos;t read this run&apos;s changes.
        </Text>
      </Stack>
    );
  if (reading.hits.length === 0) return null;
  const files = reading.hits.reduce((n, h) => n + h.files.length, 0);
  return (
    <Stack gap="xs" data-testid="for-you">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs">
          <Text size="xs" fw={600} c="dimmed" tt="uppercase">
            For You
          </Text>
          <Text size="xs" c="dimmed">
            {`${count(reading.hits.length, 'watchpoint', 'watchpoints')} · ${count(files, 'file', 'files')}`}
          </Text>
        </Group>
        {reading.canOpenDiff ? <WholeDiff workstreamId={workstreamId} /> : null}
      </Group>
      <Accordion
        multiple
        variant="separated"
        defaultValue={reading.hits
          .filter((h) => h.watchpoint.loudness !== WatchpointLoudness.Show)
          .map((h) => h.watchpoint.key)}
      >
        {reading.hits.map((hit) => (
          <Fold key={hit.watchpoint.key} hit={hit} />
        ))}
      </Accordion>
    </Stack>
  );
}

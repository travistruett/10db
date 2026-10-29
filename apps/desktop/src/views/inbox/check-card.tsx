import { CheckChoice, type InboxItemDto, type WorkstreamId } from '@10db/contracts';
import {
  Alert,
  Button,
  Code,
  Group,
  List,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { useState, type ReactNode } from 'react';
import {
  useAnswerInbox,
  useTasks,
  useWorkstreamChanges,
  useWorkstreams,
} from '../../daemon/queries';
import { SELECTED_CARD_ATTRIBUTE } from './use-inbox-keys';

const SHORT_SHA = 7;

export interface CheckCardProps {
  readonly item: InboxItemDto;
  /** The kind badge and title, laid out as on every other expanded card. */
  readonly header: ReactNode;
}

/** The criteria the task set, so the builder checks the work against them. */
function Criteria({
  item,
  workstreamId,
}: {
  readonly item: InboxItemDto;
  readonly workstreamId: WorkstreamId;
}) {
  const workstreams = useWorkstreams({ active: true });
  const tasks = useTasks(item.projectId);
  const taskId = workstreams.data?.find((w) => w.id === workstreamId)?.taskId;
  const criteria = tasks.data?.find((t) => t.id === taskId)?.acceptanceCriteria ?? [];
  if (criteria.length === 0) return null;
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        Acceptance criteria
      </Text>
      <List size="sm" spacing={2}>
        {criteria.map((criterion) => (
          <List.Item key={criterion}>{criterion}</List.Item>
        ))}
      </List>
    </Stack>
  );
}

/** Commits, changed files with their counts and the diff; all of it is repository text, shown only as text. */
function Changes({ workstreamId }: { readonly workstreamId: WorkstreamId }) {
  const changes = useWorkstreamChanges(workstreamId);
  if (changes.isError)
    return (
      <Alert color="red" variant="light" title="Couldn't load the changes">
        {changes.error.message}
      </Alert>
    );
  if (!changes.isSuccess)
    return (
      <Text size="sm" c="dimmed">
        Loading the changes…
      </Text>
    );
  const { commits, files, diff, truncated } = changes.data;
  return (
    <>
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Commits
        </Text>
        <Group gap="xs">
          {commits.map((sha) => (
            <Code key={sha}>{sha.slice(0, SHORT_SHA)}</Code>
          ))}
        </Group>
      </Stack>
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Files
        </Text>
        <List size="sm" spacing={2} listStyleType="none">
          {files.map((file) => (
            <List.Item key={file.path}>
              <Group gap="xs" wrap="nowrap">
                <Text size="sm" ff="monospace">
                  {file.path}
                </Text>
                {file.added === null || file.removed === null ? null : (
                  <>
                    <Text size="sm" c="green" ff="monospace">{`+${String(file.added)}`}</Text>
                    <Text size="sm" c="red" ff="monospace">{`-${String(file.removed)}`}</Text>
                  </>
                )}
              </Group>
            </List.Item>
          ))}
        </List>
      </Stack>
      <ScrollArea.Autosize mah={360} type="auto" offsetScrollbars>
        <Code block tabIndex={0} aria-label="Diff" style={{ whiteSpace: 'pre' }}>
          {diff}
        </Code>
      </ScrollArea.Autosize>
      {truncated ? (
        <Text size="sm" c="dimmed">
          The diff is longer than we show. The file list above is complete.
        </Text>
      ) : null}
    </>
  );
}

/**
 * Finished work the project has no gate for: the builder checks the changes and either approves
 * them or sends them back with a note saying what to fix.
 */
export function CheckCard({ item, header }: CheckCardProps) {
  const answer = useAnswerInbox();
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState('');
  const workstreamId = item.targets[0]?.workstreamId;
  const trimmed = note.trim();

  const approve = (): void => {
    answer.mutate({ id: item.id, answer: { choice: CheckChoice.Approve } });
  };
  const sendBack = (): void => {
    if (trimmed === '') return;
    answer.mutate({ id: item.id, answer: { choice: CheckChoice.SendBack, note: trimmed } });
  };

  return (
    <Paper withBorder p="md" shadow="xs" {...{ [SELECTED_CARD_ATTRIBUTE]: true }}>
      <Stack gap="sm">
        {header}
        {item.body === '' ? null : <Text size="sm">{item.body}</Text>}
        {workstreamId === undefined ? null : (
          <>
            <Criteria item={item} workstreamId={workstreamId} />
            <Changes workstreamId={workstreamId} />
          </>
        )}
        {sendingBack ? (
          <Textarea
            label="What needs to change"
            description="The agent gets this note with the work."
            autosize
            minRows={2}
            data-autofocus
            value={note}
            onChange={(e) => {
              setNote(e.currentTarget.value);
            }}
          />
        ) : null}
        {answer.isError ? (
          <Alert color="red" variant="light">
            {answer.error.message}
          </Alert>
        ) : null}
        <Group justify="flex-end">
          {sendingBack ? (
            <>
              <Button
                variant="default"
                onClick={() => {
                  setSendingBack(false);
                }}
              >
                Cancel
              </Button>
              <Button
                color="red"
                loading={answer.isPending}
                disabled={trimmed === ''}
                onClick={sendBack}
              >
                Send It Back
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="default"
                disabled={answer.isPending}
                onClick={() => {
                  setSendingBack(true);
                }}
              >
                Send Back
              </Button>
              <Button loading={answer.isPending} onClick={approve}>
                Approve
              </Button>
            </>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}

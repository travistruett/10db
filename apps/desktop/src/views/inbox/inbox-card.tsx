import { InboxKind, type InboxItemDto } from '@10db/contracts';
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Kbd,
  Paper,
  Radio,
  Stack,
  Text,
  Textarea,
  UnstyledButton,
} from '@mantine/core';
import type { KeyboardEvent, RefObject } from 'react';
import { McpApprovalDetails, mcpReview } from './mcp-approval';
import { SELECTED_CARD_ATTRIBUTE } from './use-inbox-keys';
import { KIND_LABELS, optionLabel } from './permission-labels';

export interface InboxCardProps {
  readonly item: InboxItemDto;
  readonly selected: boolean;
  readonly choice: string | null;
  readonly note: string;
  readonly error: string | null;
  readonly pending: boolean;
  readonly noteRef: RefObject<HTMLTextAreaElement | null>;
  readonly onSelect: () => void;
  readonly onChoose: (choice: string) => void;
  readonly onNote: (note: string) => void;
  readonly onNoteFocus: () => void;
  readonly onSubmit: () => void;
}

/** Card text is untrusted (agent and tool output): it is only ever rendered as text. */
function CardBody({ item }: { readonly item: InboxItemDto }) {
  if (item.body === '') return null;
  if (item.kind === InboxKind.Permission) {
    return (
      <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {item.body}
      </Code>
    );
  }
  return (
    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
      {item.body}
    </Text>
  );
}

// Destructured: reading `props.x` in render, with a ref among the props, trips react-hooks/refs.
export function InboxCard({
  item,
  selected,
  choice,
  note,
  error,
  pending,
  noteRef,
  onSelect,
  onChoose,
  onNote,
  onNoteFocus,
  onSubmit,
}: InboxCardProps) {
  const review = mcpReview(item);
  const kind = (
    <Badge
      size="sm"
      variant="light"
      color={item.kind === InboxKind.Flag && !review ? 'red' : 'yellow'}
    >
      {review ? 'MCP server' : KIND_LABELS[item.kind]}
    </Badge>
  );

  if (!selected) {
    return (
      <UnstyledButton
        onClick={onSelect}
        p="sm"
        style={{
          borderRadius: 'var(--mantine-radius-md)',
          border: '1px solid var(--mantine-color-default-border)',
        }}
      >
        <Group gap="sm" wrap="nowrap">
          {kind}
          <Text size="sm" lineClamp={1}>
            {item.title}
          </Text>
        </Group>
      </UnstyledButton>
    );
  }

  const sendFromNote = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit();
    }
  };
  const hasOptions = item.options.length > 0;

  return (
    <Paper withBorder p="md" shadow="xs" {...{ [SELECTED_CARD_ATTRIBUTE]: true }}>
      <Stack gap="sm">
        <Group gap="sm" wrap="nowrap">
          {kind}
          <Text fw={600}>{item.title}</Text>
        </Group>
        {review ? (
          <McpApprovalDetails review={review} body={item.body} />
        ) : (
          <CardBody item={item} />
        )}
        {hasOptions ? (
          <Radio.Group value={choice} onChange={onChoose} aria-label="Answer">
            <Stack gap="xs">
              {item.options.map((option, index) => (
                <Radio.Card key={option.label} value={option.label} p="sm">
                  <Group wrap="nowrap" align="flex-start">
                    <Radio.Indicator />
                    {index < 4 ? <Kbd size="xs">{index + 1}</Kbd> : null}
                    <div>
                      <Group gap="xs">
                        <Text size="sm" fw={500}>
                          {optionLabel(item, option)}
                        </Text>
                        {item.recommendation === option.label ? (
                          <Badge size="xs" variant="outline">
                            Recommended
                          </Badge>
                        ) : null}
                      </Group>
                      {option.description ? (
                        <Text size="xs" c="dimmed">
                          {option.description}
                        </Text>
                      ) : null}
                    </div>
                  </Group>
                </Radio.Card>
              ))}
            </Stack>
          </Radio.Group>
        ) : null}
        {hasOptions ? (
          <Textarea
            ref={noteRef}
            label="Note for the agent (optional)"
            autosize
            minRows={1}
            value={note}
            onChange={(e) => {
              onNote(e.currentTarget.value);
            }}
            onFocus={onNoteFocus}
            onKeyDown={sendFromNote}
          />
        ) : null}
        {error ? (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        ) : null}
        <Group justify="flex-end">
          <Button size="sm" loading={pending} onClick={onSubmit}>
            {hasOptions ? 'Send answer' : 'Dismiss'}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

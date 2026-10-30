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
import { ExternalLink } from '../board/pull-request-link';
import { CheckCard } from './check-card';
import { isDismissable } from './inbox-rows';
import { McpApprovalDetails, mcpReview } from './mcp-approval';
import { SELECTED_CARD_ATTRIBUTE } from './use-inbox-keys';
import { KIND_LABELS, optionLabel } from './permission-labels';

export interface InboxCardProps {
  readonly item: InboxItemDto;
  /** How many identical flags the row stands for; 1 for any other card. */
  readonly count: number;
  readonly selected: boolean;
  readonly choice: string | null;
  readonly note: string;
  readonly error: string | null;
  readonly pending: boolean;
  readonly noteRef: RefObject<HTMLTextAreaElement | null>;
  readonly onSelect: () => void;
  readonly onChoose: (choice: string) => void;
  readonly onNote: (note: string) => void;
  /** What the builder typed for sending a check card back; kept while another card is open. */
  readonly sendBackNote: string;
  readonly onSendBackNote: (note: string) => void;
  readonly onNoteFocus: () => void;
  readonly onSubmit: () => void;
  /** Dismisses the row's flags; only offered for a flag with no options. */
  readonly onDismiss: () => void;
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

/** The pages the desktop app's opener may open, as its capability (`opener:allow-open-url`) says. */
const GITHUB_PAGE = 'https://github.com/';

/**
 * The page a flag card offers to open (`detail.link`, such as a failing check): a github.com page
 * only. The daemon's text is not trusted to be a link, and the desktop app opens nothing else, so a
 * check elsewhere (a third-party CI) gets no button; the card's body holds its address regardless.
 */
function cardLink(item: InboxItemDto): string | null {
  if (item.kind !== InboxKind.Flag) return null;
  const link = item.detail?.['link'];
  return typeof link === 'string' && link.startsWith(GITHUB_PAGE) ? link : null;
}

// Destructured: reading `props.x` in render, with a ref among the props, trips react-hooks/refs.
export function InboxCard({
  item,
  count,
  selected,
  choice,
  note,
  error,
  pending,
  noteRef,
  onSelect,
  onChoose,
  onNote,
  sendBackNote,
  onSendBackNote,
  onNoteFocus,
  onSubmit,
  onDismiss,
}: InboxCardProps) {
  const review = mcpReview(item);
  const dismissable = isDismissable(item);
  // Every card waits on the builder, a flag included: yellow, never the red of a failure.
  const kind = (
    <Badge size="sm" variant="light" color="yellow" style={{ flexShrink: 0 }}>
      {review ? 'MCP server' : KIND_LABELS[item.kind]}
    </Badge>
  );
  const times =
    count > 1 ? (
      <Badge size="sm" variant="default" style={{ flexShrink: 0 }}>
        ×{count}
      </Badge>
    ) : null;
  // The row's count in words, so the number in the sidebar has an explanation on screen.
  const identical = count > 1 ? `${String(count)} identical flags` : null;

  if (!selected) {
    // What a flag is about, such as a path, is its body's first line.
    const about = item.kind === InboxKind.Flag ? (item.body.split('\n')[0] ?? '') : '';
    return (
      <Group
        gap="xs"
        wrap="nowrap"
        pr="xs"
        style={{
          borderRadius: 'var(--mantine-radius-md)',
          border: '1px solid var(--mantine-color-default-border)',
        }}
      >
        <UnstyledButton onClick={onSelect} p="sm" style={{ flex: 1, minWidth: 0 }}>
          <Group gap="sm" wrap="nowrap">
            {kind}
            {times}
            <Text size="sm" lineClamp={1} title={item.title} style={{ minWidth: 0 }}>
              {item.title}
            </Text>
            {identical === null ? null : (
              <Text size="xs" c="dimmed" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                {identical}
              </Text>
            )}
            {about === '' ? null : (
              <Text size="sm" c="dimmed" ff="monospace" lineClamp={1} style={{ minWidth: 0 }}>
                {about}
              </Text>
            )}
          </Group>
        </UnstyledButton>
        {dismissable && error !== null ? (
          <Text size="xs" c="red" lineClamp={1}>
            {error}
          </Text>
        ) : null}
        {dismissable ? (
          <Button size="xs" variant="subtle" loading={pending} onClick={onDismiss}>
            {count > 1 ? 'Dismiss All' : 'Dismiss'}
          </Button>
        ) : null}
      </Group>
    );
  }

  if (item.kind === InboxKind.Check) {
    return (
      <CheckCard
        item={item}
        note={sendBackNote}
        onNote={onSendBackNote}
        header={
          <Group gap="sm" wrap="nowrap">
            {kind}
            {times}
            <Text fw={600} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              {item.title}
            </Text>
          </Group>
        }
      />
    );
  }

  const sendFromNote = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit();
    }
  };
  const hasOptions = item.options.length > 0;
  const link = cardLink(item);

  return (
    <Paper withBorder p="md" shadow="xs" {...{ [SELECTED_CARD_ATTRIBUTE]: true }}>
      <Stack gap="sm">
        <Group gap="sm" wrap="nowrap">
          {kind}
          {times}
          <Text fw={600} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            {item.title}
          </Text>
        </Group>
        {identical === null ? null : (
          <Text size="sm" c="dimmed">
            {identical} are open. Dismiss All closes all {count}.
          </Text>
        )}
        {review ? (
          <McpApprovalDetails review={review} body={item.body} />
        ) : (
          <CardBody item={item} />
        )}
        {link === null ? null : <ExternalLink url={link} label="Open on GitHub" />}
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
          <Button
            size="sm"
            loading={pending}
            onClick={onSubmit}
            rightSection={
              <Kbd size="xs" aria-hidden>
                ↵
              </Kbd>
            }
          >
            {hasOptions ? 'Send answer' : count > 1 ? 'Dismiss All' : 'Dismiss'}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

import type { ChatDto, ConversationDto } from '@10db/contracts';
import {
  ActionIcon,
  Box,
  Button,
  Group,
  Loader,
  Menu,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconDots } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { JudgeLine } from '../../conversation';
import { OWNS_ESCAPE_ATTRIBUTE } from '../../conversation/escape';
import { ModelPicker } from '../../conversation/model-picker';
import { useChatModels, usePatchChat } from '../../daemon/chat-queries';
import { ContextGauge } from '../factory/context-gauge';
import { kindLine } from './kind-line';
import { COMPACT_MAX } from './strip-layout';
import { TabMenuItems, type TabActions } from './tab-menu';

// Sessions UI spec §4, §7.10: the 44 px row under the header. At its left the title over what the session
// is; at its right the agent and model, the context meter, File as Tasks and the ⋯ menu.

const CONTEXT_TIP =
  'of the context used. Past 70%, the next turn continues in a fresh session with a summary.';

export interface SessionBarProps {
  readonly chat: ChatDto;
  readonly conversation: ConversationDto;
  readonly projectName: string;
  /** The transcript is still being read. */
  readonly loading: boolean;
  /** A turn runs or waits: the model changes between turns. */
  readonly working: boolean;
  /** The model change on its way, and the daemon's refusal of the last one. */
  readonly modelPending: boolean;
  readonly modelError: string | null;
  readonly onModel: (model: string | null) => void;
  /** File as Tasks, disabled with this reason when it cannot be sent. */
  readonly fileDisabledReason: string | null;
  readonly onFileAsTasks: () => void;
  /** What the ⋯ menu does for the tab; Rename edits the title in place. */
  readonly actions?: Omit<TabActions, 'onRename'>;
  /** The builder asked to rename from the strip. */
  readonly renaming?: boolean;
  readonly onRenamed?: () => void;
}

/** The title, edited in place: Enter saves through `usePatchChat`, Esc puts the old one back. */
function Title({
  chat,
  editing,
  onDone,
  onEdit,
}: {
  readonly chat: ChatDto;
  readonly editing: boolean;
  readonly onDone: () => void;
  readonly onEdit: () => void;
}) {
  const patch = usePatchChat();
  const [draft, setDraft] = useState(chat.title);
  const finished = useRef(false);
  if (!editing) {
    return (
      <Text
        fw={600}
        size="sm"
        lineClamp={1}
        title="Double-click to rename"
        onDoubleClick={() => {
          setDraft(chat.title);
          finished.current = false;
          onEdit();
        }}
      >
        {chat.title}
      </Text>
    );
  }
  const save = (): void => {
    if (finished.current) return;
    finished.current = true;
    const title = draft.trim();
    if (title !== '' && title !== chat.title) patch.mutate({ chatId: chat.id, title });
    onDone();
  };
  return (
    <Box {...{ [OWNS_ESCAPE_ATTRIBUTE]: '' }}>
      <TextInput
        size="xs"
        aria-label="Session name"
        value={draft}
        ref={(field) => {
          // The field opens for typing: renaming starts with the cursor in it.
          field?.focus();
        }}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
        }}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            save();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            finished.current = true;
            onDone();
          }
        }}
      />
    </Box>
  );
}

/** The context meter, 40 px wide, with what it means and, on a metered account, what the session cost. */
function ContextMeter({ conversation }: { readonly conversation: ConversationDto }) {
  const { contextPct, costUsd } = conversation;
  const lines = [
    ...(contextPct === null ? [] : [`${String(Math.round(contextPct))}% ${CONTEXT_TIP}`]),
    ...(costUsd === null ? [] : [`$${costUsd.toFixed(2)} so far`]),
  ];
  const meter = <ContextGauge pct={contextPct} width={40} />;
  if (lines.length === 0) return meter;
  return (
    <Tooltip
      multiline
      w={260}
      label={
        <Stack gap={2}>
          {lines.map((line) => (
            <Text key={line} size="xs">
              {line}
            </Text>
          ))}
        </Stack>
      }
    >
      <Box tabIndex={0} aria-label={lines.join(' ')} role="img">
        {meter}
      </Box>
    </Tooltip>
  );
}

export function SessionBar({
  chat,
  conversation,
  projectName,
  loading,
  working,
  modelPending,
  modelError,
  onModel,
  fileDisabledReason,
  onFileAsTasks,
  actions,
  renaming = false,
  onRenamed,
}: SessionBarProps) {
  // From 640 to 899 px the model and the meter move into ⋯, where they are read, not changed.
  const compact = useMediaQuery(`(max-width: ${String(COMPACT_MAX)}px)`);
  const [typing, setEditing] = useState(false);
  const editing = typing || renaming;
  const models = useChatModels(chat.projectId);
  const { capabilities } = conversation;
  const offered = models.data?.offered ?? [];
  const named = conversation.model ?? models.data?.default ?? null;
  return (
    <Box style={{ flex: 'none' }}>
      <Group h={44} px="md" justify="space-between" wrap="nowrap" gap="sm">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          {loading ? <Loader size="xs" aria-label="Loading the session" /> : null}
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Title
              chat={chat}
              editing={editing}
              onEdit={() => {
                setEditing(true);
              }}
              onDone={() => {
                setEditing(false);
                onRenamed?.();
              }}
            />
            <Text size="xs" c="dimmed" lineClamp={1}>
              {kindLine(chat, projectName)}
            </Text>
          </Stack>
        </Group>
        <Group gap="sm" wrap="nowrap" style={{ flex: 'none' }}>
          {compact ? null : (
            <>
              {capabilities.modelSwitch === 'none' || offered.length === 0 ? (
                <Text size="xs" c="dimmed">
                  {named === null ? capabilities.label : `${capabilities.label} · ${named}`}
                </Text>
              ) : (
                <ModelPicker
                  offered={offered}
                  default={models.data?.default ?? null}
                  picked={conversation.model}
                  busy={working}
                  pending={modelPending}
                  error={modelError}
                  prefix={capabilities.label}
                  width={230}
                  onPick={onModel}
                />
              )}
              <ContextMeter conversation={conversation} />
            </>
          )}
          <Tooltip label={fileDisabledReason ?? ''} disabled={fileDisabledReason === null}>
            <Button
              variant="default"
              size="xs"
              disabled={fileDisabledReason !== null}
              onClick={onFileAsTasks}
            >
              File as Tasks
            </Button>
          </Tooltip>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" aria-label="More session actions">
                <IconDots size={16} stroke={1.5} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {compact ? (
                <>
                  <Menu.Label>
                    {named === null ? capabilities.label : `${capabilities.label} · ${named}`}
                  </Menu.Label>
                  {conversation.contextPct === null ? null : (
                    <Menu.Label>
                      {`${String(Math.round(conversation.contextPct))}% of the context used`}
                    </Menu.Label>
                  )}
                  <Menu.Divider />
                </>
              ) : null}
              <TabMenuItems
                actions={{
                  othersOpen: false,
                  onClose: () => undefined,
                  onCloseOthers: () => undefined,
                  ...actions,
                  onRename: () => {
                    setEditing(true);
                  },
                }}
              />
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>
      <JudgeLine judge={capabilities.judge} />
    </Box>
  );
}

import type { ToolCallView } from '@10db/contracts';
import { Box, Button, Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import type { ToolEntry } from './entry';
import { CommandBody, EditBody, EditPeek, McpBody, PreviewBody, ReadLine } from './tool-bodies';
import { useAllowed, useRowOpen } from './row-state';
import { ToolRow } from './tool-row';
import { editGroupWords, groupWords, toolRowWords, ToolIcon } from './tool-words';

// Tool calls as one-line rows that open on demand (sessions UI spec §7.3): a row per call, a row
// per folded run of reads or edits, and a subagent's calls nested under it.

type LoadFull = (callId: string) => Promise<string>;

/** Calls under their row, 16 px in, with a hairline `bg_2` rule at their left. */
function Nested({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Stack
      role="group"
      aria-label={label}
      gap={2}
      ml={16}
      pl={8}
      style={{ borderLeft: '1px solid var(--mantine-color-default-border)' }}
    >
      {children}
    </Stack>
  );
}

/** What an opened row holds, by kind. */
function Body({
  call,
  nested,
  peek,
  loadFull,
  onAllow,
}: {
  readonly call: ToolCallView;
  readonly nested: readonly ToolEntry[];
  readonly peek: boolean;
  readonly loadFull: LoadFull | undefined;
  readonly onAllow: ((call: ToolCallView) => void) | undefined;
}) {
  const refusal =
    call.status === 'denied' && call.refusal !== null ? (
      <Text size="xs" c="dimmed">
        {call.refusal}
      </Text>
    ) : null;
  const body = ((): ReactNode => {
    switch (call.kind) {
      case 'command':
        return <CommandBody call={call} peek={peek} loadFull={loadFull} />;
      case 'edit':
        return <EditBody call={call} loadFull={loadFull} />;
      case 'read':
      case 'search':
        return <ReadLine call={call} />;
      case 'mcp':
        return <McpBody call={call} />;
      case 'subagent':
        return (
          <Nested label="Calls of this subagent">
            {nested.map((child) => (
              <CallRow
                key={child.id}
                entry={child}
                nested={[]}
                peek
                // A nested subagent's calls are its siblings here, all under the outermost one.
                callCount={nested.filter((n) => n.call.parentId === child.id).length}
                {...(loadFull === undefined ? {} : { loadFull })}
                {...(onAllow === undefined ? {} : { onAllow })}
              />
            ))}
          </Nested>
        );
      case 'web':
        return <PreviewBody text={call.url ?? call.query} />;
      case 'other':
        return <PreviewBody text={call.inputPreview} />;
    }
  })();
  return (
    <Stack gap={4} pl={28} pb={4}>
      {refusal}
      {body}
    </Stack>
  );
}

export interface ToolCallCardProps {
  readonly entry: ToolEntry;
  /** A subagent's own calls, drawn under it when it opens. */
  readonly nested: readonly ToolEntry[];
  /** Loads a call's full output or patch from disk; without it, nothing offers to. */
  readonly loadFull?: LoadFull;
  /** Sends the builder's go-ahead for a call the judge held back softly. */
  readonly onAllow?: (call: ToolCallView) => void;
}

/** One tool call's row. A failed command opens by itself to its last lines; an edit peeks while closed. */
export function ToolCallCard(props: ToolCallCardProps) {
  return <CallRow {...props} peek />;
}

/** A call's row; `peek` says whether a closed edit shows its first hunk under it. */
function CallRow({
  entry,
  nested,
  loadFull,
  onAllow,
  peek,
  callCount,
}: ToolCallCardProps & {
  readonly peek: boolean;
  /** How many calls a subagent made, when they are not in `nested`. */
  readonly callCount?: number;
}) {
  const { call } = entry;
  const failedCommand = call.kind === 'command' && call.status === 'failed';
  // A failed command opens by itself to its last lines; opened by hand it shows its whole tail.
  const [open, setOpen] = useRowOpen(call.id, failedCommand ? 'peek' : 'closed');
  const [allowed, allow] = useAllowed(call.id);
  const words = toolRowWords(call, callCount ?? nested.length);
  const canAllow =
    call.status === 'denied' &&
    call.deniedBy === 'judge' &&
    call.soft === true &&
    onAllow !== undefined;
  return (
    <Box>
      <Group gap={6} wrap="nowrap">
        <Box style={{ flex: 1, minWidth: 0 }}>
          <ToolRow
            {...words}
            running={call.status === 'running'}
            open={open !== 'closed'}
            onToggle={() => {
              setOpen(open === 'closed' ? 'open' : 'closed');
            }}
          />
        </Box>
        {canAllow && !allowed && (
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => {
              allow();
              onAllow(call);
            }}
          >
            Allow This
          </Button>
        )}
        {canAllow && allowed && (
          <Text size="xs" c="dimmed" style={{ flex: 'none' }}>
            You allowed this
          </Text>
        )}
      </Group>
      {open !== 'closed' ? (
        <Body
          call={call}
          nested={nested}
          peek={open === 'peek'}
          loadFull={loadFull}
          onAllow={onAllow}
        />
      ) : (
        peek &&
        call.kind === 'edit' && (
          <Box pl={28} pb={4}>
            <EditPeek call={call} />
          </Box>
        )
      )}
    </Box>
  );
}

/** A group's key in the row state, apart from its first call's own. */
const groupKey = (entries: readonly ToolEntry[]): string => `${entries[0]?.id ?? ''}\0group`;

/** A folded run of reads and searches; opened, one call per line. */
export function ToolGroupRow({ entries }: { readonly entries: readonly ToolEntry[] }) {
  const [opened, setOpened] = useRowOpen(groupKey(entries), 'closed');
  const open = opened !== 'closed';
  const words = groupWords(entries);
  const running = entries.at(-1)?.call.status === 'running';
  return (
    <Box>
      <ToolRow
        icon={ToolIcon.File}
        verb={words.text}
        target={null}
        meta={null}
        tone="dimmed"
        name={words.name}
        running={running}
        open={open}
        onToggle={() => {
          setOpened(open ? 'closed' : 'open');
        }}
      />
      {open && (
        <Stack gap={2} pl={28} pb={4}>
          {entries.map((e) => (
            <ReadLine key={e.id} call={e.call} />
          ))}
        </Stack>
      )}
    </Box>
  );
}

/** A folded run of edits; opened, each file with its counts. Only the last edit peeks. */
export function EditGroupRow({
  entries,
  loadFull,
}: {
  readonly entries: readonly ToolEntry[];
  readonly loadFull?: LoadFull;
}) {
  const [opened, setOpened] = useRowOpen(groupKey(entries), 'closed');
  const open = opened !== 'closed';
  const words = editGroupWords(entries);
  const last = entries.at(-1)?.call;
  const [verb, meta] = words.text.split(' · ');
  return (
    <Box>
      <ToolRow
        icon={ToolIcon.Pencil}
        verb={verb ?? words.text}
        target={null}
        meta={meta ?? null}
        tone="dimmed"
        name={words.name}
        running={last?.status === 'running'}
        open={open}
        onToggle={() => {
          setOpened(open ? 'closed' : 'open');
        }}
      />
      {open && (
        <Nested label="Edits in this group">
          {entries.map((e, i) => (
            <CallRow
              key={e.id}
              entry={e}
              nested={[]}
              peek={i === entries.length - 1}
              {...(loadFull === undefined ? {} : { loadFull })}
            />
          ))}
        </Nested>
      )}
      {!open && last?.kind === 'edit' && (
        <Box pl={28} pb={4}>
          <EditPeek call={last} />
        </Box>
      )}
    </Box>
  );
}

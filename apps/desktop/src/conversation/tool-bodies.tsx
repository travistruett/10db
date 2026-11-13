import { OUTPUT_TAIL_CHARS, type ToolCallView } from '@10db/contracts';
import { Anchor, Box, Group, Stack, Text } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { HunkDiff } from './hunk-diff';

// What an opened row holds, by the call's kind (sessions UI spec §7.3). Full output and patches
// load from disk only when the screen passes `loadFull`.

type Call<K extends ToolCallView['kind']> = Extract<ToolCallView, { kind: K }>;

/** The lines a peek or an auto-opened failed command shows. */
export const PEEK_LINES = 8;

/** Where the daemon stops reading an edit's changed lines (`EDIT_LINES_CAP` in sessions/hunks.ts). */
const EDIT_CUT_WORDS = 'Cut at 1,500 changed lines';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${String(Math.round(kb))} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Mono text on `bg_0` inside a 1 px `bg_2` border, at most 320 px tall. */
function Output({ children, testId }: { readonly children: ReactNode; readonly testId?: string }) {
  return (
    <Box
      component="pre"
      data-testid={testId}
      m={0}
      p={8}
      ff="monospace"
      fz="xs"
      mah={320}
      style={{
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        background: 'var(--mantine-color-body)',
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-sm)',
      }}
    >
      {children}
    </Box>
  );
}

/** A link-styled control that loads the full text from disk and shows it in place. */
function LoadFull({
  label,
  callId,
  loadFull,
  onLoaded,
}: {
  readonly label: string;
  readonly callId: string;
  readonly loadFull: (callId: string) => Promise<string>;
  readonly onLoaded: (text: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <>
      <Anchor
        component="button"
        type="button"
        size="xs"
        onClick={() => {
          loadFull(callId).then(onLoaded, () => {
            setFailed(true);
          });
        }}
      >
        {label}
      </Anchor>
      {failed && (
        <Text size="xs" c="red">
          It could not be loaded.
        </Text>
      )}
    </>
  );
}

export function CommandBody({
  call,
  peek,
  loadFull,
}: {
  readonly call: Call<'command'>;
  /** Only the last lines, as a failed command opens by itself. */
  readonly peek: boolean;
  readonly loadFull: ((callId: string) => Promise<string>) | undefined;
}) {
  const [full, setFull] = useState<string | null>(null);
  const tail = peek ? call.outputTail.split('\n').slice(-PEEK_LINES).join('\n') : call.outputTail;
  const cut = call.outputBytes > new TextEncoder().encode(call.outputTail).length;
  return (
    <Stack gap={4}>
      <Output testId="command-output">{full ?? tail}</Output>
      {cut && full === null && (
        <Group gap={6}>
          <Text size="xs" c="dimmed">
            {`Showing the last ${formatBytes(OUTPUT_TAIL_CHARS)} of ${formatBytes(call.outputBytes)}`}
          </Text>
          {loadFull !== undefined && (
            <LoadFull
              label="Show All Output"
              callId={call.id}
              loadFull={loadFull}
              onLoaded={setFull}
            />
          )}
        </Group>
      )}
    </Stack>
  );
}

/** The peek under an edit: its first hunk, at most `PEEK_LINES` lines. */
export function EditPeek({ call }: { readonly call: Call<'edit'> }) {
  const [first] = call.hunks;
  if (first === undefined) return null;
  return (
    <Box data-peek={call.id}>
      <HunkDiff hunk={first} first maxLines={PEEK_LINES} />
    </Box>
  );
}

export function EditBody({
  call,
  loadFull,
}: {
  readonly call: Call<'edit'>;
  readonly loadFull: ((callId: string) => Promise<string>) | undefined;
}) {
  const [whole, setWhole] = useState(false);
  const [patch, setPatch] = useState<string | null>(null);
  return (
    <Stack gap={6}>
      {whole ? (
        call.hunks.map((h, i) => <HunkDiff key={i} hunk={h} first={i === 0} />)
      ) : (
        <EditPeek call={call} />
      )}
      <Group gap={6}>
        {!whole && call.hunks.length > 0 && (
          <Anchor
            component="button"
            type="button"
            size="xs"
            onClick={() => {
              setWhole(true);
            }}
          >
            Show Full Diff
          </Anchor>
        )}
        {call.truncated && (
          <>
            <Text size="xs" c="dimmed">
              {EDIT_CUT_WORDS}
            </Text>
            {loadFull !== undefined && patch === null && (
              <LoadFull
                label="Open Full Patch"
                callId={call.id}
                loadFull={loadFull}
                onLoaded={setPatch}
              />
            )}
          </>
        )}
      </Group>
      {patch !== null && <Output>{patch}</Output>}
    </Stack>
  );
}

/** One line of a read or a search, as a group lists it. */
export function ReadLine({ call }: { readonly call: ToolCallView }) {
  switch (call.kind) {
    case 'read': {
      const range =
        call.range === null
          ? null
          : call.range.limit === null
            ? `from line ${String(call.range.offset + 1)}`
            : `lines ${String(call.range.offset + 1)}–${String(call.range.offset + call.range.limit)}`;
      return (
        <Group gap={6} wrap="nowrap">
          <Text size="xs" ff="monospace" truncate="end">
            {call.path}
          </Text>
          {range !== null && (
            <Text size="xs" c="dimmed">
              {range}
            </Text>
          )}
        </Group>
      );
    }
    case 'search':
      return (
        <Group gap={6} wrap="nowrap">
          <Text size="xs" ff="monospace" truncate="end">
            {call.pattern}
          </Text>
          {call.matchCount !== null && (
            <Text size="xs" c="dimmed">
              {`${String(call.matchCount)} ${call.matchCount === 1 ? 'match' : 'matches'}`}
            </Text>
          )}
        </Group>
      );
    case 'command':
    case 'edit':
    case 'mcp':
    case 'subagent':
    case 'web':
    case 'other':
      return null;
  }
}

export function McpBody({ call }: { readonly call: Call<'mcp'> }) {
  return (
    <Stack gap={4}>
      {call.argumentsPreview !== '' && <Output>{call.argumentsPreview}</Output>}
      {call.error !== null ? (
        <Text size="xs" c="red">
          {call.error}
        </Text>
      ) : (
        call.resultTail !== null && <Output>{call.resultTail}</Output>
      )}
    </Stack>
  );
}

export function PreviewBody({ text }: { readonly text: string | null }) {
  if (text === null || text === '') return null;
  return <Output>{text}</Output>;
}

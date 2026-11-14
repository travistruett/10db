import type { AgentCommandDto, ProjectFileMatchDto } from '@10db/contracts';
import {
  Box,
  Group,
  Mentions,
  Text,
  type MentionItem,
  type MentionRenderSuggestionInput,
} from '@mantine/core';
import { IconFile } from '@tabler/icons-react';
import type { ClipboardEvent, KeyboardEvent, RefObject } from 'react';
import { z } from 'zod';
import { COMMAND_MENTION, FILE_MENTION } from './mention-text';

// Sessions UI spec §7.9: the composer's input on Mantine `Mentions`. `@` lists the files of the session's
// checkout (the daemon's answer, ranked, 8 of its 50) and `/`, at the start of the input, the commands the
// agent listed. Either is a source only when the screen can answer it.

/** What the screen can answer for the input's two lists. */
export interface ComposerMentions {
  /** The files `q` matches; without it `@` is plain text (a tab that has no conversation yet). */
  readonly files?: (q: string, signal: AbortSignal) => Promise<ProjectFileMatchDto[]>;
  /** The commands the agent last listed; null before it has listed any. */
  readonly commands: readonly AgentCommandDto[] | null;
}

/** How many suggestions an `@` list shows of what the daemon answers. */
const FILES_SHOWN = 8;
/** An `@` query waits this long for the next key before it asks the daemon. */
const FILES_DEBOUNCE_MS = 80;

/** `/` opens the list only at the start of the input. */
const COMMAND_TRIGGER = /^(\/(\S*))$/u;

const Ranges = z.array(z.tuple([z.number(), z.number()]));

/** A path split at its last `/`: the name the builder looks for, and the folder it sits in. */
function splitPath(path: string): { readonly folder: string; readonly name: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { folder: '', name: path }
    : { folder: path.slice(0, slash), name: path.slice(slash + 1) };
}

/** The name with the characters the query hit underlined. */
function Underlined({
  text,
  offset,
  ranges,
}: {
  readonly text: string;
  readonly offset: number;
  readonly ranges: readonly (readonly [number, number])[];
}) {
  const hit = new Set<number>();
  for (const [start, end] of ranges)
    for (let i = start; i < end; i += 1) if (i >= offset) hit.add(i - offset);
  return (
    <>{Array.from(text, (char, index) => (hit.has(index) ? <u key={index}>{char}</u> : char))}</>
  );
}

function FileSuggestion({ item }: MentionRenderSuggestionInput) {
  const ranges = Ranges.safeParse(item['matches']);
  const { folder, name } = splitPath(item.id);
  return (
    <Group gap={8} wrap="nowrap">
      <IconFile size={14} stroke={1.5} aria-hidden="true" style={{ flex: 'none' }} />
      <Text size="sm" c="bright" style={{ flex: 'none' }}>
        <Underlined
          text={name}
          offset={folder === '' ? 0 : folder.length + 1}
          ranges={ranges.success ? ranges.data : []}
        />
      </Text>
      {folder === '' ? null : (
        <Text size="xs" c="dimmed" ff="monospace" lineClamp={1} style={{ minWidth: 0 }}>
          {folder}
        </Text>
      )}
    </Group>
  );
}

function CommandSuggestion({ item }: MentionRenderSuggestionInput) {
  const description = z.string().safeParse(item['description']);
  const hint = z.string().safeParse(item['argumentHint']);
  return (
    <Group gap={8} wrap="nowrap">
      <Text size="sm" ff="monospace" style={{ flex: 'none' }}>
        /{item.id}
      </Text>
      {hint.success && hint.data !== '' ? (
        <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 'none' }}>
          {hint.data}
        </Text>
      ) : null}
      <Text size="xs" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}>
        {description.success ? description.data : ''}
      </Text>
    </Group>
  );
}

/** A mention in the input keeps the text's own metrics, so it only takes a fill. */
const CHIP_STYLE = {
  background: 'var(--mantine-color-default-hover)',
  borderRadius: 'var(--mantine-radius-sm)',
} as const;

export interface ComposerInputProps {
  /** The input's value: the text with its mentions as markup (`mentionText` reads it). */
  readonly value: string;
  readonly onValue: (value: string) => void;
  readonly mentions: ComposerMentions | undefined;
  /** The agent takes `/` commands. */
  readonly slashCommands: boolean;
  readonly label: string;
  readonly describedBy: string | undefined;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly inputRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null> | undefined;
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
}

export function ComposerInput({
  value,
  onValue,
  mentions,
  slashCommands,
  label,
  describedBy,
  placeholder,
  disabled,
  inputRef,
  onKeyDown,
  onPaste,
}: ComposerInputProps) {
  const files = mentions?.files;
  const commands = mentions?.commands ?? null;
  const commandItems: MentionItem[] = (commands ?? []).map((command) => ({
    id: command.name,
    display: command.name,
    description: command.description,
    argumentHint: command.argumentHint ?? '',
  }));
  return (
    <Box>
      <Mentions
        ref={(element: HTMLTextAreaElement | HTMLInputElement | null) => {
          if (inputRef !== undefined) inputRef.current = element;
        }}
        aria-label={label}
        {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
        variant="unstyled"
        minRows={2}
        maxRows={10}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        suggestionsPlacement="above"
        onChange={({ value: next }) => {
          onValue(next);
        }}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
      >
        {files === undefined ? null : (
          <Mentions.Mention
            trigger="@"
            markup={FILE_MENTION}
            displayTransform={(_id, display) => `@${display}`}
            debounceMs={FILES_DEBOUNCE_MS}
            maxSuggestions={FILES_SHOWN}
            appendSpaceOnAdd
            style={CHIP_STYLE}
            data={async (query, { signal }) => ({
              items: (await files(query, signal))
                .slice(0, FILES_SHOWN)
                .map((match): MentionItem => ({
                  id: match.path,
                  display: match.path,
                  matches: match.matches,
                })),
            })}
            renderSuggestion={FileSuggestion}
          />
        )}
        {slashCommands && commandItems.length > 0 ? (
          <Mentions.Mention
            trigger={COMMAND_TRIGGER}
            markup={COMMAND_MENTION}
            displayTransform={(_id, display) => `/${display}`}
            appendSpaceOnAdd
            style={CHIP_STYLE}
            data={(query) => ({
              items: commandItems.filter((item) =>
                item.id.toLowerCase().startsWith(query.toLowerCase()),
              ),
            })}
            renderSuggestion={CommandSuggestion}
          />
        ) : null}
      </Mentions>
    </Box>
  );
}

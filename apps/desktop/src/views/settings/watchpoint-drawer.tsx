import {
  JudgeDecision,
  MAX_WATCHPOINT_QUESTION_LENGTH,
  Watchpoint,
  WatchpointLinePattern,
  WatchpointLoudness,
  type JudgeStatusDto,
  type Watchpoint as WatchpointValue,
} from '@10db/contracts';
import { Alert, Button, Group, Input, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useJudgeStatus } from '../../daemon/judge-queries';
import { SurfaceDrawer } from '../../shell/surface-drawer';
import { LoudnessControl } from './watchpoint-loudness';
import { lines } from './list-drafts';
import { PathMeanings } from './table-cells';
import { keyFor } from './watchpoint-lists';

interface Draft {
  readonly label: string;
  readonly why: string;
  readonly paths: string;
  readonly lines: string;
  readonly question: string;
  readonly guidance: string;
  readonly loudness: WatchpointLoudness;
}

const EMPTY: Draft = {
  label: '',
  why: '',
  paths: '',
  lines: '',
  question: '',
  guidance: '',
  loudness: WatchpointLoudness.Show,
};

/** Why a watchpoint's question isn't asked now, or null while it is. */
function whyUnasked(judge: JudgeStatusDto | undefined): string | null {
  if (judge === undefined) return null;
  if (judge.off || !judge.config.enabled) return 'the judge is off';
  if (judge.account?.secretSet !== true) return 'no account can answer decisions';
  if (!judge.config.decisions[JudgeDecision.WatchpointQuestion].enabled)
    return 'the Watchpoint Question decision is off';
  return null;
}

function draftOf(watchpoint: WatchpointValue): Draft {
  return {
    label: watchpoint.label,
    why: watchpoint.why,
    paths: watchpoint.globs.join('\n'),
    lines: watchpoint.lines.join('\n'),
    question: watchpoint.question ?? '',
    guidance: watchpoint.guidance,
    loudness: watchpoint.loudness,
  };
}

/**
 * A watchpoint to change, or a new one when `watchpoint` is null. Save hands the page the watchpoint, which the
 * page writes to its own list; an unchanged one saves nothing.
 */
export function WatchpointDrawer({
  watchpoint,
  takenKeys,
  saving,
  problem,
  note,
  onUseDefault,
  onSave,
  onClose,
  onDirty,
}: {
  readonly watchpoint: WatchpointValue | null;
  /** Every key in use, which a new watchpoint's key keeps apart from. */
  readonly takenKeys: ReadonlySet<string>;
  readonly saving: boolean;
  readonly problem: string | null;
  /** Said above the fields: where a save lands, when that is not where the watchpoint came from. */
  readonly note?: string;
  /** Drops the project's copy, so the watchpoint follows All Projects again; given only for a copy. */
  readonly onUseDefault?: () => void;
  readonly onSave: (next: WatchpointValue) => void;
  readonly onClose: () => void;
  readonly onDirty: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    watchpoint === null ? EMPTY : draftOf(watchpoint),
  );
  const [invalid, setInvalid] = useState<string | null>(null);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(watchpoint === null ? EMPTY : draftOf(watchpoint));
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(
    () => () => {
      onDirty(false);
    },
    [onDirty],
  );
  const change = (next: Partial<Draft>) => {
    setInvalid(null);
    setDraft((d) => ({ ...d, ...next }));
  };
  const unasked = whyUnasked(useJudgeStatus().data);
  const badPattern = lines(draft.lines).find((p) => !WatchpointLinePattern.safeParse(p).success);
  const submit = () => {
    if (watchpoint !== null && !dirty) {
      onClose();
      return;
    }
    const parsed = Watchpoint.safeParse({
      key: watchpoint?.key ?? keyFor(draft.label, takenKeys),
      label: draft.label.trim(),
      why: draft.why.trim(),
      globs: lines(draft.paths),
      lines: lines(draft.lines),
      question: draft.question.trim() === '' ? null : draft.question.trim(),
      guidance: draft.guidance.trim(),
      loudness: draft.loudness,
      starter: watchpoint?.starter ?? null,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = String(issue?.path[0] ?? 'Watchpoint');
      // A pattern that doesn't compile names the line, so the builder can find it.
      const at = field === 'lines' && typeof issue?.path[1] === 'number' ? issue.path[1] : null;
      const pattern = at === null ? '' : ` "${lines(draft.lines)[at] ?? ''}"`;
      setInvalid(
        `${field === 'lines' ? 'Lines' : field === 'question' ? 'Question' : field}${pattern}: ${issue?.message ?? 'is not valid'}`,
      );
      return;
    }
    onSave(parsed.data);
  };
  return (
    <SurfaceDrawer
      opened
      onClose={onClose}
      label={watchpoint === null ? 'New Watchpoint' : `Watchpoint ${watchpoint.label}`}
      title={watchpoint === null ? 'New Watchpoint' : watchpoint.label}
      closeOnClickOutside
      footer={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} onClick={submit}>
            {watchpoint === null ? 'Add Watchpoint' : 'Save Watchpoint'}
          </Button>
        </>
      }
    >
      <Stack gap="lg">
        {note === undefined ? null : (
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Text size="sm" c="dimmed">
              {note}
            </Text>
            {onUseDefault === undefined ? null : (
              <Button
                variant="default"
                size="compact-sm"
                loading={saving}
                style={{ flexShrink: 0 }}
                onClick={onUseDefault}
              >
                Use Default
              </Button>
            )}
          </Group>
        )}
        <TextInput
          label="Name"
          aria-label="Watchpoint name"
          placeholder="Migrations"
          data-autofocus
          value={draft.label}
          onChange={(e) => {
            change({ label: e.currentTarget.value });
          }}
        />
        <Textarea
          label="Why It Matters"
          aria-label="Why the watchpoint matters"
          autosize
          minRows={2}
          value={draft.why}
          onChange={(e) => {
            change({ why: e.currentTarget.value });
          }}
        />
        <Stack gap={6}>
          <Textarea
            label="Matches These Paths"
            aria-label="Watchpoint paths"
            placeholder={'**/migrations/**\n.claude/**'}
            description="One pattern per line. A task whose changes touch one of these is shown to you."
            autosize
            minRows={3}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            value={draft.paths}
            onChange={(e) => {
              change({ paths: e.currentTarget.value });
            }}
          />
          <PathMeanings paths={lines(draft.paths)} />
        </Stack>
        <Textarea
          label="Lines"
          aria-label="Watchpoint line patterns"
          placeholder="One pattern per line"
          description="Optional. Only files whose added or removed lines match one of these count. Case-insensitive."
          autosize
          minRows={2}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          value={draft.lines}
          error={badPattern === undefined ? undefined : `"${badPattern}" is not a valid pattern`}
          onChange={(e) => {
            change({ lines: e.currentTarget.value });
          }}
        />
        <Stack gap={6}>
          <TextInput
            label="Question"
            aria-label="Watchpoint question"
            placeholder="Does this change who can do what: sign-in, sessions, tokens, roles or permission checks?"
            description="Optional. A yes or no 10db's judge asks of the files these paths cover that no line settled. With a question and no lines, the paths alone match nothing. For now the answer is only logged, in Settings › Decisions."
            maxLength={MAX_WATCHPOINT_QUESTION_LENGTH}
            value={draft.question}
            onChange={(e) => {
              change({ question: e.currentTarget.value });
            }}
          />
          {unasked === null ? null : (
            <Text size="xs" c="dimmed">
              {`Judge questions aren't checked: ${unasked}.`}
            </Text>
          )}
        </Stack>
        <Textarea
          label="What to Check"
          aria-label="What to check"
          description="The agent reads it before it builds, and the reviewer checks the change against it."
          autosize
          minRows={3}
          value={draft.guidance}
          onChange={(e) => {
            change({ guidance: e.currentTarget.value });
          }}
        />
        <Input.Wrapper
          label="When It Matches"
          description="Show puts it in the task's For You and the pull request. Ask also leaves one Inbox card per task."
        >
          <LoudnessControl
            mt={6}
            size="sm"
            ariaLabel="When the watchpoint matches"
            value={draft.loudness}
            onChange={(loudness) => {
              change({ loudness });
            }}
          />
        </Input.Wrapper>
        {invalid ? (
          <Alert color="red" title="Check the watchpoint">
            {invalid}
          </Alert>
        ) : null}
        {problem ? (
          <Alert color="red" title="Couldn't save the watchpoint">
            {problem}
          </Alert>
        ) : null}
      </Stack>
    </SurfaceDrawer>
  );
}

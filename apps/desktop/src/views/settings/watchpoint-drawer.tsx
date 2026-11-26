import {
  Watchpoint,
  WatchpointLinePattern,
  WatchpointLoudness,
  type EffectiveWatchpoint,
  type Watchpoint as WatchpointValue,
} from '@10db/contracts';
import {
  Alert,
  Button,
  Input,
  SegmentedControl,
  Stack,
  Switch,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { SurfaceDrawer } from '../../shell/surface-drawer';
import { LoudnessControl } from './watchpoint-loudness';
import { lines } from './list-drafts';
import { PathMeanings } from './table-cells';
import {
  keyFor,
  plain,
  saved,
  turnedOff,
  WatchpointHome,
  type WatchpointLists,
} from './watchpoint-lists';

interface Draft {
  readonly label: string;
  readonly why: string;
  readonly paths: string;
  readonly lines: string;
  readonly guidance: string;
  readonly loudness: WatchpointLoudness;
  readonly home: WatchpointHome;
  readonly off: boolean;
}

const EMPTY: Draft = {
  label: '',
  why: '',
  paths: '',
  lines: '',
  guidance: '',
  loudness: WatchpointLoudness.Show,
  home: WatchpointHome.Everywhere,
  off: false,
};

function draftOf(row: EffectiveWatchpoint): Draft {
  return {
    label: row.label,
    why: row.why,
    paths: row.globs.join('\n'),
    lines: row.lines.join('\n'),
    guidance: row.guidance,
    loudness: row.loudness,
    home: row.from === 'you' ? WatchpointHome.Everywhere : WatchpointHome.Project,
    off: false,
  };
}

/**
 * A watchpoint to change, or a new one when `row` is null. Save sends the lists that changed: the builder's
 * and this project's own, which "Applies to" moves a watchpoint between.
 */
export function WatchpointDrawer({
  row,
  lists,
  saving,
  problem,
  onSave,
  onClose,
  onDirty,
}: {
  readonly row: EffectiveWatchpoint | null;
  readonly lists: WatchpointLists;
  readonly saving: boolean;
  readonly problem: string | null;
  readonly onSave: (next: WatchpointLists) => void;
  readonly onClose: () => void;
  readonly onDirty: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => (row === null ? EMPTY : draftOf(row)));
  const [invalid, setInvalid] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(row === null ? EMPTY : draftOf(row));
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
  const badPattern = lines(draft.lines).find((p) => !WatchpointLinePattern.safeParse(p).success);
  const submit = () => {
    const taken = new Set([...lists.yours.map((w) => w.key), ...lists.entries.map((e) => e.key)]);
    const parsed = Watchpoint.safeParse({
      key: row?.key ?? keyFor(draft.label, taken),
      label: draft.label.trim(),
      why: draft.why.trim(),
      globs: lines(draft.paths),
      lines: lines(draft.lines),
      guidance: draft.guidance.trim(),
      loudness: draft.loudness,
      starter: row === null ? null : plain(row).starter,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = String(issue?.path[0] ?? 'Watchpoint');
      // A pattern that doesn't compile names the line, so the builder can find it.
      const at = field === 'lines' && typeof issue?.path[1] === 'number' ? issue.path[1] : null;
      const pattern = at === null ? '' : ` "${lines(draft.lines)[at] ?? ''}"`;
      setInvalid(
        `${field === 'lines' ? 'Lines' : field}${pattern}: ${issue?.message ?? 'is not valid'}`,
      );
      return;
    }
    const next: WatchpointValue = parsed.data;
    const base = saved(lists, next, draft.home);
    // Only a switch turned on writes an `off` entry; saved() already dropped the project's entry at Everywhere.
    onSave(row?.from === 'you' && draft.off ? turnedOff(base, next.key, true) : base);
  };
  return (
    <SurfaceDrawer
      opened
      onClose={onClose}
      label={row === null ? 'New Watchpoint' : `Watchpoint ${row.label}`}
      title={row === null ? 'New Watchpoint' : row.label}
      closeOnClickOutside
      footer={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} onClick={submit}>
            Save Watchpoint
          </Button>
        </>
      }
    >
      <Stack gap="lg">
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
          label="Why it matters"
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
            label="Matches these paths"
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
          placeholder={'\\bcreate\\s+index\\b\n\\bclaude-[a-z0-9]+'}
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
        <Textarea
          label="What to check"
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
          label="Loudness"
          description="Show puts it in the task's For You and the pull request. Ask also leaves one Inbox card per task. Hold comes later."
        >
          <LoudnessControl
            mt={6}
            size="sm"
            ariaLabel="Watchpoint loudness"
            value={draft.loudness}
            onChange={(loudness) => {
              change({ loudness });
            }}
          />
        </Input.Wrapper>
        <Input.Wrapper
          label="Applies to"
          description={
            draft.home === WatchpointHome.Everywhere
              ? 'Every project you have.'
              : 'This project only. A watchpoint of yours with the same name is replaced here.'
          }
        >
          <SegmentedControl
            mt={6}
            size="sm"
            aria-label="Watchpoint applies to"
            data={[
              { value: WatchpointHome.Everywhere, label: 'Every project' },
              { value: WatchpointHome.Project, label: 'This project only' },
            ]}
            value={draft.home}
            onChange={(value) => {
              change({
                home:
                  value === WatchpointHome.Project
                    ? WatchpointHome.Project
                    : WatchpointHome.Everywhere,
              });
            }}
          />
        </Input.Wrapper>
        {row?.from === 'you' ? (
          <Switch
            label="Off in this project"
            description="It stays on in every other project."
            checked={draft.off}
            onChange={(e) => {
              change({ off: e.currentTarget.checked });
            }}
          />
        ) : null}
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

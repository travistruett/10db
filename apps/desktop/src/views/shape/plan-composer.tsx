import { Alert, Box, Button, Text } from '@mantine/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Composer } from '../../conversation/composer';
import type { ComposerPhase } from '../../conversation/composer-phase';
import { EMPTY_DRAFT, type Draft } from '../../conversation/drafts';
import { FILE_PICKER_ACCEPT } from '../../conversation/dropped-files';
import { keepBoth, type LateOutcome } from './late-outcome';

export interface PlanComposerProps {
  /** No builder message yet: the input takes focus and the hint says what nothing does until you act. */
  readonly firstRun: boolean;
  readonly answering: boolean;
  /** The agent's name as the UI shows it. */
  readonly agentLabel: string;
  /** A Propose turn is queued or running; pressing again would be ignored. */
  readonly proposing: boolean;
  readonly proposeLabel: 'Propose' | 'Propose Again';
  readonly canPropose: boolean;
  /**
   * Nothing has been heard or proposed yet, so Propose has little to work with. The line beside
   * Propose says so; Propose itself stays as `canPropose` has it.
   */
  readonly nothingDecided: boolean;
  /** Sends the text; rejects with the daemon's words. */
  readonly onSend: (text: string) => Promise<void>;
  readonly onPropose: () => void;
  readonly onStop: () => void;
  /** Why the conversation could not load, or a Propose or Stop was refused: an alert above the input. */
  readonly error: string | null;
  /** The names of the files already in the conversation. */
  readonly files: readonly string[];
  /** Adds dropped, pasted or picked files; answers a reason for each one it refused. */
  readonly onFiles: (files: File[]) => Promise<string[]>;
  /** A send or drop from the screen this one replaced, finished late: its reasons and the failed text. */
  readonly late: LateOutcome | null;
  /** This input has taken `late`. */
  readonly onLateTaken: () => void;
  /** Told what the input holds each time it changes, so a screen replacing it can carry the text. */
  readonly onDraft: (text: string) => void;
  /**
   * An imported Plan's line, "Imported 12 Nov 2026. Re-import to change its plan."; with it, Propose
   * is not offered, since a proposal round would replace what was imported.
   */
  readonly imported?: string;
  /** The model and effort chip and the context ring, beside Attach. */
  readonly modelControl?: ReactNode;
}

const FIRST_RUN_PLACEHOLDER = 'Talk it through, drop a document, or paste a list…';

/** Plan's input never offers Stop and Redo, and Send is never filled: Propose is the group's one primary. */
export function planComposerPhase(input: {
  readonly firstRun: boolean;
  readonly answering: boolean;
  readonly imported?: string;
}): ComposerPhase {
  return {
    stop: input.answering ? 'stop' : null,
    send: 'default',
    placeholder: input.firstRun ? FIRST_RUN_PLACEHOLDER : 'Talk it through…',
    hint:
      input.imported ??
      (input.firstRun
        ? 'Nothing is proposed until you press Propose. Nothing starts until you Convert.'
        : '↵ sends · ⇧↵ new line · ⌘⇧↩ proposes · Esc stops'),
  };
}

/**
 * Plan's composer: the conversation kit's composer with Propose beside Send. Files go into the
 * conversation as they are dropped, pasted or picked, and are listed under the input.
 */
export function PlanComposer(props: PlanComposerProps) {
  const { firstRun, proposing, proposeLabel, canPropose, nothingDecided } = props;
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState<readonly string[]>([]);
  const input = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  useEffect(() => {
    if (firstRun) input.current?.focus();
  }, [firstRun]);

  const { late, onLateTaken } = props;
  // Taken while rendering, so the first paint already has it; the store is told after.
  const [takenLate, setTakenLate] = useState<LateOutcome | null>(null);
  if (late !== null && late !== takenLate) {
    setTakenLate(late);
    setRefused((held) => [...held, ...late.refused.filter((reason) => !held.includes(reason))]);
    if (late.failure !== null) setFailure(late.failure);
    const text = late.draft;
    // Whatever was typed since stays, with the text that failed ahead of it.
    if (text !== null) setDraft((typed) => ({ ...typed, text: keepBoth(typed.text, text) }));
  }
  useEffect(() => {
    if (late !== null) onLateTaken();
  }, [late, onLateTaken]);
  const { onDraft } = props;
  useEffect(() => {
    onDraft(draft.text);
  }, [draft.text, onDraft]);

  const addFiles = async (files: File[]): Promise<void> => {
    try {
      setRefused(await props.onFiles(files));
    } catch (error) {
      setRefused([error instanceof Error ? error.message : String(error)]);
    }
  };

  const shown = failure ?? props.error;
  const proposeHint =
    nothingDecided && props.imported === undefined ? (
      <Text id="shape-composer-propose-hint" size="xs" c="dimmed">
        Propose turns decided work into tasks. Nothing is decided yet.
      </Text>
    ) : null;
  const fileLine =
    props.files.length === 0 ? null : (
      <Text size="xs" c="dimmed" aria-label="Files in the conversation">
        {props.files.join(' · ')}
      </Text>
    );

  return (
    <>
      {shown === null ? null : (
        <Box px="md" pt="xs" style={{ flex: 'none' }}>
          <Alert color="red" title={`Couldn't reach ${props.agentLabel}`}>
            {shown}
          </Alert>
        </Box>
      )}
      <Composer
        draft={draft}
        onDraft={setDraft}
        capabilities={{ images: [] }}
        uploads={{
          accept: FILE_PICKER_ACCEPT,
          onFiles: (files) => {
            void addFiles(files);
          },
          refused,
          onDismiss: () => {
            setRefused([]);
          },
        }}
        phase={planComposerPhase(props)}
        disabledReason={null}
        // A refused send is Plan's alert, which names the agent, not a line beside Send.
        onFailure={setFailure}
        inputRef={input}
        attachLabel="Attach Files"
        modelControl={props.modelControl}
        onSend={(sent) => {
          setFailure(null);
          return props.onSend(sent.text.trim());
        }}
        onStop={props.onStop}
        actions={
          props.imported === undefined ? (
            <Button
              loading={proposing}
              disabled={!canPropose}
              aria-describedby={nothingDecided ? 'shape-composer-propose-hint' : undefined}
              onClick={props.onPropose}
            >
              {proposeLabel}
            </Button>
          ) : null
        }
        notes={
          proposeHint === null && fileLine === null ? null : (
            <>
              {proposeHint}
              {fileLine}
            </>
          )
        }
      />
    </>
  );
}

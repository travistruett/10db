import { Button, Group, Kbd, Stack, Text, Textarea } from '@mantine/core';
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import classes from './card-actions.module.css';

/** The key a primary button names: Enter where the Inbox keys answer the card, ⌘↵ where a field sends it. */
export const KeyHint = { Enter: '↵', CommandEnter: '⌘↵' } as const;
export type KeyHint = (typeof KeyHint)[keyof typeof KeyHint];

/** A button the bar draws: a default one among the answers, or the one filled primary. */
export interface BarButton {
  readonly label: string;
  readonly onClick: () => void;
  readonly loading?: boolean;
  readonly disabled?: boolean;
  /** Red for an answer that throws work away, such as Abandon. */
  readonly color?: 'red';
}

export interface BarPrimary extends BarButton {
  readonly hint?: KeyHint;
}

/** An answer's optional note, in the bar beside the primary, so it is in reach however long the card is. */
export interface BarNote {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onFocus?: () => void;
  /** What ⌘↵ in the note does: the card's answer. */
  readonly onSubmit: () => void;
}

/**
 * Send Back: a default button that turns the bar into a composer for the required note. The draft is the
 * holder's, so it survives switching cards, and a kept draft opens the composer again.
 */
export interface BarSendBack {
  /** The composer's field label, such as "What Needs to Change". */
  readonly label: string;
  readonly description: string;
  readonly note: string;
  readonly onNote: (note: string) => void;
  /** Sends the trimmed note; never called with an empty one. */
  readonly onSend: (note: string) => void;
  readonly pending: boolean;
}

const NOTE_MAX_LENGTH = 4000;

const hint = (key: KeyHint | undefined): ReactNode =>
  key === undefined ? null : (
    <Kbd size="xs" aria-hidden>
      {key}
    </Kbd>
  );

const isSend = (event: KeyboardEvent<HTMLTextAreaElement>): boolean =>
  event.key === 'Enter' && (event.metaKey || event.ctrlKey);

/** A way out of the card at the bar's left, such as View Task or Open Session. */
export function CardLinkButton({
  label,
  onClick,
  loading = false,
}: {
  readonly label: string;
  readonly onClick: () => void;
  /** Shown but not yet ready, such as View Task while its run is read, so the bar keeps its shape. */
  readonly loading?: boolean;
}) {
  return (
    <Button variant="default" loading={loading} onClick={onClick}>
      {label}
    </Button>
  );
}

/**
 * Every card's one action bar: the ways out on the left, the answers on the right with one filled primary, and
 * the answer's error over them. Where the card stands alone it ends the card; in the Inbox's content it is held
 * at the pane's foot, so the answers stay in one place however long the card is. Send Back turns it into a
 * composer whose note grows up out of the bar. With nothing to offer it draws nothing.
 */
export function CardActions({
  framed,
  start = [],
  note = null,
  noteRef,
  sendBack = null,
  extra = null,
  secondary = [],
  primary = null,
  error = null,
}: {
  readonly framed: boolean;
  /** The ways out: View Task, Open Session, Open on GitHub, Full Diff. */
  readonly start?: readonly ReactNode[];
  readonly note?: BarNote | null;
  /** The note's field, which the Inbox's `n` focuses. */
  readonly noteRef?: Ref<HTMLTextAreaElement>;
  readonly sendBack?: BarSendBack | null;
  /** A control of its own before the buttons, such as Ask Someone's popover. */
  readonly extra?: ReactNode;
  /** Up to two default buttons. */
  readonly secondary?: readonly BarButton[];
  readonly primary?: BarPrimary | null;
  readonly error?: string | null;
}) {
  const [composing, setComposing] = useState(sendBack !== null && sendBack.note !== '');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const sendBackRef = useRef<HTMLButtonElement>(null);
  // Set when the builder opens or cancels the composer, so a kept draft shown again never takes focus.
  const focusNext = useRef<'composer' | 'send-back' | null>(null);
  useEffect(() => {
    if (focusNext.current === 'composer') composerRef.current?.focus();
    if (focusNext.current === 'send-back') sendBackRef.current?.focus();
    focusNext.current = null;
  }, [composing]);

  // A way the card lacks is null and takes no room. A holder passes null, never an element that draws nothing,
  // so the bar can tell when it has nothing to show.
  const ways = start.filter((node) => node !== null && node !== undefined && node !== false);
  if (
    ways.length === 0 &&
    note === null &&
    sendBack === null &&
    extra === null &&
    secondary.length === 0 &&
    primary === null &&
    error === null
  )
    return null;

  const composer = composing ? sendBack : null;
  const trimmed = composer?.note.trim() ?? '';
  const send = (): void => {
    if (composer !== null && trimmed !== '' && !composer.pending) composer.onSend(trimmed);
  };
  const cancel = (): void => {
    // A kept note would open the composer again when the card is selected again.
    sendBack?.onNote('');
    focusNext.current = 'send-back';
    setComposing(false);
  };
  const busy = (sendBack?.pending ?? false) || (primary?.loading ?? false);

  const noteField =
    composer !== null || note === null ? null : (
      <div className={classes['note']}>
        <Textarea
          ref={noteRef}
          aria-label="Note"
          placeholder="Add a note (optional)"
          autosize
          minRows={1}
          maxRows={4}
          value={note.value}
          onChange={(e) => {
            note.onChange(e.currentTarget.value);
          }}
          {...(note.onFocus === undefined ? {} : { onFocus: note.onFocus })}
          onKeyDown={(event) => {
            if (!isSend(event)) return;
            event.preventDefault();
            note.onSubmit();
          }}
        />
      </div>
    );

  const answers =
    composer === null ? (
      <>
        {extra}
        {sendBack === null ? null : (
          <Button
            ref={sendBackRef}
            variant="default"
            disabled={busy}
            onClick={() => {
              focusNext.current = 'composer';
              setComposing(true);
            }}
          >
            Send Back
          </Button>
        )}
        {secondary.map((button) => (
          <Button
            key={button.label}
            variant="default"
            {...(button.color === undefined ? {} : { color: button.color })}
            loading={button.loading ?? false}
            disabled={button.disabled ?? false}
            onClick={button.onClick}
          >
            {button.label}
          </Button>
        ))}
        {primary === null ? null : (
          <Button
            {...(primary.color === undefined ? {} : { color: primary.color })}
            loading={primary.loading ?? false}
            disabled={primary.disabled ?? false}
            onClick={primary.onClick}
            rightSection={hint(primary.hint)}
          >
            {primary.label}
          </Button>
        )}
      </>
    ) : (
      <>
        <Button variant="default" onClick={cancel}>
          Cancel
        </Button>
        <Button
          color="red"
          loading={composer.pending}
          disabled={trimmed === ''}
          onClick={send}
          rightSection={hint(KeyHint.CommandEnter)}
        >
          Send It Back
        </Button>
      </>
    );

  const bar = (
    <Stack gap="xs">
      {composer === null ? null : (
        <Textarea
          ref={composerRef}
          label={composer.label}
          description={composer.description}
          required
          autosize
          minRows={2}
          maxRows={8}
          maxLength={NOTE_MAX_LENGTH}
          value={composer.note}
          onChange={(e) => {
            composer.onNote(e.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (isSend(event)) {
              event.preventDefault();
              send();
            } else if (event.key === 'Escape') {
              // Esc cancels the composer only, not the drawer or sheet around the card.
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
          }}
        />
      )}
      {error === null ? null : (
        <Text size="sm" c="red" role="alert">
          {error}
        </Text>
      )}
      <div className={classes['fit']}>
        <div className={classes['row']}>
          {ways.length === 0 ? null : (
            <Group gap="sm">
              {ways.map((node, place) => (
                // Each card lists its ways in a fixed order, so a place names one.
                <Fragment key={place}>{node}</Fragment>
              ))}
            </Group>
          )}
          {noteField}
          <Group gap="sm" justify="flex-end" className={classes['answers']}>
            {answers}
          </Group>
        </div>
      </div>
    </Stack>
  );
  if (framed) return <div style={{ marginTop: 'var(--mantine-spacing-sm)' }}>{bar}</div>;
  return <div className={classes['bar']}>{bar}</div>;
}

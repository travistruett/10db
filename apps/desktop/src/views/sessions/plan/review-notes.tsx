import type { ShapeFindingDto, ShapeFindingId } from '@10db/contracts';
import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Group,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useState } from 'react';
import { IconX } from '@tabler/icons-react';
import classes from './plan-rows.module.css';
import { CodeSpans } from './record/code-spans';
import { ceremonyLine, type RowReview } from './review-lines';

export interface ReviewNotesProps {
  readonly ceremony?: RowReview['ceremony'];
  readonly findings: readonly ShapeFindingDto[];
  readonly questions: readonly ShapeFindingDto[];
  /** Findings and questions already resolved or dismissed. */
  readonly settled?: number;
  readonly onDismiss: (id: ShapeFindingId) => void;
  readonly onCeremony?: (change: 'skip' | 'use') => void;
}

const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** An opened row shows this many notes until Show More. */
const NOTES_SHOWN = 3;

function NoteLine({
  finding,
  onDismiss,
}: {
  readonly finding: ShapeFindingDto;
  readonly onDismiss: ReviewNotesProps['onDismiss'];
}) {
  const isQuestion = finding.kind === 'question';
  const label = isQuestion
    ? 'Question'
    : `${capital(finding.reviewer)}${finding.severity === null ? '' : ` · ${capital(finding.severity)}`}`;
  // A long note shows three lines until it is clicked.
  const [whole, setWhole] = useState(false);
  return (
    <Group
      component="li"
      className={classes['note']}
      gap={6}
      wrap="nowrap"
      align="flex-start"
      style={{ listStyle: 'none' }}
    >
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Text fz={12} c="dimmed">
          {label}
        </Text>
        <UnstyledButton
          aria-expanded={whole}
          onClick={() => {
            setWhole((on) => !on);
          }}
          style={{ textAlign: 'left', cursor: whole ? 'default' : 'pointer' }}
        >
          <Text fz={13} c="dimmed" {...(whole ? {} : { lineClamp: 3 })}>
            <CodeSpans text={finding.text} />
          </Text>
        </UnstyledButton>
      </Stack>
      <Tooltip label="Dismiss">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="xs"
          className={classes['dismiss']}
          aria-label={`Dismiss ${isQuestion ? 'question' : 'finding'}: ${finding.text}`}
          onClick={() => {
            onDismiss(finding.id);
          }}
        >
          <IconX size={12} stroke={1.5} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

/**
 * What an opened row says about its review: the spec the ceremony asks for (with Skip Spec), the open
 * findings and the rehearsal's open questions, each a small tag, the words and a quiet Dismiss.
 */
export function ReviewNotes({
  ceremony,
  findings,
  questions,
  settled = 0,
  onDismiss,
  onCeremony,
}: ReviewNotesProps) {
  const [all, setAll] = useState(false);
  const line = ceremony === undefined ? null : ceremonyLine(ceremony);
  if (line === null && findings.length === 0 && questions.length === 0 && settled === 0)
    return null;
  const notes = [...findings, ...questions];
  const shown = all ? notes : notes.slice(0, NOTES_SHOWN);
  return (
    <Box
      component="ul"
      aria-label="Review notes"
      m={0}
      p={0}
      style={{ listStyle: 'none', display: 'grid', gap: 12 }}
    >
      {notes.length === 0 ? null : (
        <Text component="li" fz={12} fw={600} c="dimmed" style={{ listStyle: 'none' }}>
          {`Review notes ${String(notes.length)}`}
        </Text>
      )}
      {line === null || ceremony === undefined ? null : (
        <Group component="li" gap="xs" wrap="nowrap" style={{ listStyle: 'none' }}>
          <Text fz={12} c="dimmed">
            {line}
          </Text>
          {onCeremony === undefined ? null : ceremony.skippedByYou ? (
            <Button
              variant="subtle"
              color="gray"
              size="compact-xs"
              onClick={() => {
                onCeremony('use');
              }}
            >
              Use spec
            </Button>
          ) : ceremony.reasons.length > 0 ? (
            <Button
              variant="subtle"
              color="gray"
              size="compact-xs"
              onClick={() => {
                onCeremony('skip');
              }}
            >
              Skip spec
            </Button>
          ) : null}
        </Group>
      )}
      {shown.map((f) => (
        <NoteLine key={f.id} finding={f} onDismiss={onDismiss} />
      ))}
      {shown.length === notes.length ? null : (
        <Box component="li" style={{ listStyle: 'none' }}>
          <Anchor
            component="button"
            type="button"
            fz={12}
            onClick={() => {
              setAll(true);
            }}
          >
            {`Show ${String(notes.length - shown.length)} More`}
          </Anchor>
        </Box>
      )}
      {settled === 0 ? null : (
        <Text component="li" fz={12} c="dimmed" style={{ listStyle: 'none' }}>
          {`${String(settled)} resolved or dismissed`}
        </Text>
      )}
    </Box>
  );
}

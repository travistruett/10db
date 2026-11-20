import type { ShapeFindingDto, ShapeFindingId } from '@10db/contracts';
import { Box, Button, Group, Text } from '@mantine/core';
import { IconHelpCircle, IconMessageExclamation } from '@tabler/icons-react';
import { ceremonyLine, type RowReview } from './review-lines';

export interface ReviewLinesProps {
  readonly review: RowReview;
  /** Say which tasks the rehearsal has not read (the Convert modal does; the sidebar stays quiet). */
  readonly showRehearsal?: boolean;
  /** Left padding, in pixels. */
  readonly pl?: number;
  /** Dismiss on a finding or question; absent, they are read-only. */
  readonly onDismiss?: (id: ShapeFindingId) => void;
  /** Skip a forced spec (pins `direct`), or take it back (unpins). Absent, the line has no button. */
  readonly onCeremony?: (change: 'skip' | 'use') => void;
}

function FindingLine({
  finding,
  label,
  onDismiss,
}: {
  readonly finding: ShapeFindingDto;
  readonly label: string | null;
  readonly onDismiss: ReviewLinesProps['onDismiss'];
}) {
  const isQuestion = finding.kind === 'question';
  const Icon = isQuestion ? IconHelpCircle : IconMessageExclamation;
  return (
    <Group component="li" gap={6} wrap="nowrap" align="flex-start" style={{ listStyle: 'none' }}>
      <Icon size={14} stroke={1.5} aria-hidden="true" style={{ flex: 'none', marginTop: 3 }} />
      <Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 0 }}>
        {isQuestion
          ? null
          : `${finding.reviewer}${finding.severity === null ? '' : ` · ${finding.severity}`} · `}
        {label === null ? null : <b>{label}: </b>}
        {finding.text}
      </Text>
      {onDismiss === undefined ? null : (
        <Button
          variant="subtle"
          size="compact-xs"
          aria-label={`Dismiss ${isQuestion ? 'question' : 'finding'}: ${finding.text}`}
          onClick={() => {
            onDismiss(finding.id);
          }}
        >
          Dismiss
        </Button>
      )}
    </Group>
  );
}

/**
 * What the review has to say under a goal or task row (spec §7): the ceremony and whether the spec is
 * written, the scope and engineering reviewers' open findings, and the rehearsal's open questions under
 * the task they are about. Resolved and dismissed ones are counted, not listed.
 */
export function ReviewLines({
  review,
  showRehearsal,
  pl = 0,
  onDismiss,
  onCeremony,
}: ReviewLinesProps) {
  const ceremony = review.ceremony === undefined ? null : ceremonyLine(review.ceremony);
  const named = review.tasks.length > 1;
  const unread = showRehearsal === true ? review.tasks.filter((t) => t.state !== 'rehearsed') : [];
  const questions = review.tasks.flatMap((t) => t.questions.map((q) => ({ task: t.key, q })));
  const empty =
    ceremony === null &&
    unread.length === 0 &&
    questions.length === 0 &&
    review.findings.length === 0 &&
    review.settled === 0;
  if (empty) return null;
  return (
    <Box
      component="ul"
      m={0}
      pt={2}
      style={{ listStyle: 'none', padding: `2px 0 0 ${String(pl)}px` }}
    >
      {ceremony === null ? null : (
        <Group component="li" gap="xs" wrap="nowrap" style={{ listStyle: 'none' }}>
          <Text size="xs" c="dimmed">
            {ceremony}
          </Text>
          {onCeremony === undefined || review.ceremony === undefined ? null : review.ceremony
              .skippedByYou ? (
            <Button
              variant="subtle"
              size="compact-xs"
              onClick={() => {
                onCeremony('use');
              }}
            >
              Use spec
            </Button>
          ) : review.ceremony.reasons.length > 0 ? (
            <Button
              variant="subtle"
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
      {unread.map((t) => (
        <Text key={t.key} component="li" size="xs" c="dimmed" style={{ listStyle: 'none' }}>
          {named ? `${t.key}: ` : ''}
          {t.state === 'rehearsing' ? 'Rehearsing…' : 'Not rehearsed'}
        </Text>
      ))}
      {review.findings.map((f) => (
        <FindingLine key={f.id} finding={f} label={null} onDismiss={onDismiss} />
      ))}
      {questions.map(({ task, q }) => (
        <FindingLine key={q.id} finding={q} label={named ? task : null} onDismiss={onDismiss} />
      ))}
      {review.settled === 0 ? null : (
        <Text component="li" size="xs" c="dimmed" style={{ listStyle: 'none' }}>
          {`${String(review.settled)} resolved or dismissed`}
        </Text>
      )}
    </Box>
  );
}

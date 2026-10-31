import { findingBody, type Finding } from '@10db/contracts';
import { Badge, Button, Code, Group, Stack, Text } from '@mantine/core';
import { useState } from 'react';

/** Severity words that stop the work are red; the rest are advice. */
const BLOCKING = new Set(['BLOCKING', 'BLOCKER', 'CRITICAL', 'HIGH', 'MAJOR']);

/** A reviewer's findings, each with its severity and `file:line`. Their text is agent output: shown as text only. */
export function FindingsList({ findings }: { readonly findings: readonly Finding[] }) {
  return (
    <Stack gap={6}>
      {findings.map((finding, index) => (
        // The findings of one review never reorder, so the position names one.
        <Group key={index} gap="xs" wrap="nowrap" align="flex-start">
          {finding.severity === null ? null : (
            <Badge
              size="sm"
              variant="light"
              color={BLOCKING.has(finding.severity) ? 'red' : 'gray'}
              style={{ flexShrink: 0 }}
            >
              {finding.severity}
            </Badge>
          )}
          <div style={{ minWidth: 0 }}>
            {finding.location === null ? null : (
              <Text size="xs" ff="monospace" style={{ overflowWrap: 'anywhere' }}>
                {finding.location}
              </Text>
            )}
            <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
              {findingBody(finding)}
            </Text>
          </div>
        </Group>
      ))}
    </Stack>
  );
}

/** The whole review, behind one click: the findings above are only its headlines. */
export function FullReview({ summary }: { readonly summary: string }) {
  const [shown, setShown] = useState(false);
  return (
    <Stack gap="xs" align="flex-start">
      <Button
        size="compact-xs"
        variant="subtle"
        onClick={() => {
          setShown((was) => !was);
        }}
      >
        {shown ? 'Hide the full review' : 'Show the full review'}
      </Button>
      {shown ? (
        <Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', width: '100%' }}>
          {summary}
        </Code>
      ) : null}
    </Stack>
  );
}

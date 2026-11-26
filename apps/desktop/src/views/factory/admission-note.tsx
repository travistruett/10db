import { AdmissionHoldKind, type AdmissionHoldDto } from '@10db/contracts';
import { Badge, HoverCard, Stack, Text } from '@mantine/core';
import { IconGauge } from '@tabler/icons-react';
import { useAdmission } from '../../daemon/admission-queries';

/** The pill's words for a hold, and its colour: a full lane cap is the factory working, not a problem. */
function pillFor(hold: AdmissionHoldDto): { readonly label: string; readonly color: string } {
  switch (hold.kind) {
    case AdmissionHoldKind.Load:
      return { label: 'Mac Busy', color: 'yellow' };
    case AdmissionHoldKind.Disk:
      return { label: 'Disk Low', color: 'yellow' };
    case AdmissionHoldKind.LaneCap:
      return { label: 'Lanes Full', color: 'gray' };
  }
}

/**
 * A pill in Factory's title row saying new work waits on this Mac: a load that has stayed high, low free
 * disk, or the lane cap across all projects. It names the first hold; hovering it gives every hold's
 * sentence. Nothing shows while nothing holds.
 */
export function AdmissionNote() {
  const holds = useAdmission().data?.holds ?? [];
  const first = holds[0];
  if (first === undefined) return null;
  const pill = pillFor(first);
  return (
    <HoverCard width={320} position="bottom-end" withArrow shadow="md" openDelay={150}>
      <HoverCard.Target>
        <Badge
          component="button"
          type="button"
          role="status"
          aria-label={`New work held: ${pill.label}`}
          variant="light"
          color={pill.color}
          size="lg"
          tt="none"
          fw={500}
          leftSection={<IconGauge size={14} stroke={1.5} aria-hidden />}
          style={{ cursor: 'default' }}
        >
          {pill.label}
        </Badge>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Stack gap={4}>
          {holds.map((hold) => (
            <Text key={hold.kind} size="xs">
              {hold.line}
            </Text>
          ))}
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

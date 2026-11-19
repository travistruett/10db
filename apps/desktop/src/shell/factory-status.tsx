import { HoverCard, Stack, Text, VisuallyHidden } from '@mantine/core';
import { StatusKind, type BusyLevel, type StatusLine } from '@10db/contracts';
import { useStatus } from '../daemon/status-queries';
import { useRailMode } from './rail-mode';
import classes from './factory-status.module.css';

/** From here the Mac is busy enough that 10db may soon hold new work. */
const VERY_BUSY = 1;

const Tone = { Busy: 'busy', Holding: 'holding' } as const;
type Tone = (typeof Tone)[keyof typeof Tone];

/**
 * The Factory row's status dot: what is holding work back, or about to. Amber while the Mac is very busy and a
 * hold is near, orange while 10db holds new work (for the load or any other hold); nothing otherwise. It sits in
 * the row's count slot, so nothing else moves when it shows, and its hovercard says in plain words what is
 * happening, what is busiest and how it ends. It never asks the builder to do anything: holds end by themselves.
 */
export function FactoryStatusDot() {
  const status = useStatus().data;
  const busy = status?.busy ?? null;
  // The load's own hold is `busy.holding`; its status line would say the same thing twice.
  const holds = (status?.lines ?? []).filter((line) => line.kind !== StatusKind.AdmissionHold);
  const compact = !useRailMode().labels;
  const loadShown = busy !== null && (busy.holding || busy.level >= VERY_BUSY);
  if (!loadShown && holds.length === 0) return null;
  const tone: Tone = holds.length > 0 || busy?.holding === true ? Tone.Holding : Tone.Busy;
  const phrase = tone === Tone.Holding ? 'New work is waiting' : 'Your Mac is very busy';
  return (
    <HoverCard
      role="tooltip"
      position="right-start"
      width={300}
      shadow="md"
      withArrow
      openDelay={150}
    >
      <HoverCard.Target>
        <span className={classes['target']} data-compact={compact ? '' : undefined}>
          <span className={classes['dot']} data-tone={tone} aria-hidden="true" />
          <VisuallyHidden>{phrase}</VisuallyHidden>
        </span>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Stack gap="sm" style={{ overflowWrap: 'anywhere' }}>
          {loadShown && <LoadPart busy={busy} />}
          {holds.map((hold) => (
            <HoldPart key={hold.key} hold={hold} />
          ))}
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

function LoadPart({ busy }: { readonly busy: BusyLevel }) {
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        {busy.holding ? 'Your Mac is too busy to start new work' : 'Your Mac is very busy'}
      </Text>
      <Text size="xs" c="dimmed">
        {busy.holding
          ? 'Work already running carries on. New work starts by itself once the Mac calms down.'
          : 'Everything keeps running. If it stays this busy for a few minutes, 10db waits before starting anything new.'}
      </Text>
      {busy.busiest.length > 0 && (
        <Text size="xs" c="dimmed">{`Busiest right now: ${busy.busiest.join(', ')}`}</Text>
      )}
    </Stack>
  );
}

function HoldPart({ hold }: { readonly hold: StatusLine }) {
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        {hold.line}
      </Text>
      {hold.details !== '' && (
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
          {hold.details}
        </Text>
      )}
      {hold.busiest.length > 0 && (
        <Text size="xs" c="dimmed">{`Busiest right now: ${hold.busiest.join(', ')}`}</Text>
      )}
    </Stack>
  );
}

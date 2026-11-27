import {
  SharingState,
  SharingStep,
  SharingStepStatus,
  type SharingStatusDto,
} from '@10db/contracts';
import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  CopyButton,
  Group,
  HoverCard,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import { IconWifi } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useConnectTailscale, useSetSharing, useSharing } from '../daemon/sharing-queries';
import { SettingsSectionKey } from '../views/settings/sections';

const STEP_NAME: Readonly<Record<SharingStep, string>> = {
  [SharingStep.Installed]: 'Tailscale',
  [SharingStep.Connected]: 'Tailscale connection',
  [SharingStep.Untagged]: 'tagged Mac',
  [SharingStep.Https]: 'HTTPS',
  [SharingStep.Certificate]: 'certificate',
  [SharingStep.Shared]: 'share',
};

const ICON_COLOR: Readonly<Record<SharingState, string>> = {
  [SharingState.Ready]: 'var(--mantine-color-green-6)',
  [SharingState.Paused]: 'var(--mantine-color-orange-6)',
  [SharingState.SettingUp]: 'var(--mantine-color-dimmed)',
  [SharingState.Off]: 'var(--mantine-color-dimmed)',
};

/** The state in words: the icon's name and the card's first line. */
function stateLine(status: SharingStatusDto): string {
  switch (status.state) {
    case SharingState.Ready:
      return 'Shared on your tailnet';
    case SharingState.Paused: {
      const broken = status.steps.find((s) => s.status !== SharingStepStatus.Ok);
      return `Sharing paused: ${broken === undefined ? 'a step failed' : STEP_NAME[broken.step]}`;
    }
    case SharingState.SettingUp:
      return "Sharing isn't set up";
    case SharingState.Off:
      return 'Not shared';
  }
}

/** Why Share can't be pressed yet, or null when every step before it passed. */
function shareBlocker(status: SharingStatusDto): string | null {
  const broken = status.steps.find(
    (s) => s.step !== SharingStep.Shared && s.status !== SharingStepStatus.Ok,
  );
  return broken === undefined ? null : `Waits for the ${STEP_NAME[broken.step]} step.`;
}

/**
 * Sharing this Mac on the tailnet, at the bar's right: an icon whenever Tailscale is there to read (green while
 * shared, orange while paused, grey otherwise), in the same place in every state so nothing moves. Its hover card,
 * which a click or focus also opens, says the state, copies the address and turns sharing on and off.
 */
export function SharingIndicator() {
  const status = useSharing().data;
  // With no steps to read Tailscale is missing, so nothing is set up, as Remote Access reads it.
  if (status === undefined || status.steps.length === 0) return null;
  const line = stateLine(status);
  return (
    <HoverCard position="bottom-end" width={300} withArrow openDelay={150} closeDelay={200}>
      <HoverCard.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={line}
          // After the view's actions, at the row's end, whether or not a view drew a title row.
          style={{ flex: 'none', order: 3, marginLeft: 'auto' }}
        >
          <IconWifi size={16} stroke={1.8} color={ICON_COLOR[status.state]} />
        </ActionIcon>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <SharingCard status={status} line={line} />
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

function SharingCard({
  status,
  line,
}: {
  readonly status: SharingStatusDto;
  readonly line: string;
}) {
  const set = useSetSharing();
  const connect = useConnectTailscale();
  const blocker = shareBlocker(status);
  const shared = status.enabled;
  const disconnected =
    status.steps.find((s) => s.step === SharingStep.Connected)?.status === SharingStepStatus.Failed;
  // Stop is always allowed; Share waits on the steps before it.
  const switchBlocked = !shared && blocker !== null;
  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Text size="sm" fw={500}>
          {line}
        </Text>
        <Switch
          aria-label="Share on your tailnet"
          // The card's tone is the off track's own: off, the track takes the border's tone so its shape shows.
          styles={
            shared
              ? undefined
              : { track: { backgroundColor: 'var(--mantine-color-default-border)' } }
          }
          checked={shared}
          disabled={switchBlocked || set.isPending}
          onChange={(event) => {
            set.mutate(
              event.currentTarget.checked
                ? { enabled: true, port: status.port }
                : { enabled: false },
            );
          }}
        />
      </Group>
      {switchBlocked ? (
        <Text size="xs" c="dimmed">
          {blocker}
        </Text>
      ) : null}
      {set.isError ? (
        <Text size="xs" c="red" role="alert">
          {set.error.message}
        </Text>
      ) : null}
      {status.state === SharingState.Ready && status.url !== null ? (
        <Group gap="xs" wrap="nowrap">
          <Text ff="monospace" size="xs" style={{ overflowWrap: 'anywhere', minWidth: 0, flex: 1 }}>
            {status.url}
          </Text>
          <CopyButton value={status.url}>
            {({ copied, copy }) => (
              <Button size="compact-xs" variant="default" onClick={copy} style={{ flex: 'none' }}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
        </Group>
      ) : null}
      {disconnected ? (
        <Box>
          <Button
            size="compact-sm"
            variant="default"
            loading={connect.isPending}
            onClick={() => {
              connect.mutate();
            }}
          >
            Turn on Tailscale
          </Button>
          {connect.isError ? (
            <Text size="xs" c="red" role="alert" mt={4} style={{ overflowWrap: 'anywhere' }}>
              {connect.error.message}
            </Text>
          ) : null}
        </Box>
      ) : null}
      <Anchor
        size="xs"
        renderRoot={(props) => (
          <Link
            {...props}
            to="/settings/$section"
            params={{ section: SettingsSectionKey.RemoteAccess }}
          />
        )}
      >
        Remote Access settings
      </Anchor>
    </Stack>
  );
}

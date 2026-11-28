import {
  DevicePlatform,
  SharingState,
  SharingStep,
  SharingStepStatus,
  type DeviceDto,
  type SharingStatusDto,
} from '@10db/contracts';
import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Group,
  HoverCard,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import { IconDeviceLaptop, IconDeviceMobile } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useDevices } from '../daemon/device-queries';
import { useConnectTailscale, useSetSharing, useSharing } from '../daemon/sharing-queries';
import { PairDeviceModal } from '../views/settings/pair-device-modal';
import { SettingsSectionKey } from '../views/settings/sections';
import { fromNow, useNow } from './relative';
import { ignoreRestingPointer } from './resting-pointer';

const STEP_NAME: Readonly<Record<SharingStep, string>> = {
  [SharingStep.Installed]: 'Tailscale',
  [SharingStep.Connected]: 'Tailscale connection',
  [SharingStep.Untagged]: 'tagged Mac',
  [SharingStep.Https]: 'HTTPS',
  [SharingStep.Certificate]: 'certificate',
  [SharingStep.Shared]: 'share',
};

/** What a failed step means, as the paused card's line says it. */
const STEP_BROKEN: Readonly<Record<SharingStep, string>> = {
  [SharingStep.Installed]: "Tailscale isn't installed on this Mac",
  [SharingStep.Connected]: 'Tailscale is disconnected on this Mac',
  [SharingStep.Untagged]: 'this Mac is tagged in Tailscale',
  [SharingStep.Https]: 'HTTPS is off for your tailnet',
  [SharingStep.Certificate]: "this Mac's certificate failed",
  [SharingStep.Shared]: 'the share stopped',
};

/** Remote access's mark: the title row's indicator, the Settings nav and the page's own pictures all draw it. */
export const SharingIcon = IconDeviceMobile;

const ICON_COLOR: Readonly<Record<SharingState, string>> = {
  [SharingState.Ready]: 'var(--mantine-color-green-6)',
  [SharingState.Paused]: 'var(--mantine-color-orange-6)',
  [SharingState.SettingUp]: 'var(--mantine-color-dimmed)',
  [SharingState.Off]: 'var(--mantine-color-dimmed)',
};

const STATE_NAME: Readonly<Record<SharingState, string>> = {
  [SharingState.Ready]: 'Remote access: on',
  [SharingState.Paused]: 'Remote access: paused',
  [SharingState.SettingUp]: 'Remote access: not set up',
  [SharingState.Off]: 'Remote access: off',
};

/**
 * The card's line under its title: the state, and what it means for the phone. `paired` is null while the device
 * list hasn't loaded, so the card never says none are paired before it knows.
 */
function stateLine(status: SharingStatusDto, paired: number | null): string {
  switch (status.state) {
    case SharingState.Ready:
      if (paired === null)
        return 'On. A paired phone can open 10db to answer the Inbox, and it gets a notification when a run waits on you.';
      if (paired === 0)
        return "On, but no phone is paired yet. Pair one to answer the Inbox and get notified when you're away from this Mac.";
      return paired === 1
        ? 'On. Your phone can open 10db to answer the Inbox, and it gets a notification when a run waits on you.'
        : 'On. Your phones can open 10db to answer the Inbox, and they get a notification when a run waits on you.';
    case SharingState.Paused: {
      const broken = status.steps.find((s) => s.status !== SharingStepStatus.Ok);
      const why = broken === undefined ? 'a check failed' : STEP_BROKEN[broken.step];
      return `Paused: ${why}. Your phone can't reach 10db until it's back.`;
    }
    case SharingState.SettingUp:
      return 'Not set up yet. Finish it in Settings to use 10db from your phone.';
    case SharingState.Off:
      return 'Off. Turn it on to use 10db from your phone. It runs over Tailscale, your own private network, so nothing on the internet can reach it.';
  }
}

/** Why the switch can't turn sharing on yet, or null when every step before it passed. */
function shareBlocker(status: SharingStatusDto): string | null {
  const broken = status.steps.find(
    (s) => s.step !== SharingStep.Shared && s.status !== SharingStepStatus.Ok,
  );
  return broken === undefined ? null : `Waits for the ${STEP_NAME[broken.step]} step.`;
}

/** The icon wrapper's ref: one function for every render, so the guard keeps what it has seen. */
function guardRestingPointer(element: HTMLElement | null): (() => void) | undefined {
  return element === null ? undefined : ignoreRestingPointer(element);
}

/**
 * Remote access, at the bar's right just before the view's actions: a phone icon whenever Tailscale is there to read
 * (green while shared, orange while paused, grey otherwise), in the same place in every state so nothing moves. Its
 * hover card, which a tap or keyboard focus also opens, says what sharing gets the builder, lists the paired devices,
 * pairs a phone and turns sharing on and off. The address is in Settings: on a device that isn't paired it opens
 * only the Not paired page.
 */
export function SharingIndicator() {
  const status = useSharing().data;
  const devices = useDevices();
  const [pairing, setPairing] = useState(false);
  // With no steps to read Tailscale is missing, so nothing is set up, as Remote Access reads it.
  if (status === undefined || status.steps.length === 0) return null;
  const name = STATE_NAME[status.state];
  return (
    <>
      {/* Kept mounted, so a Turn on Tailscale still running and the sign-in its refusal names survive the pointer
          leaving the card. */}
      <HoverCard
        position="bottom-end"
        width={320}
        withArrow
        openDelay={150}
        closeDelay={200}
        events={{ touch: true }}
        keepMounted
        // Mounted with the page, the list may have failed while the daemon was still connecting; opening asks again.
        onOpen={() => {
          if (!devices.isSuccess) void devices.refetch();
        }}
      >
        {/* Just before the view's actions, which stay at the row's end. The margin keeps it right where a view drew
            no title row. A Settings drawer's × sits right over it, so the wrapper keeps a pointer left resting there
            from opening the card over the page below. */}
        <Box
          ref={guardRestingPointer}
          style={{ display: 'flex', flex: 'none', order: 2, marginLeft: 'auto' }}
        >
          <HoverCard.Target>
            <ActionIcon variant="subtle" color="gray" aria-label={name}>
              <SharingIcon size={16} stroke={1.8} color={ICON_COLOR[status.state]} />
            </ActionIcon>
          </HoverCard.Target>
        </Box>
        <HoverCard.Dropdown>
          <SharingCard
            status={status}
            devices={devices.data ?? null}
            onPair={() => {
              setPairing(true);
            }}
          />
        </HoverCard.Dropdown>
      </HoverCard>
      {/* Beside the card, not in it: a closed card hides what it holds, portals included, so the dialog would vanish
          as the pointer moved onto it. */}
      <PairDeviceModal
        opened={pairing}
        onClose={() => {
          setPairing(false);
        }}
      />
    </>
  );
}

function SharingCard({
  status,
  devices,
  onPair,
}: {
  readonly status: SharingStatusDto;
  readonly devices: readonly DeviceDto[] | null;
  readonly onPair: () => void;
}) {
  const set = useSetSharing();
  const connect = useConnectTailscale();
  // The card speaks of phones, so a paired Mac doesn't count toward "your phone".
  const paired = devices?.filter((d) => d.platform !== DevicePlatform.Macos).length ?? null;
  const blocker = shareBlocker(status);
  const shared = status.enabled;
  const ready = status.state === SharingState.Ready;
  const disconnected =
    status.steps.find((s) => s.step === SharingStep.Connected)?.status === SharingStepStatus.Failed;
  // Stop is always allowed; Share waits on the steps before it.
  const switchBlocked = !shared && blocker !== null;
  return (
    <Stack gap="sm" role="group" aria-label="Remote access">
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Text size="sm" fw={500}>
          Remote access
        </Text>
        <Switch
          aria-label="Remote access"
          // The card's tone is the off track's own: off, the track takes the border's tone so its shape shows.
          styles={{
            track: shared ? {} : { backgroundColor: 'var(--mantine-color-default-border)' },
          }}
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
      <Group gap={8} wrap="nowrap" align="flex-start">
        <span
          aria-hidden
          style={{
            flex: 'none',
            width: 8,
            height: 8,
            marginTop: 6,
            borderRadius: '50%',
            background: ICON_COLOR[status.state],
          }}
        />
        <Text size="xs" c="dimmed">
          {stateLine(status, paired)}
        </Text>
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
      {ready && devices !== null && devices.length > 0 ? <PairedDevices devices={devices} /> : null}
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
      <Group justify="space-between" wrap="nowrap">
        {ready ? (
          <Button size="compact-sm" variant={paired === 0 ? 'filled' : 'default'} onClick={onPair}>
            {paired === null || paired === 0 ? 'Pair a phone' : 'Pair another phone'}
          </Button>
        ) : (
          <span />
        )}
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
          Settings
        </Anchor>
      </Group>
    </Stack>
  );
}

/** The paired devices by name, each with when it last reached this Mac. */
function PairedDevices({ devices }: { readonly devices: readonly DeviceDto[] }) {
  const now = useNow();
  return (
    <Stack
      gap={6}
      p="xs"
      style={{ borderRadius: 8, background: 'var(--mantine-color-default-hover)' }}
      aria-label="Paired devices"
    >
      {devices.map((device) => {
        const Icon = device.platform === DevicePlatform.Macos ? IconDeviceLaptop : IconDeviceMobile;
        return (
          <Group key={device.id} gap="sm" wrap="nowrap">
            <Icon size={16} stroke={1.8} style={{ flex: 'none' }} aria-hidden />
            <Box style={{ minWidth: 0 }}>
              <Text size="sm" truncate>
                {device.label}
              </Text>
              <Text size="xs" c="dimmed">
                {device.lastUsedAt === null
                  ? 'Not used yet'
                  : `Used ${fromNow(device.lastUsedAt, now)}`}
              </Text>
            </Box>
          </Group>
        );
      })}
    </Stack>
  );
}

import { Box, Button, Group, Stack, Text } from '@mantine/core';
import { IconCheck, IconDeviceDesktop, IconDeviceMobile } from '@tabler/icons-react';
import { PageGuide, STILL_SURFACE, type PageGuideHandle } from '../../shell/page-guide';
import { SharingIcon } from '../../shell/sharing-indicator';

export const REMOTE_ACCESS_GUIDE = 'How remote access works';

// Stills of the setup, drawn with the same marks and words as the page and the frame's sharing icon.

const ADDRESS = 'https://mac.tail4c2e.ts.net';

function Device({
  icon: Mark,
  name,
}: {
  readonly icon: typeof IconDeviceMobile;
  readonly name: string;
}) {
  return (
    <Stack gap={4} align="center" px={10} py={8} style={{ ...STILL_SURFACE, flex: 'none' }}>
      <Mark size={20} stroke={1.5} color="var(--mantine-color-dimmed)" />
      <Text fz={11}>{name}</Text>
    </Stack>
  );
}

/** This Mac and a phone, joined by the tailnet. */
function TailnetPicture() {
  return (
    <Group gap={0} wrap="nowrap" align="center">
      <Device icon={IconDeviceDesktop} name="This Mac" />
      <Stack gap={2} align="center" style={{ flex: 1, minWidth: 0 }} px={6}>
        <Text fz={10} c="dimmed">
          your tailnet
        </Text>
        <Box w="100%" style={{ borderTop: '1px dashed var(--mantine-color-teal-text)' }} />
      </Stack>
      <Device icon={IconDeviceMobile} name="Your phone" />
    </Group>
  );
}

function Done({ children }: { readonly children: string }) {
  return (
    <Group gap={8} wrap="nowrap">
      <IconCheck size={14} color="var(--mantine-color-green-6)" />
      <Text size="xs">{children}</Text>
    </Group>
  );
}

/** The page's checklist once every step is done. */
function ChecklistPicture() {
  return (
    <Stack gap={6} p={10} style={STILL_SURFACE}>
      <Done>HTTPS is on for your tailnet</Done>
      <Done>Certificate issued</Done>
      <Done>Shared on port 4319, tailnet only</Done>
    </Stack>
  );
}

/** The address to open on the phone, and the frame's sharing icon once it is shared. */
function AddressPicture() {
  return (
    <Stack gap={8}>
      <Group gap="xs" wrap="nowrap" p={10} style={STILL_SURFACE}>
        <Text size="xs" ff="monospace" truncate style={{ flex: 1, minWidth: 0 }}>
          {ADDRESS}
        </Text>
        <Button size="compact-xs" variant="default" tabIndex={-1}>
          Copy
        </Button>
      </Group>
      <Group gap={6} wrap="nowrap">
        <SharingIcon size={14} stroke={1.8} color="var(--mantine-color-green-6)" />
        <Text fz={11} c="dimmed">
          This icon, at the top right, turns green while it is shared.
        </Text>
      </Group>
    </Stack>
  );
}

/** How remote access works: what Tailscale is, why nothing on the internet can reach 10db, and the steps. */
export function RemoteAccessGuide({ guide }: { readonly guide: PageGuideHandle }) {
  return (
    <PageGuide
      guide={guide}
      lead="Tailscale makes a private network, your tailnet, between the devices you sign in to it. 10db shares itself only there, so nothing on the internet can reach it."
      steps={[
        {
          title: 'Join your devices',
          caption: 'Install Tailscale on this Mac and your phone, signed in to one account.',
          picture: <TailnetPicture />,
        },
        {
          title: '10db shares on it',
          caption: 'It gets a certificate for this Mac, then serves itself inside the tailnet.',
          picture: <ChecklistPicture />,
        },
        {
          title: 'Open it on your phone',
          caption: 'One address, wherever your phone has a connection.',
          picture: <AddressPicture />,
        },
      ]}
      scope="Tailscale is free for personal use. Pause sharing from the icon at any time."
    />
  );
}

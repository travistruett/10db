import { ActionIcon, Alert, Button, Group, Menu, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconChevronDown, IconExternalLink } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { SettingsSectionKey } from '../settings/sections';
import {
  OpenFailure,
  type OpenPageControl,
  type OpenPageRefusal as OpenPageRefusalInfo,
} from './open-page';

const MARK_UP = 'Mark Up Page';

/**
 * Mark Up Page, a split button whose menu also holds Open in Browser and Copy Link (Pick on Page spec §2);
 * where there is no Preview, Open in Browser, which reads Copy Link once the page has been opened in
 * this pass. A refusal is said by `OpenPageRefusal`.
 */
export function OpenPageButton({ control }: { readonly control: OpenPageControl }) {
  const { preview } = control;
  if (preview !== null)
    return (
      <Group gap={0} wrap="nowrap">
        <Button
          variant="default"
          size="xs"
          style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
          onClick={() => {
            void preview();
          }}
        >
          {MARK_UP}
        </Button>
        <Menu position="bottom-end" width={260}>
          <Menu.Target>
            <Button
              variant="default"
              size="xs"
              px={6}
              aria-label="More ways to open"
              style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeftWidth: 0 }}
            >
              <IconChevronDown size={14} stroke={1.5} />
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => void preview()}>
              <Stack gap={0}>
                <Text size="sm">{MARK_UP}</Text>
                <Text size="xs" c="dimmed">
                  A 10db window: click parts of the page and say what to change.
                </Text>
              </Stack>
            </Menu.Item>
            <Menu.Item onClick={() => void control.launch()}>Open in Browser</Menu.Item>
            <Menu.Item onClick={() => void control.copy()}>Copy Link</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
    );
  return (
    <Button
      variant="default"
      size="xs"
      onClick={() => {
        void control.act();
      }}
    >
      {control.opened ? 'Copy Link' : 'Open in Browser'}
    </Button>
  );
}

/** A queue row's small link icon: it always opens the page in the browser, never copies its link. */
export function OpenPageIcon({
  label,
  control,
}: {
  readonly label: string;
  readonly control: OpenPageControl;
}) {
  return (
    <ActionIcon
      variant="subtle"
      color="gray"
      size="sm"
      aria-label={`Open ${label} in Browser`}
      style={{ flex: 'none' }}
      onClick={() => {
        void control.launch();
      }}
    >
      <IconExternalLink size={16} stroke={1.5} />
    </ActionIcon>
  );
}

/** Why the page could not be opened, and the one thing that can fix it. */
export function OpenPageRefusal({ refusal }: { readonly refusal: OpenPageRefusalInfo }) {
  const retry = (
    <Button size="compact-xs" variant="light" color="red" onClick={() => void refusal.retry()}>
      Try Again
    </Button>
  );
  return (
    <Alert
      variant="light"
      color="red"
      radius="md"
      p="xs"
      w="100%"
      icon={<IconAlertTriangle size={16} stroke={1.5} />}
      title={refusal.title}
      withCloseButton
      closeButtonLabel="Dismiss"
      onClose={refusal.dismiss}
    >
      <Stack gap={6} align="flex-start">
        <Text size="xs">{refusal.reason}</Text>
        {refusal.failure === OpenFailure.Setup ? (
          <Group gap="xs">
            <Button
              size="compact-xs"
              variant="light"
              color="red"
              renderRoot={(props) => (
                <Link
                  {...props}
                  to="/settings/$section"
                  params={{ section: SettingsSectionKey.PagesAndPictures }}
                />
              )}
            >
              Open Settings › App Preview
            </Button>
            {retry}
          </Group>
        ) : (
          retry
        )}
      </Stack>
    </Alert>
  );
}

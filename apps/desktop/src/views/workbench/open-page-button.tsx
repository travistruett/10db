import { ActionIcon, Anchor, Button, Group, Menu, Stack, Text } from '@mantine/core';
import { IconChevronDown, IconExternalLink } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { SettingsSectionKey } from '../settings/sections';
import type { OpenPageControl } from './open-page';

function MenuLine({ title, byline }: { readonly title: string; readonly byline: string }) {
  return (
    <Stack gap={0}>
      <Text size="sm">{title}</Text>
      <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
        {byline}
      </Text>
    </Stack>
  );
}

/**
 * Open Preview, a split button whose menu says how each way of opening differs (Pick on Page spec §2);
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
          Open Preview
        </Button>
        <Menu position="bottom-end">
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
              <MenuLine
                title="Open Preview"
                byline="A 10db window, not your browser, where you can pick elements"
              />
            </Menu.Item>
            <Menu.Item onClick={() => void control.launch()}>
              <MenuLine
                title="Open in Browser"
                byline="Your default browser, with your own login and DevTools"
              />
            </Menu.Item>
            <Menu.Item onClick={() => void control.copy()}>
              <MenuLine title="Copy Link" byline="Copy the page's address to paste anywhere" />
            </Menu.Item>
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

/** Why the page could not be opened, with a link to Settings › App Preview, where the app address is set. */
export function OpenPageRefusal({ refusal }: { readonly refusal: string }) {
  return (
    <Text size="xs" c="red">
      {refusal}{' '}
      <Anchor
        size="xs"
        renderRoot={(props) => (
          <Link
            {...props}
            to="/settings/$section"
            params={{ section: SettingsSectionKey.PagesAndPictures }}
          />
        )}
      >
        Settings › App Preview
      </Anchor>
    </Text>
  );
}

import { ActionIcon, Anchor, Button, Text } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { SettingsSectionKey } from '../settings/sections';
import type { OpenPageControl } from './open-page';

/**
 * Open in Browser, a default button, which reads Copy Link once the page has been opened in this pass.
 * A refusal is said by `OpenPageRefusal`.
 */
export function OpenPageButton({ control }: { readonly control: OpenPageControl }) {
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

/** Why the page could not be opened, with a link to Settings › Pages and Pictures, where the app address is set. */
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
        Settings › Pages and Pictures
      </Anchor>
    </Text>
  );
}

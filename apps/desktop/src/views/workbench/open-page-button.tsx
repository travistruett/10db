import { Anchor, Button, Group, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { SettingsSectionKey } from '../settings/sections';
import type { OpenPageControl } from './open-page';

/**
 * Open Page, a default button, which reads Copy Link once the page has been opened in this pass. A
 * refusal is said beside it with a link to Settings › General, where the app address is set.
 */
export function OpenPageButton({ control }: { readonly control: OpenPageControl }) {
  return (
    <Group gap="xs" wrap="wrap">
      <Button
        variant="default"
        onClick={() => {
          void control.act();
        }}
      >
        {control.opened ? 'Copy Link' : 'Open Page'}
      </Button>
      {control.refusal === null ? null : (
        <Text size="xs" c="red">
          {control.refusal}{' '}
          <Anchor
            size="xs"
            renderRoot={(props) => (
              <Link
                {...props}
                to="/settings/$section"
                params={{ section: SettingsSectionKey.General }}
              />
            )}
          >
            Settings › General
          </Anchor>
        </Text>
      )}
    </Group>
  );
}

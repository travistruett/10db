import { Anchor } from '@mantine/core';
import { isTauri, openInBrowser } from '../../desktop/tauri';

/** The conversation in Slack: a new tab in a browser, the default browser in the desktop app. */
export function ThreadLink({ permalink }: { readonly permalink: string }) {
  return (
    <Anchor
      href={permalink}
      target="_blank"
      rel="noreferrer"
      size="xs"
      style={{ whiteSpace: 'nowrap' }}
      onClick={(event) => {
        if (!isTauri()) return;
        event.preventDefault();
        openInBrowser(permalink).catch(() => undefined);
      }}
    >
      Open in Slack
    </Anchor>
  );
}

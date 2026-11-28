import { Anchor } from '@mantine/core';
import { isTauri, openInBrowser } from '../../desktop/tauri';

/** A held card's pull request on GitHub: a new tab in a browser, the default browser in the desktop app. */
export function PullRequestLink({ url }: { readonly url: string }) {
  return (
    <Anchor
      href={url}
      target="_blank"
      rel="noreferrer"
      size="sm"
      style={{ overflowWrap: 'anywhere' }}
      onClick={(event) => {
        if (!isTauri()) return;
        event.preventDefault();
        openInBrowser(url).catch(() => undefined);
      }}
    >
      Open the Pull Request
    </Anchor>
  );
}

import { Anchor, Text } from '@mantine/core';
import { useState } from 'react';
import { isTauri, openInBrowser } from '../../desktop/tauri';

/**
 * A link out of the app: a new tab in a browser, the default browser in the desktop app. The desktop
 * app opens only the sites its opener allows (GitHub and Artificial Analysis here); for any other address it
 * says so, and the card keeps the URL in its text.
 */
export function ExternalLink({
  url,
  label,
  size = 'sm',
  inText = false,
}: {
  readonly url: string;
  readonly label: string;
  readonly size?: 'xs' | 'sm';
  /** Inside a line of text, where only an underline tells the link from the words around it. */
  readonly inText?: boolean;
}) {
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  return (
    <>
      <Anchor
        href={url}
        target="_blank"
        rel="noreferrer"
        size={size}
        underline={inText ? 'always' : 'hover'}
        onClick={(event) => {
          // A browser opens the tab itself; the desktop app's webview would follow nothing.
          if (!isTauri()) return;
          event.preventDefault();
          setOpenFailure(null);
          openInBrowser(url).catch((failure: unknown) => {
            setOpenFailure(
              `Couldn't open ${url}: ${failure instanceof Error ? failure.message : String(failure)}`,
            );
          });
        }}
      >
        {label}
      </Anchor>
      {openFailure ? (
        <Text size="sm" c="red">
          {openFailure}
        </Text>
      ) : null}
    </>
  );
}

/** A batch's pull request. */
export function PullRequestLink({ url }: { readonly url: string }) {
  return <ExternalLink url={url} label="Pull request" />;
}

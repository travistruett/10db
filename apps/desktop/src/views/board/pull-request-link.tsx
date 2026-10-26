import { Anchor, Text } from '@mantine/core';
import { useState } from 'react';
import { isTauri, openInBrowser } from '../../desktop/tauri';

/** A batch's pull request: a new tab in a browser, the default browser in the desktop app. */
export function PullRequestLink({ url }: { readonly url: string }) {
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  return (
    <>
      <Anchor
        href={url}
        target="_blank"
        rel="noreferrer"
        size="sm"
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
        Pull request
      </Anchor>
      {openFailure ? (
        <Text size="sm" c="red">
          {openFailure}
        </Text>
      ) : null}
    </>
  );
}

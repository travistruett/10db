import { ActionIcon, Anchor, Button, Text, Tooltip } from '@mantine/core';
import { IconGitPullRequest } from '@tabler/icons-react';
import { useState, type MouseEvent, type ReactNode } from 'react';
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
  icon,
  asButton = false,
}: {
  readonly url: string;
  readonly label: string;
  readonly size?: 'xs' | 'sm';
  /** Inside a line of text, where only an underline tells the link from the words around it. */
  readonly inText?: boolean;
  /** Drawn as this icon alone, named and tipped by its label, for a toolbar of links out. */
  readonly icon?: ReactNode;
  /** Drawn as a default button, for an Inbox card's bar. */
  readonly asButton?: boolean;
}) {
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  const open = (event: MouseEvent<HTMLAnchorElement>): void => {
    // A browser opens the tab itself; the desktop app's webview would follow nothing.
    if (!isTauri()) return;
    event.preventDefault();
    setOpenFailure(null);
    openInBrowser(url).catch((failure: unknown) => {
      setOpenFailure(
        `Couldn't open ${url}: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    });
  };
  return (
    <>
      {asButton ? (
        <Button
          component="a"
          href={url}
          target="_blank"
          rel="noreferrer"
          variant="default"
          onClick={open}
        >
          {label}
        </Button>
      ) : icon === undefined ? (
        <Anchor
          href={url}
          target="_blank"
          rel="noreferrer"
          size={size}
          underline={inText ? 'always' : 'hover'}
          onClick={open}
        >
          {label}
        </Anchor>
      ) : (
        <Tooltip label={label} withArrow>
          <ActionIcon
            component="a"
            href={url}
            target="_blank"
            rel="noreferrer"
            variant="subtle"
            color="gray"
            aria-label={label}
            onClick={open}
          >
            {icon}
          </ActionIcon>
        </Tooltip>
      )}
      {openFailure ? (
        <Text size="sm" c="red">
          {openFailure}
        </Text>
      ) : null}
    </>
  );
}

/** A batch's pull request; `button` draws it as its icon, for a toolbar of links out. */
export function PullRequestLink({
  url,
  button = false,
}: {
  readonly url: string;
  readonly button?: boolean;
}) {
  return button ? (
    <ExternalLink
      url={url}
      label="Pull Request"
      icon={<IconGitPullRequest size={18} stroke={1.5} />}
    />
  ) : (
    <ExternalLink url={url} label="Pull Request" />
  );
}

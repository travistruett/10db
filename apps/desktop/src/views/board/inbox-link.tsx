import { Anchor } from '@mantine/core';
import { Link } from '@tanstack/react-router';

/** Where the details of a refused start are: the card the daemon raised in the Inbox. */
export function InboxLink() {
  return (
    <Anchor component={Link} to="/inbox" size="sm">
      Open in Inbox
    </Anchor>
  );
}

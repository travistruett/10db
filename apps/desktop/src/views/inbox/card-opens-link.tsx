import { CARD_OPENS, CardOpens, type InboxItemDto } from '@10db/contracts';
import { Anchor } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { isSettingsSectionKey } from '../settings/sections';

/** Where a card says its fix is made (`detail.opens`), or null when it names none or names a place the app lacks. */
export function cardOpens(item: InboxItemDto): CardOpens | null {
  // The detail is JSON read back from the daemon: a boundary, so parse it.
  const opens = CardOpens.safeParse(item.detail?.[CARD_OPENS]);
  if (!opens.success) return null;
  return opens.data.to === 'settings' && !isSettingsSectionKey(opens.data.section)
    ? null
    : opens.data;
}

/** A link to the place a card's fix is made: a Settings section, or a file or folder on this Mac. */
export function CardOpensLink({ opens }: { readonly opens: CardOpens }) {
  if (opens.to === 'path')
    return (
      <Anchor size="sm" href={`file://${opens.path}`} title={opens.path}>
        {opens.label}
      </Anchor>
    );
  return (
    <Anchor
      size="sm"
      renderRoot={(props) => (
        <Link {...props} to="/settings/$section" params={{ section: opens.section }} />
      )}
    >
      {opens.label}
    </Anchor>
  );
}

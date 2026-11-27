import { Anchor, Group, Stack, Tabs, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import classes from './page-intro.module.css';

/** One tab of a page's toolbar. */
export interface PageTab<T extends string> {
  readonly value: T;
  readonly label: string;
}

/**
 * A page's tabs, drawn for the left of `PageIntro`'s toolbar: underlined, on the hairline the toolbar draws under
 * the whole row. The page keeps which tab is open (in the address, where a link should land on it) and draws the
 * open tab's content itself.
 */
export function PageTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  readonly tabs: readonly PageTab<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  /** What the tab list is, for assistive tech. */
  readonly label: string;
}) {
  return (
    <Tabs
      value={value}
      onChange={(next) => {
        const tab = tabs.find((t) => t.value === next);
        if (tab !== undefined) onChange(tab.value);
      }}
    >
      <Tabs.List className={classes['tabList']} aria-label={label}>
        {tabs.map((tab) => (
          <Tabs.Tab key={tab.value} value={tab.value}>
            {tab.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs>
  );
}

/** The quiet link at the end of a byline that opens the page's guide ("How watchpoints work"). */
export function GuideLink({
  children,
  onOpen,
}: {
  readonly children: string;
  readonly onOpen: () => void;
}) {
  return (
    <Anchor component="button" type="button" fz={13} className={classes['guide']} onClick={onOpen}>
      {children}
    </Anchor>
  );
}

/**
 * What a top-level view shows at the top of its content under the title row: an optional byline of one dim line
 * (13 px, a sentence at most) that may end in a `GuideLink`, and the page's `actions` (page-level selects,
 * utilities, then its one primary action) at the right. With `PageTabs` the actions move down beside the tabs, on
 * the toolbar under the byline. A view that lays its own row out passes it as `toolbar`. A part that is absent takes no space, and with every part
 * absent nothing is drawn. The byline is cut to one line, so a text byline carries its whole text as a tooltip;
 * the guide link is never cut.
 */
export function PageIntro({
  description,
  guide,
  tabs,
  actions,
  toolbar,
}: {
  readonly description?: ReactNode;
  /** A `GuideLink` after the byline. */
  readonly guide?: ReactNode;
  /** A `PageTabs`, at the toolbar's left. */
  readonly tabs?: ReactNode;
  /** The page's controls, at the toolbar's right. */
  readonly actions?: ReactNode;
  /** A row the view lays out itself, under the byline. */
  readonly toolbar?: ReactNode;
}) {
  const hasByline = description !== undefined || guide !== undefined;
  if (!hasByline && tabs === undefined && actions === undefined && toolbar === undefined)
    return null;
  const byline = hasByline ? (
    <Group gap={8} wrap="nowrap" align="baseline" style={{ flex: '1 1 auto', minWidth: 0 }}>
      {description === undefined ? null : (
        <Text
          fz={13}
          c="dimmed"
          lineClamp={1}
          style={{ flex: '0 1 auto', minWidth: 0 }}
          {...(typeof description === 'string' ? { title: description } : {})}
        >
          {description}
        </Text>
      )}
      {guide}
    </Group>
  ) : null;
  return (
    <Stack gap="sm">
      {tabs === undefined ? (
        // With no tabs the controls end the byline's row, so a page with one action spends no row on it.
        <Group justify="space-between" align="center" wrap="nowrap" gap="xl">
          {byline}
          {actions === undefined ? null : (
            <Group gap="xs" wrap="nowrap" style={{ flex: 'none', marginLeft: 'auto' }}>
              {actions}
            </Group>
          )}
        </Group>
      ) : (
        <>
          {byline}
          <Group
            justify="space-between"
            align="flex-end"
            wrap="nowrap"
            gap="md"
            className={classes['tabbed']}
          >
            {tabs}
            {actions === undefined ? null : (
              <Group gap="xs" wrap="nowrap" className={classes['tabbedActions']}>
                {actions}
              </Group>
            )}
          </Group>
        </>
      )}
      {toolbar === undefined ? null : (
        <Group justify="space-between" align="center">
          {toolbar}
        </Group>
      )}
    </Stack>
  );
}

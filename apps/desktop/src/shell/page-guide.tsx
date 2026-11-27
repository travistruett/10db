import { Box, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import classes from './page-guide.module.css';

/** One step of a guide: a few words, a line on what happens, and a still of the interface it happens in. */
export interface GuideStep {
  readonly title: string;
  /** About twelve words. */
  readonly caption: string;
  /** A small picture built from the app's own components; drawn inert, so nothing in it can be pressed. */
  readonly picture: ReactNode;
}

/** What opens a guide: its title as the link's words, and the open. A byline, an empty state and a hover card take it. */
export interface GuideOpener {
  readonly label: string;
  readonly onOpen: () => void;
}

/** Whether a page's guide is open, shared by everything on the page that opens it. */
export interface PageGuideHandle {
  /** "How watchpoints work": the modal's title and every link's words. */
  readonly title: string;
  readonly opened: boolean;
  readonly opener: GuideOpener;
  readonly close: () => void;
}

export function usePageGuide(title: string): PageGuideHandle {
  const [opened, setOpened] = useState(false);
  return {
    title,
    opened,
    opener: {
      label: title,
      onOpen: () => {
        setOpened(true);
      },
    },
    close: () => {
      setOpened(false);
    },
  };
}

/**
 * How a page's idea works, in a modal the builder opens and never one that opens itself: one sentence on what it
 * is and why it matters, up to three steps each with a still of the real interface, an optional example and one
 * line on scope. It holds no links out, and no action but the page's first one where the page is still empty.
 * Its copy lives beside the page it explains, so the change that moves a feature moves its guide.
 */
export function PageGuide({
  guide,
  lead,
  steps,
  example,
  scope,
  action,
}: {
  readonly guide: PageGuideHandle;
  readonly lead: ReactNode;
  readonly steps: readonly GuideStep[];
  /** One real instance of the thing, set apart under the steps. */
  readonly example?: ReactNode;
  /** One line on where it applies. */
  readonly scope?: ReactNode;
  /** The page's first action, offered only while the page is empty. */
  readonly action?: { readonly label: string; readonly onClick: () => void };
}) {
  return (
    <Modal
      opened={guide.opened}
      onClose={guide.close}
      size={680}
      centered
      padding={24}
      title={
        <Text fz={16} fw={600} c="var(--mantine-color-bright)">
          {guide.title}
        </Text>
      }
    >
      <Stack gap="lg">
        <Text size="sm" maw={560}>
          {lead}
        </Text>
        <Stack gap="lg" component="ol" m={0} p={0} style={{ listStyle: 'none' }}>
          {steps.map((step, index) => (
            <li key={step.title} className={classes['step']}>
              <div className={classes['marker']} aria-hidden>
                <span className={classes['number']}>{index + 1}</span>
              </div>
              <Stack gap={4} pt={2}>
                <Text size="sm" fw={600}>
                  {step.title}
                </Text>
                <Text size="xs" c="dimmed">
                  {step.caption}
                </Text>
              </Stack>
              <Box className={classes['picture']} inert aria-hidden>
                {step.picture}
              </Box>
            </li>
          ))}
        </Stack>
        {example === undefined ? null : <Box className={classes['example']}>{example}</Box>}
        <Group justify="space-between" align="center" wrap="nowrap" gap="xl" mt={4}>
          {scope === undefined ? (
            <span />
          ) : (
            <Text size="xs" c="dimmed" style={{ textWrap: 'pretty' }}>
              {scope}
            </Text>
          )}
          <Group gap="xs" wrap="nowrap" style={{ flex: 'none' }}>
            {action === undefined ? null : (
              <Button
                onClick={() => {
                  guide.close();
                  action.onClick();
                }}
              >
                {action.label}
              </Button>
            )}
            <Button variant={action === undefined ? 'filled' : 'default'} onClick={guide.close}>
              Got It
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

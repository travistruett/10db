import type { Effort, ShapeModelOption } from '@10db/contracts';
import { Button, Group, Menu, Text, Tooltip } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import { useState } from 'react';
import { useModels } from '../daemon/model-queries';
import {
  chipLabel,
  effortLabel,
  effortRun,
  effortsOf,
  matching,
  nameOf,
  splitModels,
} from './model-menu-options';

/** The default effort's value: a radio group holds text, and null is what it means. */
const AUTOMATIC = '';

export interface ModelMenuProps {
  readonly offered: readonly ShapeModelOption[];
  /** The model the account's role resolves to; null before it is known. */
  readonly default: string | null;
  /** The model picked; null is the default. */
  readonly picked: string | null;
  /** The effort picked; null runs the model's own. */
  readonly effort: Effort | null;
  /** A turn runs or waits: a change takes effect between turns, so the chip is off and says so. */
  readonly busy: boolean;
  /** A pick is on its way. */
  readonly pending?: boolean;
  /** The daemon's refusal, shown beside the chip. */
  readonly error?: string | null;
  readonly onPick: (model: string | null, effort: Effort | null) => void;
}

/**
 * The model and effort a conversation's next turn runs on, as one chip in the composer: a menu of the
 * account's models, an Effort submenu listing what the model in use offers, and More models, searchable.
 */
export function ModelMenu({
  offered,
  default: defaultModel,
  picked,
  effort,
  busy,
  pending = false,
  error = null,
  onPick,
}: ModelMenuProps) {
  const models = useModels(null);
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  if (offered.length === 0) return null;

  const rows = new Map((models.data ?? []).map((row) => [row.model, row]));
  const inUse = picked ?? defaultModel;
  const efforts = effortsOf(inUse, rows);
  // The effort the next turn runs on, which the chip, the submenu's label and its radio all show.
  const runs = effortRun(inUse, effort, rows);
  const { main, more } = splitModels(offered, inUse);
  const found = matching(more, query, rows);
  const off = busy || pending;

  const pickModel = (model: string): void => {
    setOpened(false);
    if (model === inUse) return;
    // The effort stays while the new model offers it, else the model's own; until the list is known
    // nothing says it doesn't, so it stays.
    const kept = effort !== null && (rows.size === 0 || effortsOf(model, rows).includes(effort));
    onPick(model === defaultModel ? null : model, kept ? effort : null);
  };
  const pickEffort = (value: string): void => {
    setOpened(false);
    const next = efforts.find((e) => e === value) ?? null;
    if (next !== effort) onPick(picked, next);
  };
  const item = (model: string) => (
    <Menu.RadioItem key={model} value={model}>
      {model === defaultModel ? `${nameOf(model, rows)} (default)` : nameOf(model, rows)}
    </Menu.RadioItem>
  );

  return (
    <Group gap="xs" wrap="nowrap">
      {/* A disabled button hears no pointer, so the tooltip hangs on the span around the menu. */}
      <Tooltip label="Change the model between turns" disabled={!busy}>
        <span>
          <Menu
            opened={opened && !off}
            onChange={setOpened}
            position="top-start"
            width={240}
            withinPortal
            closeOnItemClick={false}
          >
            <Menu.Target>
              <Button
                variant="subtle"
                color="gray"
                size="compact-sm"
                aria-label="Model and effort"
                disabled={off}
                rightSection={<IconChevronDown size={12} stroke={1.5} />}
              >
                {chipLabel(inUse, effort, rows)}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Model</Menu.Label>
              <Menu.RadioGroup value={inUse ?? ''} onChange={pickModel}>
                {main.map(item)}
              </Menu.RadioGroup>
              <Menu.Divider />
              <Menu.Sub openDelay={80} closeDelay={150}>
                <Menu.Sub.Target>
                  <Menu.Sub.Item
                    disabled={efforts.length === 0}
                    rightSection={
                      <Text size="xs" c="dimmed">
                        {runs === null ? 'Automatic' : effortLabel(runs)}
                      </Text>
                    }
                  >
                    Effort
                  </Menu.Sub.Item>
                </Menu.Sub.Target>
                <Menu.Sub.Dropdown>
                  <Menu.RadioGroup value={runs ?? AUTOMATIC} onChange={pickEffort}>
                    <Menu.RadioItem value={AUTOMATIC}>Automatic</Menu.RadioItem>
                    {efforts.map((e) => (
                      <Menu.RadioItem key={e} value={e}>
                        {effortLabel(e)}
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                </Menu.Sub.Dropdown>
              </Menu.Sub>
              {more.length === 0 ? null : (
                <Menu.Sub openDelay={80} closeDelay={150}>
                  <Menu.Sub.Target>
                    <Menu.Sub.Item>More Models</Menu.Sub.Item>
                  </Menu.Sub.Target>
                  <Menu.Sub.Dropdown>
                    <Menu.Search
                      value={query}
                      placeholder="Search models"
                      onChange={(event) => {
                        setQuery(event.currentTarget.value);
                      }}
                    />
                    {found.length === 0 ? (
                      <Text size="sm" c="dimmed" ta="center" py="xs">
                        No model matches
                      </Text>
                    ) : (
                      <Menu.RadioGroup value={inUse ?? ''} onChange={pickModel}>
                        {found.map(item)}
                      </Menu.RadioGroup>
                    )}
                  </Menu.Sub.Dropdown>
                </Menu.Sub>
              )}
            </Menu.Dropdown>
          </Menu>
        </span>
      </Tooltip>
      {error === null ? null : (
        <Tooltip label={error} multiline maw={320}>
          <Text size="xs" c="red" lineClamp={1}>
            {error}
          </Text>
        </Tooltip>
      )}
    </Group>
  );
}

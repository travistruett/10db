import {
  ActionIcon,
  Button,
  Group,
  Loader,
  Menu,
  Paper,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { IconGitMerge, IconTrash } from '@tabler/icons-react';
import {
  addDraft,
  draftProblems,
  mergeDrafts,
  removeDraft,
  setGlobs,
  setName,
  type AreaDraft,
} from './area-drafts';
import { MONO_INPUT } from './folder-field';

export interface AreasFieldProps {
  /** Null while the daemon is still looking at the repository. */
  readonly drafts: readonly AreaDraft[] | null;
  /** Said above the list: why these areas are what is offered. */
  readonly note: string | null;
  readonly onChange: (drafts: AreaDraft[]) => void;
}

/**
 * The areas a new project starts with, proposed from the repository, for the builder to rename,
 * merge, remove and add to. Tasks in different areas can run side by side.
 */
export function AreasField({ drafts, note, onChange }: AreasFieldProps) {
  if (drafts === null) {
    return (
      <Group gap="xs" role="status">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          Looking for the areas of this repository…
        </Text>
      </Group>
    );
  }
  const problems = draftProblems(drafts);
  return (
    <Stack gap="xs">
      <div>
        <Text fw={500} size="sm">
          Areas
        </Text>
        <Text size="sm" c="dimmed">
          Tasks that work in different areas can run at the same time. Each area lists the files it
          holds, one glob to a line.
        </Text>
        {note === null ? null : (
          <Text size="sm" c="dimmed">
            {note}
          </Text>
        )}
      </div>
      {drafts.map((draft, index) => {
        const row = problems.rows.get(draft.key);
        const others = drafts.filter((d) => d.key !== draft.key);
        const label = draft.name.trim() === '' ? `area ${String(index + 1)}` : draft.name.trim();
        return (
          <Paper
            key={draft.key}
            withBorder
            p="sm"
            radius="md"
            role="group"
            aria-label={`Area ${String(index + 1)}`}
          >
            <Stack gap="xs">
              <Group align="flex-start" wrap="nowrap" gap="sm">
                <TextInput
                  aria-label={`Area ${String(index + 1)} name`}
                  placeholder="name"
                  w={180}
                  styles={MONO_INPUT}
                  value={draft.name}
                  error={row?.name}
                  onChange={(e) => {
                    onChange(setName(drafts, draft.key, e.currentTarget.value));
                  }}
                />
                <Textarea
                  aria-label={`Area ${String(index + 1)} globs`}
                  placeholder="apps/web/**"
                  autosize
                  minRows={1}
                  maxRows={6}
                  style={{ flex: 1 }}
                  styles={MONO_INPUT}
                  value={draft.globs}
                  error={row?.globs}
                  onChange={(e) => {
                    onChange(setGlobs(drafts, draft.key, e.currentTarget.value));
                  }}
                />
                <Menu position="bottom-end" disabled={others.length === 0}>
                  <Menu.Target>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={`Merge ${label}`}
                      disabled={others.length === 0}
                    >
                      <IconGitMerge size={16} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Label>Merge into</Menu.Label>
                    {others.map((other) => (
                      <Menu.Item
                        key={other.key}
                        onClick={() => {
                          onChange(mergeDrafts(drafts, draft.key, other.key));
                        }}
                      >
                        {other.name.trim() === '' ? 'Unnamed area' : other.name.trim()}
                      </Menu.Item>
                    ))}
                  </Menu.Dropdown>
                </Menu>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={`Remove ${label}`}
                  onClick={() => {
                    onChange(removeDraft(drafts, draft.key));
                  }}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
              {draft.reason === '' ? null : (
                <Text size="xs" c="dimmed">
                  {draft.reason}
                </Text>
              )}
            </Stack>
          </Paper>
        );
      })}
      {problems.whole === null ? null : (
        <Text size="sm" c="red" role="alert">
          {problems.whole}
        </Text>
      )}
      <Group>
        <Button
          size="compact-sm"
          variant="default"
          onClick={() => {
            onChange(addDraft(drafts));
          }}
        >
          Add area
        </Button>
      </Group>
    </Stack>
  );
}

import { ProjectId } from '@10db/contracts';
import {
  Box,
  Button,
  Combobox,
  Group,
  Text,
  Tooltip,
  UnstyledButton,
  useCombobox,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconAdjustments, IconCheck, IconPlus } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { NewProjectModal } from './new-project-modal';
import { ProjectTile } from './project-tile';
import { useSelectedProject } from './selected-project';
import { useUnsavedGuard } from './unsaved-guard';
import { SettingsSectionKey } from '../views/settings/sections';
import classes from './rail.module.css';

/** A home-relative path reads shorter, and the home folder is the same on every row. */
const tildePath = (path: string) => path.replace(/^\/Users\/[^/]+/u, '~');

/**
 * The current project, switched from its tile in the rail: the dropdown opens to the tile's right, lists
 * the projects, and leads to Project Settings and "New Project".
 */
export function ProjectSwitcher() {
  const { projects, project, select } = useSelectedProject();
  const guard = useUnsavedGuard();
  const [search, setSearch] = useState('');
  const [creating, creator] = useDisclosure(false);
  const combobox = useCombobox({
    onDropdownClose: () => {
      combobox.resetSelectedOption();
      setSearch('');
    },
    onDropdownOpen: () => {
      combobox.focusSearchInput();
    },
  });

  const query = search.trim().toLowerCase();
  const shown = (projects.data ?? []).filter(
    (p) =>
      p.name.toLowerCase().includes(query) || tildePath(p.repoPath).toLowerCase().includes(query),
  );

  return (
    <>
      <Combobox
        store={combobox}
        width={300}
        position="right-start"
        onOptionSubmit={(value) => {
          const chosen = ProjectId.parse(value);
          if (chosen !== project?.id) {
            guard.attempt(() => {
              select(chosen);
            });
          }
          combobox.closeDropdown();
        }}
      >
        <div className={classes['tileHost']}>
          <Tooltip
            label={project?.name ?? 'Choose a project'}
            position="right"
            openDelay={300}
            disabled={combobox.dropdownOpened}
          >
            <Combobox.Target targetType="button">
              <UnstyledButton
                aria-label={`Project: ${project?.name ?? 'none'}. Switch project`}
                onClick={() => {
                  combobox.toggleDropdown();
                }}
              >
                <span className={classes['tileRing']}>
                  <ProjectTile name={project?.name ?? '?'} size={26} />
                </span>
              </UnstyledButton>
            </Combobox.Target>
          </Tooltip>
        </div>
        <Combobox.Dropdown>
          <Combobox.Search
            value={search}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
            }}
            placeholder="Find a project"
            aria-label="Find a project"
          />
          <Combobox.Options mah={240} style={{ overflowY: 'auto' }}>
            {shown.length === 0 ? (
              <Combobox.Empty>No project matches</Combobox.Empty>
            ) : (
              shown.map((p) => (
                <Combobox.Option value={p.id} key={p.id} active={p.id === project?.id}>
                  <Group gap="sm" wrap="nowrap">
                    <ProjectTile name={p.name} />
                    <Box flex={1} miw={0}>
                      <Text size="sm" fw={500}>
                        {p.name}
                      </Text>
                      <Text size="xs" c="dimmed" ff="monospace" truncate>
                        {tildePath(p.repoPath)}
                      </Text>
                    </Box>
                    {p.id === project?.id ? <IconCheck size={16} stroke={1.5} /> : null}
                  </Group>
                </Combobox.Option>
              ))
            )}
          </Combobox.Options>
          <Combobox.Footer p="sm">
            <Button
              renderRoot={(props) => (
                <Link
                  {...props}
                  to="/settings/$section"
                  params={{ section: SettingsSectionKey.General }}
                />
              )}
              variant="subtle"
              color="gray"
              c="var(--mantine-color-text)"
              size="sm"
              fullWidth
              justify="flex-start"
              mb={4}
              leftSection={<IconAdjustments size={14} stroke={1.5} />}
              onClick={() => {
                combobox.closeDropdown();
              }}
            >
              Project Settings
            </Button>
            <Button
              variant="default"
              size="sm"
              fullWidth
              leftSection={<IconPlus size={14} stroke={1.5} />}
              onClick={() => {
                combobox.closeDropdown();
                creator.open();
              }}
            >
              New Project
            </Button>
          </Combobox.Footer>
        </Combobox.Dropdown>
      </Combobox>
      {creating ? (
        <NewProjectModal
          onClose={creator.close}
          onCreated={(created) => {
            guard.attempt(() => {
              select(created.id);
            });
            creator.close();
          }}
        />
      ) : null}
    </>
  );
}

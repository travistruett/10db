import { ProjectId } from '@10db/contracts';
import {
  ActionIcon,
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
import { IconChevronDown, IconPlus, IconSettings } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { NewProjectModal } from './new-project-modal';
import { ProjectTile } from './project-tile';
import { useRailMode } from './rail-mode';
import { useSelectedProject } from './selected-project';
import { useUnsavedGuard } from './unsaved-guard';
import { SettingsSectionKey } from '../views/settings/sections';
import classes from './rail.module.css';

/** A home-relative path reads shorter, and the home folder is the same on every row. */
const tildePath = (path: string) => path.replace(/^\/Users\/[^/]+/u, '~');

/**
 * The current project, switched from the rail: a row with its tile and name below the rail's labels, or just the
 * tile when the rail is icons only. The dropdown lists the projects, the current one tinted, each with a gear that
 * opens its settings (switching to it first), and "New Project"; it opens below the row, or to the tile's right.
 */
export function ProjectSwitcher() {
  const { projects, project, select } = useSelectedProject();
  const guard = useUnsavedGuard();
  const { labels } = useRailMode();
  const [search, setSearch] = useState('');
  const [creating, creator] = useDisclosure(false);
  const navigate = useNavigate();
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
        position={labels ? 'bottom-start' : 'right-start'}
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
            label={project?.name ?? 'Choose a Project'}
            position="right"
            disabled={combobox.dropdownOpened || labels}
          >
            <Combobox.Target targetType="button">
              <UnstyledButton
                aria-label={`Project: ${project?.name ?? 'none'}. Switch project`}
                data-labelled={labels ? '' : undefined}
                onClick={() => {
                  combobox.toggleDropdown();
                }}
              >
                {labels ? (
                  <>
                    <ProjectTile name={project?.name ?? '?'} size={20} />
                    <span className={classes['projectName']}>
                      {project?.name ?? 'Choose a Project'}
                    </span>
                    <IconChevronDown size={12} stroke={1.8} aria-hidden />
                  </>
                ) : (
                  <span className={classes['tileRing']}>
                    <ProjectTile name={project?.name ?? '?'} size={26} />
                  </span>
                )}
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
                <Combobox.Option
                  value={p.id}
                  key={p.id}
                  active={p.id === project?.id}
                  className={classes['projectOption']}
                >
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
                    <ActionIcon
                      component="span"
                      role="button"
                      variant="subtle"
                      color="gray"
                      aria-label={`${p.name} settings`}
                      className={classes['projectGear']}
                      // The option selects on mouse down; the gear opens settings instead.
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        combobox.closeDropdown();
                        guard.attempt(() => {
                          if (p.id !== project?.id) select(p.id);
                          void navigate({
                            to: '/settings/$section',
                            params: { section: SettingsSectionKey.General },
                          });
                        });
                      }}
                    >
                      <IconSettings size={16} stroke={1.5} />
                    </ActionIcon>
                  </Group>
                </Combobox.Option>
              ))
            )}
          </Combobox.Options>
          <Combobox.Footer p="sm">
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

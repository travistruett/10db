import { ProjectId } from '@10db/contracts';
import { Box, Button, Combobox, Group, NavLink, Text, useCombobox } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconCheck, IconPlus, IconSelector } from '@tabler/icons-react';
import { useState } from 'react';
import { NewProjectForm } from '../views/board/new-project-form';
import { FormModal } from './form-modal';
import { ProjectTile } from './project-tile';
import { useSelectedProject } from './selected-project';

/** A home-relative path reads shorter, and the home folder is the same on every row. */
const tildePath = (path: string) => path.replace(/^\/Users\/[^/]+/u, '~');

/** The current project, switched from the top of the sidebar; its list ends in "New Project". */
export function ProjectSwitcher({ compact = false }: { readonly compact?: boolean }) {
  const { projects, project, select } = useSelectedProject();
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
        position="bottom-start"
        onOptionSubmit={(value) => {
          select(ProjectId.parse(value));
          combobox.closeDropdown();
        }}
      >
        <Combobox.Target targetType="button">
          <NavLink
            component="button"
            label={project?.name ?? 'Choose a project'}
            aria-label={`Project: ${project?.name ?? 'none'}. Switch project`}
            leftSection={<ProjectTile name={project?.name ?? '?'} size={compact ? 16 : 24} />}
            rightSection={<IconSelector size={compact ? 12 : 14} stroke={1.5} />}
            fw={600}
            {...(compact
              ? {
                  // A darker outlined well, so it reads as a control among the section links.
                  fz: 'sm',
                  py: 6,
                  mb: 'xs',
                  bg: 'var(--mantine-color-body)',
                  bd: '1px solid var(--mantine-color-default-border)',
                }
              : {})}
            onClick={() => {
              combobox.toggleDropdown();
            }}
          />
        </Combobox.Target>
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
      {/* Mounted only while open, so each new project starts from an empty form. */}
      {creating ? (
        <FormModal
          opened
          onClose={creator.close}
          title="New Project"
          actions={
            <Button variant="default" onClick={creator.close}>
              Cancel
            </Button>
          }
        >
          <NewProjectForm
            onCreated={(created) => {
              select(created.id);
              creator.close();
            }}
          />
        </FormModal>
      ) : null}
    </>
  );
}

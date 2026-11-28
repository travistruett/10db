import { RIGORS, type ProjectDto, type Rigor } from '@10db/contracts';
import { Select, Stack, Text } from '@mantine/core';
import { usePatchProject } from '../../daemon/queries';
import { usePageGuide } from '../../shell/page-guide';
import { PlaybookGuide, PLAYBOOK_GUIDE } from './playbook-guide';
import { PlaybookTable } from './playbook-table';
import { rigorLabel } from './rigor-labels';
import { SectionHeading } from './section-heading';
import { SettingRow, SettingsCard } from './setting-row';
import { SettingsSectionKey } from './sections';
import { SettingsPageHeader } from './settings-page';

const isRigor = (value: string): value is Rigor => RIGORS.some((r) => r === value);

/**
 * A project's playbook: the rigor its tasks get unless one says otherwise, and the same table as the global
 * playbook, where each field the project leaves alone follows the global one (Use global).
 */
export function ProjectPlaybook({ project }: { readonly project: ProjectDto }) {
  const patch = usePatchProject(project.id);
  const guide = usePageGuide(PLAYBOOK_GUIDE);
  return (
    <>
      <SettingsPageHeader
        sectionKey={SettingsSectionKey.Team}
        project={project}
        guide={guide.opener}
      />
      <Stack gap="xl">
        <SettingsCard>
          <SettingRow
            label="Default Rigor"
            description="The rigor a task gets when nothing sets its own."
          >
            <Select
              aria-label="Default Rigor"
              allowDeselect={false}
              data={RIGORS.map((r) => ({ value: r, label: rigorLabel(r) }))}
              value={project.defaultRigor}
              disabled={patch.isPending}
              onChange={(value) => {
                if (value !== null && isRigor(value) && value !== project.defaultRigor)
                  patch.mutate({ defaultRigor: value });
              }}
            />
          </SettingRow>
        </SettingsCard>
        {patch.isError ? (
          <Text size="sm" c="red" role="alert">
            {`Couldn't save: ${patch.error.message}`}
          </Text>
        ) : null}
        <Stack gap="sm" component="section" aria-label="Project playbook">
          <SectionHeading title="Rigor" line="What each step runs on this project's account." />
          <PlaybookTable projectId={project.id} accountId={project.accountId} />
        </Stack>
      </Stack>
      <PlaybookGuide guide={guide} project={project.name} />
    </>
  );
}

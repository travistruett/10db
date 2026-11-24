import type { ProjectDto } from '@10db/contracts';
import { Stack, Textarea, TextInput } from '@mantine/core';
import { PicturesStatus } from './pictures-status';
import { MONO_INPUT, useProjectFields } from './project-fields-state';
import { ScreensMatrixField } from './screens-matrix-field';
import { ProjectSaveBar } from './project-save-bar';
import { SettingRow, SettingsCard } from './setting-row';

/** Where the app runs and how pictures of its pages are taken, saved as one patch of what changed. */
export function ProjectPagesForm({ project }: { readonly project: ProjectDto }) {
  const fields = useProjectFields(project, [
    'appUrl',
    'previewCommand',
    'devLoginCommand',
    'screens',
  ]);
  const { values, errors, set } = fields;
  return (
    <Stack gap="xl">
      <SettingsCard title="Your App">
        <SettingRow
          label="App Address"
          description="Where your dev server answers."
          help="Where your dev server answers, such as http://localhost:5173. The UI Workbench's Open in Browser opens a page's route here, and pictures of pages are taken here; an https server with a self-signed certificate gets no pictures."
        >
          <TextInput
            aria-label="App Address"
            placeholder="http://localhost:5173"
            styles={MONO_INPUT}
            value={values.appUrl}
            error={errors.appUrl}
            onChange={(e) => {
              set({ appUrl: e.currentTarget.value });
            }}
          />
        </SettingRow>
        <SettingRow
          label="Preview Command"
          description="Starts your dev server while pages are open."
          help="Starts your dev server at the app address while pages are open in the UI Workbench, and stops it once they are finished or abandoned, so you never run it yourself. It runs under the gate's sandbox, which needs Allow localhost (Settings › Sandbox)."
        >
          <TextInput
            aria-label="Preview Command"
            placeholder="pnpm dev (optional)"
            styles={MONO_INPUT}
            value={values.previewCommand}
            error={errors.previewCommand}
            onChange={(e) => {
              set({ previewCommand: e.currentTarget.value });
            }}
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard title="Pictures of Pages" action={<PicturesStatus projectId={project.id} />}>
        <SettingRow
          label="Dev Login Command"
          description="Prints an address that signs a browser in."
          help="Prints an address on the app that signs a browser in, for pictures of pages that need a sign-in. It runs under the gate's sandbox."
        >
          <Textarea
            aria-label="Dev Login Command"
            placeholder="Optional"
            autosize
            minRows={1}
            styles={MONO_INPUT}
            value={values.devLoginCommand}
            error={errors.devLoginCommand}
            onChange={(e) => {
              set({ devLoginCommand: e.currentTarget.value });
            }}
          />
        </SettingRow>
        <SettingRow
          label="Screenshot Matrix"
          description="Each page is pictured in each viewport and theme."
          help="At most 4 pictures a route."
          stacked
        >
          <ScreensMatrixField
            value={values.screens}
            error={errors.screens}
            onChange={(screens) => {
              set({ screens });
            }}
          />
        </SettingRow>
      </SettingsCard>

      <ProjectSaveBar fields={fields} />
    </Stack>
  );
}

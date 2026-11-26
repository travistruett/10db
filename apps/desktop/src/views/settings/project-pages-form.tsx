import type { ProjectDto } from '@10db/contracts';
import { Stack, Textarea, TextInput } from '@mantine/core';
import { PicturesStatus } from './pictures-status';
import { MONO_INPUT, useProjectFields } from './project-fields-state';
import { ScreensMatrixField } from './screens-matrix-field';
import { HiddenFieldAlert } from './hidden-field-alert';
import { SettingRow, SettingsCard } from './setting-row';
import { SignInCheck } from './sign-in-check';

/** The contract a dev login command keeps, said where the builder sets it. */
const DEV_LOGIN_HELP =
  "Prints one address on the app that signs a browser in, for pictures of pages that need a sign-in. It runs under the gate's sandbox, and it must work by itself every time: create its fictional user if that user is missing, run only against the dev database, be safe to repeat, and print one sign-in URL or path. It runs with TENDB_APP_URL set to the address being photographed; for a separate copy's own app it runs in the copy's folder with TENDB_COPY_ID set too, and signs in to that copy's database. Never sign in as a user your tests or e2e cleanup delete. Check Sign-In runs it now. 10db also checks it when the app address or the command changes, when the daemon starts and once a day, and raises one Inbox card while it fails.";

/** Where the app runs and how pictures of its pages are taken, saved as one patch of what changed. */
export function ProjectPagesForm({ project }: { readonly project: ProjectDto }) {
  const fields = useProjectFields(project, [
    'appUrl',
    'previewCommand',
    'appStartCommand',
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
        <SettingRow
          label="App Start Command"
          description="Brings your dev stack up when nothing answers."
          help="Run once, in your project's folder under the gate's sandbox with Docker allowed, when a picture or the dev login finds nothing answering at the app address, such as make up. It should return once the stack is started; 10db then waits for the address to answer. Docker Desktop is opened first when it is stopped. A start that fails leaves one Inbox card and is not run again for ten minutes."
        >
          <TextInput
            aria-label="App Start Command"
            placeholder="make up (optional)"
            styles={MONO_INPUT}
            value={values.appStartCommand}
            error={errors.appStartCommand}
            onChange={(e) => {
              set({ appStartCommand: e.currentTarget.value });
            }}
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard title="Pictures of Pages" action={<PicturesStatus projectId={project.id} />}>
        <SettingRow
          label="Dev Login Command"
          description="Prints an address that signs a browser in."
          help={DEV_LOGIN_HELP}
          below={
            <SignInCheck
              project={project}
              unsaved={
                values.appUrl.trim() !== (project.appUrl ?? '') ||
                values.devLoginCommand.trim() !== (project.devLoginCommand ?? '')
              }
            />
          }
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

      <HiddenFieldAlert fields={fields} />
    </Stack>
  );
}

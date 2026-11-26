import { SignInCheckState, type ProjectDto, type SignInCheckDto } from '@10db/contracts';
import { Button, Code, Group, Image, Stack, Text } from '@mantine/core';
import { useCheckSignIn } from '../../daemon/screen-queries';

// Check Sign-In beside the dev login command: runs the saved command, signs the picture browser in and
// loads the app's first routed page, then shows that page, or the command's exit code and last lines.

function CheckResult({ check }: { readonly check: SignInCheckDto }) {
  if (check.state === SignInCheckState.SignedIn)
    return (
      <Stack gap={4}>
        <Text size="sm">{`Signed in: ${check.route ?? 'the app'} loaded`}</Text>
        {check.picture === null ? null : (
          <Image
            src={`data:image/png;base64,${check.picture}`}
            alt={`The app's ${check.route ?? 'first'} page, signed in`}
            w={320}
            radius="sm"
            style={{ border: '1px solid var(--mantine-color-default-border)' }}
          />
        )}
      </Stack>
    );
  const failed = check.state === SignInCheckState.Failed;
  return (
    <Stack gap={4}>
      <Text size="sm" c={failed ? 'red' : 'dimmed'}>
        {failed ? 'Not signed in: ' : 'Could not tell: '}
        {check.problem}
      </Text>
      {check.exitCode === null || !failed ? null : (
        <Text size="xs" c="dimmed">{`Exit code ${String(check.exitCode)}`}</Text>
      )}
      {check.output === '' ? null : (
        <Code block fz="xs">
          {check.output}
        </Code>
      )}
    </Stack>
  );
}

/**
 * The button and its answer. The check runs the project's saved address and command, so unsaved edits
 * to either must be saved first.
 */
export function SignInCheck({
  project,
  unsaved,
}: {
  readonly project: ProjectDto;
  readonly unsaved: boolean;
}) {
  const check = useCheckSignIn();
  const ready = project.appUrl !== null && project.devLoginCommand !== null;
  const why = !ready
    ? 'Set an app address and a dev login command first'
    : unsaved
      ? 'Save your changes first: the check runs what is saved'
      : null;
  return (
    <Stack gap="xs" align="flex-start">
      <Group gap="sm">
        <Button
          variant="default"
          size="xs"
          loading={check.isPending}
          disabled={why !== null}
          onClick={() => {
            check.mutate(project.id);
          }}
        >
          Check Sign-In
        </Button>
        {why === null ? null : (
          <Text size="xs" c="dimmed">
            {why}
          </Text>
        )}
      </Group>
      {check.data === undefined ? null : <CheckResult check={check.data} />}
      {check.error === null ? null : (
        <Text size="sm" c="red">
          {check.error.message}
        </Text>
      )}
    </Stack>
  );
}

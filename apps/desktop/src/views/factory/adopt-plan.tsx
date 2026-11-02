import { Alert, Button, Group, List, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import type { AdoptPlan } from './use-adopt-plan';

/** Why adopting failed for a reason other than the brief; shown in whichever surface is open. */
export function AdoptProblem({ adoption }: { readonly adoption: AdoptPlan }) {
  return adoption.problem ? (
    <Alert color="red" title="Couldn't adopt that plan">
      {adoption.problem}
    </Alert>
  ) : null;
}

/** Factory's one filled button. */
export function AdoptPlanButton({ adoption }: { readonly adoption: AdoptPlan }) {
  return (
    <Button loading={adoption.adopting} onClick={adoption.pick}>
      Adopt a Plan…
    </Button>
  );
}

/** Opens when the daemon refuses a brief: the file, and each error with where it is. */
export function RefusalModal({ adoption }: { readonly adoption: AdoptPlan }) {
  const { refusal } = adoption;
  return (
    <Modal
      opened={refusal !== null}
      onClose={adoption.dismissRefusal}
      title="This plan can't be adopted yet"
    >
      <Stack>
        <Text size="sm" ff="monospace" style={{ wordBreak: 'break-all' }}>
          {refusal?.path}
        </Text>
        <List spacing="xs" size="sm">
          {refusal?.errors.map((issue) => (
            <List.Item key={`${issue.path}\n${issue.message}`}>
              <Text size="sm" fw={600} span display="block">
                {issue.path}
              </Text>
              <Text size="sm" c="dimmed" span display="block">
                {issue.message}
              </Text>
            </List.Item>
          ))}
        </List>
        <AdoptProblem adoption={adoption} />
        <Group justify="flex-end">
          <Button variant="default" onClick={adoption.dismissRefusal}>
            Cancel
          </Button>
          <Button loading={adoption.adopting} onClick={adoption.pick}>
            Pick Again…
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** The browser has no native panel, so the plan's path is typed. */
export function TypedPathModal({ adoption }: { readonly adoption: AdoptPlan }) {
  return (
    <Modal opened={adoption.typing} onClose={adoption.dismissTyping} title="Adopt a plan">
      <TypedPathForm adoption={adoption} />
    </Modal>
  );
}

/**
 * The modal itself stays mounted while closed, but its body does not, so the typed path and the
 * field error live here and start empty on each open.
 */
function TypedPathForm({ adoption }: { readonly adoption: AdoptPlan }) {
  const [path, setPath] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const submit = () => {
    const trimmed = path.trim();
    if (!trimmed.startsWith('/')) {
      setFieldError('Enter the full path, starting with /.');
      return;
    }
    setFieldError(null);
    adoption.adoptPath(trimmed);
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Stack>
        <TextInput
          label="Plan path"
          description="The full path of a .md file on this Mac."
          placeholder="/Users/you/plans/importer.md"
          value={path}
          error={fieldError}
          onChange={(event) => {
            setPath(event.currentTarget.value);
            setFieldError(null);
          }}
          data-autofocus
        />
        <AdoptProblem adoption={adoption} />
        <Group justify="flex-end">
          <Button variant="default" onClick={adoption.dismissTyping}>
            Cancel
          </Button>
          <Button type="submit" loading={adoption.adopting}>
            Adopt
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

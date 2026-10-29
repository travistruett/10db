import type { AccountId, ProjectDto } from '@10db/contracts';
import { Box, Button, Group, Image, Stack, Stepper, Text, Title } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useState } from 'react';
import appIcon from '../../../app-icon.svg';
import { AccountDrawer } from '../settings/accounts/account-drawer';
import { AddAccountModal } from '../settings/accounts/add-account-modal';
import { useProjectSetup } from '../project-setup/project-setup';
import { SetupItem, SetupSection } from './setup-check';
import { useSetupCheck } from './use-setup-check';

const WELCOME = 0;
const CHECK = 1;
const ADD_PROJECT = 2;

/** The window has no title bar; this strip drags it and clears the traffic lights. */
const DRAG_STRIP_HEIGHT = 48;
const RAIL_WIDTH = 290;
const CONTENT_PADDING = 48;

function Welcome() {
  return (
    <>
      <Title order={2}>Welcome to 10db</Title>
      <Text c="dimmed" size="lg">
        Run Claude Code on your repositories, from task to pull request. Setup takes about a minute.
      </Text>
    </>
  );
}

function CheckYourSetup({ check }: { readonly check: ReturnType<typeof useSetupCheck> }) {
  const [adding, setAdding] = useState(false);
  const [signingIn, setSigningIn] = useState<AccountId | null>(null);
  return (
    <Stack gap="lg">
      <Title order={2} mb="xs">
        Check your setup
      </Title>
      <SetupSection
        title="Agents"
        onRecheck={check.recheckAgents}
        rechecking={check.rechecking.agents}
      >
        <SetupItem name="Claude Code" row={check.claude}>
          {check.claude.canAddLogin ? (
            <Group gap="xs" mt="xs">
              <Button
                size="xs"
                variant="default"
                onClick={() => {
                  setAdding(true);
                }}
              >
                Add Another Login
              </Button>
            </Group>
          ) : null}
        </SetupItem>
      </SetupSection>
      <SetupSection
        title="Tools"
        onRecheck={check.recheckTools}
        rechecking={check.rechecking.tools}
      >
        <SetupItem name="git" row={check.git} />
        <SetupItem name="GitHub CLI" row={check.gh} />
      </SetupSection>
      <AddAccountModal
        opened={adding}
        onClose={() => {
          setAdding(false);
        }}
        onCreated={setSigningIn}
      />
      <AccountDrawer
        accountId={signingIn}
        opened={signingIn !== null}
        onClose={() => {
          setSigningIn(null);
        }}
      />
    </Stack>
  );
}

/** What the footer's left end says: a submit error beside the button that caused it, or the login tasks will use. */
function FooterNote({
  error,
  runsAs,
}: {
  readonly error: string | null;
  readonly runsAs: string | null;
}) {
  return (
    <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
      {error ? (
        <Group gap="xs" wrap="nowrap" role="alert">
          <IconAlertTriangle
            size={20}
            stroke={1.5}
            color="var(--mantine-color-red-filled)"
            style={{ flex: 'none' }}
          />
          <Text size="sm" c="red" lineClamp={2} title={error}>
            {error}
          </Text>
        </Group>
      ) : runsAs ? (
        <Text size="sm" c="dimmed" role="status">
          Tasks will run as {runsAs}.
        </Text>
      ) : null}
    </Group>
  );
}

/**
 * The window a fresh install opens on, in place of the app shell: Welcome, a check of Claude Code, git
 * and gh, and the first project. A finished step can be clicked to go back; a later one cannot.
 */
export function FirstRun({ onCreated }: { readonly onCreated: (project: ProjectDto) => void }) {
  const [active, setActive] = useState(WELCOME);
  const check = useSetupCheck(active >= CHECK);
  const setup = useProjectSetup(onCreated);

  const canContinue =
    active === WELCOME ||
    (active === CHECK && check.canContinue) ||
    (active === ADD_PROJECT && setup.canSubmit);
  const advance = () => {
    if (active === ADD_PROJECT) setup.submit();
    else setActive(active + 1);
  };

  return (
    <Box h="100vh" style={{ display: 'flex', flexDirection: 'column' }}>
      <Box h={DRAG_STRIP_HEIGHT} data-tauri-drag-region style={{ flex: 'none' }} />
      <Group align="stretch" gap={0} wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
        <Stack
          w={RAIL_WIDTH}
          p="xl"
          pt="md"
          gap={36}
          style={{ flex: 'none', borderRight: '1px solid var(--mantine-color-default-border)' }}
        >
          <Group gap="sm">
            <Image src={appIcon} alt="" w={40} h={40} />
            <Text fw={700} size="xl">
              10db
            </Text>
          </Group>
          <Stepper
            active={active}
            onStepClick={setActive}
            orientation="vertical"
            allowNextStepsSelect={false}
            size="sm"
          >
            <Stepper.Step label="Welcome" description="What 10db does" />
            <Stepper.Step label="Check your setup" description="Claude, git, gh" />
            <Stepper.Step label="Add a project" description="A repository on this Mac" />
          </Stepper>
        </Stack>

        <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
          <Stack p={CONTENT_PADDING} gap="md" style={{ flex: 1, overflow: 'auto' }}>
            {active === WELCOME ? <Welcome /> : null}
            {active === CHECK ? <CheckYourSetup check={check} /> : null}
            {active === ADD_PROJECT ? (
              <Stack gap="lg">
                <Title order={2} mb="xs">
                  Add a project
                </Title>
                {setup.fields}
              </Stack>
            ) : null}
          </Stack>

          <Group
            justify="space-between"
            wrap="nowrap"
            px={CONTENT_PADDING}
            py="md"
            style={{ flex: 'none', borderTop: '1px solid var(--mantine-color-default-border)' }}
          >
            <FooterNote
              error={active === ADD_PROJECT ? setup.error : null}
              runsAs={active === CHECK ? check.runsAs : null}
            />
            <Group gap="sm" wrap="nowrap" style={{ flex: 'none' }}>
              {active > WELCOME ? (
                <Button
                  variant="default"
                  onClick={() => {
                    setActive(active - 1);
                  }}
                >
                  Back
                </Button>
              ) : null}
              <Button onClick={advance} disabled={!canContinue} loading={setup.pending}>
                {active === WELCOME
                  ? 'Get Started'
                  : active === ADD_PROJECT
                    ? 'Create Project'
                    : 'Continue'}
              </Button>
            </Group>
          </Group>
        </Stack>
      </Group>
    </Box>
  );
}

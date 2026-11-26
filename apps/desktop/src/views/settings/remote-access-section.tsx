import {
  SharingState,
  SharingStep,
  SharingStepStatus,
  type SharingStatusDto,
  type SharingStepDto,
} from '@10db/contracts';
import {
  Accordion,
  Anchor,
  Badge,
  Button,
  CopyButton,
  Group,
  List,
  NumberInput,
  Paper,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconCheck, IconCircle, IconClock, IconX } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { openWebLink } from '../../desktop/tauri';
import {
  useRequestCertificate,
  useSetSharing,
  useSharingPolled,
} from '../../daemon/sharing-queries';
import { SectionHeading } from './section-heading';
import { SettingsCard } from './setting-row';

const TAILSCALE_URL = 'https://tailscale.com';
const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';
const TAILSCALE_DNS_URL = 'https://login.tailscale.com/admin/dns';

const STATE_LABEL: Readonly<Record<SharingState, string>> = {
  [SharingState.Off]: 'Off',
  [SharingState.SettingUp]: 'Setting up',
  [SharingState.Ready]: 'Ready',
  [SharingState.Paused]: 'Paused',
};

const STATE_COLOR: Readonly<Record<SharingState, string>> = {
  [SharingState.Off]: 'gray',
  [SharingState.SettingUp]: 'yellow',
  [SharingState.Ready]: 'green',
  [SharingState.Paused]: 'orange',
};

/** A page outside 10db opens through the app's own link helper, which confirms the host. */
function ExternalLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <Anchor
      component="button"
      type="button"
      size="inherit"
      onClick={() => {
        openWebLink(href).catch(() => undefined);
      }}
    >
      {children}
    </Anchor>
  );
}

function TailscaleLine() {
  return (
    <Text size="sm" c="dimmed">
      Reach this Mac's 10db from your phone, and later another Mac. It runs over{' '}
      <ExternalLink href={TAILSCALE_URL}>Tailscale ↗</ExternalLink>, a private network between your
      own devices, so nothing on the internet can reach it.
    </Text>
  );
}

function NeedsTailscale() {
  return (
    <Paper withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={4}>
            <Title order={4}>Remote Access needs Tailscale</Title>
            <Text size="sm" c="dimmed">
              Tailscale is a private network between your own devices. Your phone reaches this Mac
              through it, and nothing on the internet can. It's free for personal use.
            </Text>
          </Stack>
          <Button
            variant="default"
            style={{ flex: 'none' }}
            onClick={() => {
              openWebLink(TAILSCALE_DOWNLOAD_URL).catch(() => undefined);
            }}
          >
            Get Tailscale ↗
          </Button>
        </Group>
        <List type="ordered" size="sm" spacing="xs">
          <List.Item>Install Tailscale on this Mac and sign in.</List.Item>
          <List.Item>Install it on your phone and sign in to the same account.</List.Item>
          <List.Item>Come back here. 10db finds it on its own.</List.Item>
        </List>
      </Stack>
    </Paper>
  );
}

function StepMark({ status }: { readonly status: SharingStepStatus }) {
  switch (status) {
    case SharingStepStatus.Ok:
      return <IconCheck size={18} color="var(--mantine-color-green-6)" aria-label="Done" />;
    case SharingStepStatus.Failed:
      return <IconX size={18} color="var(--mantine-color-red-6)" aria-label="Needs attention" />;
    case SharingStepStatus.Waiting:
      return <IconClock size={18} color="var(--mantine-color-yellow-6)" aria-label="Waiting" />;
    case SharingStepStatus.Todo:
      return <IconCircle size={18} color="var(--mantine-color-dimmed)" aria-label="Not yet" />;
  }
}

const PUBLIC_LOG_LINE =
  'Each certificate writes this name to public certificate logs. Rename this Mac first if the name says who you are.';

/** One checklist row: its mark, its title, its sub lines and what fixes it. */
function StepRow({
  step,
  title,
  lines = [],
  children,
}: {
  readonly step: SharingStepDto;
  readonly title: string;
  readonly lines?: readonly (string | null)[];
  readonly children?: ReactNode;
}) {
  return (
    <Group align="flex-start" wrap="nowrap" gap="sm" px="md" py="sm" data-step={step.step}>
      <StepMark status={step.status} />
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" fw={500}>
          {title}
        </Text>
        {lines.map((line) =>
          line === null ? null : (
            <Text key={line} size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
              {line}
            </Text>
          ),
        )}
        {children}
      </Stack>
    </Group>
  );
}

const failed = (step: SharingStepDto) => step.status === SharingStepStatus.Failed;

/** The title and lines for each step that is not the certificate or sharing step. */
function PlainStep({
  step,
  status,
}: {
  readonly step: SharingStepDto;
  readonly status: SharingStatusDto;
}) {
  switch (step.step) {
    case SharingStep.Installed:
      return <StepRow step={step} title="Tailscale is installed" lines={[step.detail]} />;
    case SharingStep.Connected:
      return failed(step) ? (
        <StepRow step={step} title="Open Tailscale and connect" lines={[step.error]} />
      ) : (
        <StepRow
          step={step}
          title={status.login === null ? 'Connected' : `Connected as ${status.login}`}
          lines={[status.fqdn]}
        />
      );
    case SharingStep.Untagged:
      return failed(step) ? (
        <StepRow
          step={step}
          title="This Mac is tagged"
          lines={[
            'A tagged Mac gets no identity headers. Untag it in the Tailscale admin console.',
          ]}
        />
      ) : (
        <StepRow
          step={step}
          title="This Mac isn't tagged"
          lines={[
            "A tagged Mac gets no identity headers, so 10db couldn't tell your devices from someone else's.",
          ]}
        />
      );
    case SharingStep.Https:
      return failed(step) ? (
        <StepRow step={step} title="Turn on HTTPS" lines={[step.error, publicName(status)]}>
          <DnsLink />
        </StepRow>
      ) : (
        <StepRow step={step} title="HTTPS is on for your tailnet" lines={[]} />
      );
    case SharingStep.Certificate:
    case SharingStep.Shared:
      return null;
  }
}

function DnsLink() {
  return (
    <div>
      <Button
        size="compact-sm"
        variant="default"
        onClick={() => {
          openWebLink(TAILSCALE_DNS_URL).catch(() => undefined);
        }}
      >
        Open DNS Settings
      </Button>
    </div>
  );
}

/** The name-is-public line; a certificate that already exists says so instead. */
function publicName(status: SharingStatusDto): string | null {
  if (status.fqdn === null) return null;
  const name = status.fqdn.split('.')[0] ?? status.fqdn;
  return status.certificateExists
    ? `A certificate for ${name} already exists, so this name is already in public certificate logs.`
    : `${name}: ${PUBLIC_LOG_LINE}`;
}

function CertificateStep({
  step,
  status,
}: {
  readonly step: SharingStepDto;
  readonly status: SharingStatusDto;
}) {
  const request = useRequestCertificate();
  const earlier = status.steps.filter((s) => s.step !== SharingStep.Certificate);
  const ready = earlier
    .filter((s) => s.step !== SharingStep.Shared)
    .every((s) => s.status === SharingStepStatus.Ok);
  if (step.status === SharingStepStatus.Ok) {
    return <StepRow step={step} title="Certificate issued" lines={[step.detail]} />;
  }
  if (!status.certificateRequested && !status.certificateExists) {
    return (
      <StepRow step={step} title="Get a certificate for this Mac" lines={[publicName(status)]}>
        <Group gap="sm">
          <Button
            size="compact-sm"
            disabled={!ready}
            loading={request.isPending}
            onClick={() => {
              request.mutate();
            }}
          >
            Get Certificate
          </Button>
          {request.isError ? (
            <Text size="xs" c="red">
              {request.error.message}
            </Text>
          ) : null}
        </Group>
      </StepRow>
    );
  }
  return (
    <StepRow
      step={step}
      title={step.status === SharingStepStatus.Todo ? 'Certificate' : 'Getting a certificate…'}
      lines={[
        'The first one can take about ten minutes. 10db keeps checking, about once a minute.',
        step.error === null ? null : `Last try: ${step.error}`,
      ]}
    >
      <DnsLink />
    </StepRow>
  );
}

/** The port field, its action, and what the daemon refused with. */
function PortControl({
  status,
  action,
  disabled,
}: {
  readonly status: SharingStatusDto;
  readonly action: 'Share' | 'Change Port';
  readonly disabled: boolean;
}) {
  const set = useSetSharing();
  const [port, setPort] = useState<number>(status.port);
  return (
    <Stack gap={4}>
      <Group gap="sm" align="flex-end">
        <NumberInput
          label="Port"
          size="xs"
          w={110}
          min={1024}
          max={65535}
          hideControls
          allowDecimal={false}
          value={port}
          onChange={(value) => {
            if (typeof value === 'number') setPort(value);
          }}
        />
        <Button
          size="compact-md"
          disabled={disabled || (action === 'Change Port' && port === status.port)}
          loading={set.isPending}
          onClick={() => {
            set.mutate({ enabled: true, port });
          }}
        >
          {action}
        </Button>
      </Group>
      {set.isError ? (
        <Text size="xs" c="red">
          {set.error.message}
        </Text>
      ) : null}
      {status.portHolder === null ? null : (
        <Text size="xs" c="dimmed">
          {`Port ${String(status.port)} is in use by ${status.portHolder}.`}
        </Text>
      )}
    </Stack>
  );
}

function StopSharing() {
  const set = useSetSharing();
  return (
    <Stack gap={2} align="flex-end">
      <Button
        variant="default"
        loading={set.isPending}
        onClick={() => {
          set.mutate({ enabled: false });
        }}
      >
        Stop Sharing
      </Button>
      {set.isError ? (
        <Text size="xs" c="red">
          {set.error.message}
        </Text>
      ) : null}
    </Stack>
  );
}

function Checklist({ status }: { readonly status: SharingStatusDto }) {
  const shared = status.steps.find((s) => s.step === SharingStep.Shared);
  const beforeShare = status.steps.filter((s) => s.step !== SharingStep.Shared);
  const allOk = beforeShare.every((s) => s.status === SharingStepStatus.Ok);
  return (
    <Stack gap="md">
      <SettingsCard title="Set up" action={status.enabled ? <StopSharing /> : null}>
        {beforeShare.map((step) =>
          step.step === SharingStep.Certificate ? (
            <CertificateStep key={step.step} step={step} status={status} />
          ) : (
            <PlainStep key={step.step} step={step} status={status} />
          ),
        )}
      </SettingsCard>
      {shared === undefined ? null : (
        <SettingsCard title="Share on your tailnet">
          <Stack gap="xs" px="md" py="sm">
            <PortControl status={status} action="Share" disabled={!allOk} />
            {allOk ? null : (
              <Text size="xs" c="dimmed">
                Waits for the certificate.
              </Text>
            )}
          </Stack>
        </SettingsCard>
      )}
    </Stack>
  );
}

function ReadyView({ status }: { readonly status: SharingStatusDto }) {
  const certificate = status.steps.find((s) => s.step === SharingStep.Certificate);
  const connected = status.steps.find((s) => s.step === SharingStep.Installed);
  return (
    <Stack gap="md">
      <Group justify="space-between" align="center" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <Text ff="monospace" size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>
            {status.url}
          </Text>
          {status.url === null ? null : (
            <CopyButton value={status.url}>
              {({ copied, copy }) => (
                <Button size="compact-sm" variant="default" onClick={copy}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              )}
            </CopyButton>
          )}
        </Group>
        <StopSharing />
      </Group>
      <Accordion variant="contained" radius="md">
        <Accordion.Item value="checks">
          <Accordion.Control>Checks</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Text size="xs" c="dimmed">
                10db re-reads these every minute while sharing is on.
              </Text>
              <Text size="sm">
                {`Tailscale connected as ${status.login ?? 'you'}, untagged${
                  connected?.detail ? ` (${connected.detail})` : ''
                }`}
              </Text>
              <Text size="sm">
                {`Certificate issued${certificate?.detail ? `. ${certificate.detail}` : ''}`}
              </Text>
              <Text size="sm">{`Shared on port ${String(status.port)}, tailnet only`}</Text>
              <Text size="xs" c="dimmed">
                Not Funnel: nothing outside your tailnet can reach it.
              </Text>
              <PortControl status={status} action="Change Port" disabled={false} />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}

/** With no Tailscale to read, nothing is set up, whatever the daemon's state says. */
function StateBadge({ status }: { readonly status: SharingStatusDto }) {
  const state = status.steps.length === 0 ? SharingState.Off : status.state;
  return (
    <Badge variant="light" color={STATE_COLOR[state]}>
      {STATE_LABEL[state]}
    </Badge>
  );
}

/** Settings › Remote Access: Tailscale's steps read live, then Share and Stop Sharing. */
export function RemoteAccessSection() {
  const sharing = useSharingPolled();
  const status = sharing.data;
  return (
    <Stack gap="md">
      <SectionHeading
        title="Remote Access"
        action={status === undefined ? undefined : <StateBadge status={status} />}
      />
      <TailscaleLine />
      {status === undefined ? <Skeleton height={160} radius="md" /> : null}
      {sharing.isError ? (
        <Text size="sm" c="red">
          {sharing.error.message}
        </Text>
      ) : null}
      {status === undefined ? null : status.steps.length === 0 ? (
        <NeedsTailscale />
      ) : status.state === SharingState.Ready ? (
        // Keyed on the port so the field starts from the saved one.
        <ReadyView key={status.port} status={status} />
      ) : (
        <Checklist key={status.port} status={status} />
      )}
    </Stack>
  );
}

import {
  SharingState,
  SharingStep,
  SharingStepStatus,
  type SharingStatusDto,
  type SharingStepDto,
} from '@10db/contracts';
import { Accordion, Box, Button, CopyButton, Group, NumberInput, Stack, Text } from '@mantine/core';
import { IconCheck, IconCircle, IconClock, IconExternalLink, IconX } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { openWebLink } from '../../desktop/tauri';
import {
  useRequestCertificate,
  useSetSharing,
  useSharingPolled,
} from '../../daemon/sharing-queries';
import { EmptyState } from '../../shell/empty-state';
import { usePageGuide } from '../../shell/page-guide';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { SharingIcon } from '../../shell/sharing-indicator';
import { REMOTE_ACCESS_GUIDE, RemoteAccessGuide } from './remote-access-guide';
import { SettingsSectionKey } from './sections';
import { SettingsCard } from './setting-row';
import { SettingsPageHeader } from './settings-page';

const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';
const TAILSCALE_DNS_URL = 'https://login.tailscale.com/admin/dns';

/** With no Tailscale to read there is nothing to set up yet: the page teaches instead, and offers the download. */
function NeedsTailscale({ onGuide }: { readonly onGuide: () => void }) {
  return (
    <EmptyState
      icon={SharingIcon}
      title="Remote Access needs Tailscale"
      action={{
        label: 'Get Tailscale',
        icon: IconExternalLink,
        emphasis: 'filled',
        onClick: () => {
          openWebLink(TAILSCALE_DOWNLOAD_URL).catch(() => undefined);
        },
      }}
      extra={
        <Button variant="default" onClick={onGuide}>
          {REMOTE_ACCESS_GUIDE}
        </Button>
      }
    >
      A free private network between your own devices. Install it on this Mac and your phone, and
      10db finds it on its own.
    </EmptyState>
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
      <Box
        h="calc(var(--mantine-font-size-sm) * var(--mantine-line-height-sm))"
        style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}
      >
        <StepMark status={step.status} />
      </Box>
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
        {children === undefined ? null : <Box mt="xs">{children}</Box>}
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
    <SettingsCard>
      {beforeShare.map((step) =>
        step.step === SharingStep.Certificate ? (
          <CertificateStep key={step.step} step={step} status={status} />
        ) : (
          <PlainStep key={step.step} step={step} status={status} />
        ),
      )}
      {shared === undefined ? null : (
        <StepRow
          step={shared}
          title="Share on your tailnet"
          lines={[allOk ? null : 'Waits for the certificate.', shared.error]}
        >
          <PortControl status={status} action="Share" disabled={!allOk} />
        </StepRow>
      )}
    </SettingsCard>
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

/**
 * Settings › Remote Access: Tailscale's steps read live, then Share, and Stop Sharing in the header while it is on.
 * Whether it is shared is the frame's sharing icon's to say, so the page draws no state of its own.
 */
export function RemoteAccessSection() {
  const sharing = useSharingPolled();
  const status = sharing.data;
  const guide = usePageGuide(REMOTE_ACCESS_GUIDE);
  const missing = status?.steps.length === 0;
  return (
    <Stack gap="md">
      <SettingsPageHeader
        sectionKey={SettingsSectionKey.RemoteAccess}
        // While Tailscale is missing, the empty state offers the guide.
        {...(missing ? {} : { guide: guide.opener })}
        {...(status?.enabled === true ? { actions: <StopSharing /> } : {})}
      />
      {status === undefined && !sharing.isError ? (
        <PageLoading shape={PageLoadingShape.Cards} rows={1} label="Reading Tailscale" />
      ) : null}
      {sharing.isError ? (
        <Text size="sm" c="red">
          {sharing.error.message}
        </Text>
      ) : null}
      {status === undefined ? null : missing ? (
        <NeedsTailscale onGuide={guide.opener.onOpen} />
      ) : status.state === SharingState.Ready ? (
        // Keyed on the port so the field starts from the saved one.
        <ReadyView key={status.port} status={status} />
      ) : (
        <Checklist key={status.port} status={status} />
      )}
      <RemoteAccessGuide guide={guide} />
    </Stack>
  );
}

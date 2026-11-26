import { SharingState, SharingStep, SharingStepStatus } from '@10db/contracts';
import { Text, Tooltip } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useSharing } from '../daemon/sharing-queries';
import { SettingsSectionKey } from '../views/settings/sections';
import { useRailMode } from './rail-mode';

const STEP_NAME: Readonly<Record<SharingStep, string>> = {
  [SharingStep.Installed]: 'Tailscale',
  [SharingStep.Connected]: 'Tailscale connection',
  [SharingStep.Untagged]: 'tagged Mac',
  [SharingStep.Https]: 'HTTPS',
  [SharingStep.Certificate]: 'certificate',
  [SharingStep.Shared]: 'share',
};

/**
 * What the rail's foot says while this Mac is shared: "Shared on your tailnet", or "Sharing paused: <step>"
 * when a step that passed fails. Nothing while sharing is off. It links to Remote Access.
 */
export function SharingStatus() {
  const status = useSharing().data;
  const labels = useRailMode().labels;
  if (status === undefined) return null;
  let line: string;
  if (status.state === SharingState.Ready) line = 'Shared on your tailnet';
  else if (status.state === SharingState.Paused) {
    const broken = status.steps.find((s) => s.status !== SharingStepStatus.Ok);
    line = `Sharing paused: ${broken === undefined ? 'a step failed' : STEP_NAME[broken.step]}`;
  } else return null;
  const paused = status.state === SharingState.Paused;
  const dot = (
    <span
      aria-hidden
      style={{
        flex: 'none',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: paused ? 'var(--mantine-color-orange-6)' : 'var(--mantine-color-green-6)',
      }}
    />
  );
  return (
    <Tooltip label={line} position="right" disabled={labels}>
      <Link
        to="/settings/$section"
        params={{ section: SettingsSectionKey.RemoteAccess }}
        aria-label={line}
        style={{
          flex: labels ? '1 1 100%' : 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: labels ? 'flex-start' : 'center',
          gap: 8,
          padding: labels ? '4px 8px' : '0',
          width: labels ? undefined : 40,
          height: 28,
          color: 'inherit',
          textDecoration: 'none',
        }}
      >
        {dot}
        {labels ? (
          <Text size="xs" c="dimmed" truncate>
            {line}
          </Text>
        ) : null}
      </Link>
    </Tooltip>
  );
}

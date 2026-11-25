import type { AcceptanceChecking, ProjectId } from '@10db/contracts';
import { Anchor, Text } from '@mantine/core';
import { useNavigate } from '@tanstack/react-router';
import { useAcceptanceFigures } from '../../daemon/acceptance-queries';
import { FactoryMode } from '../factory/factory-view';

const PERIOD_DAYS = 7;

/** Why acceptance isn't checking, in the muted line under the counts. */
export function notCheckingLine(checking: AcceptanceChecking): string | null {
  if (checking.on) return null;
  return checking.reason === 'no_account'
    ? "Acceptance isn't checking: no account can answer decisions"
    : "Acceptance isn't checking: it's off in Settings";
}

/** The Board's acceptance counts for the last week; each number opens Factory's Metrics. */
export function AcceptanceLine({ projectId }: { readonly projectId: ProjectId }) {
  const navigate = useNavigate();
  const figures = useAcceptanceFigures(projectId, PERIOD_DAYS);
  if (!figures.isSuccess) return null;
  const { completed, sentBack, sentToYou, checking } = figures.data;
  const numbers: [string, number][] = [
    ['Completed', completed],
    ['Sent back', sentBack],
    ['Sent to you', sentToYou],
  ];
  const notChecking = notCheckingLine(checking);
  return (
    <>
      {numbers.map(([label, count], i) => (
        <span key={label}>
          {i === 0 ? '' : ' · '}
          {label}{' '}
          <Anchor
            component="button"
            type="button"
            onClick={() => {
              void navigate({
                to: '/factory',
                search: { view: FactoryMode.Metrics, project: projectId },
              });
            }}
            inherit
            aria-label={`${label} ${String(count)}`}
          >
            {count}
          </Anchor>
        </span>
      ))}
      <span>
        , last {PERIOD_DAYS} days{notChecking === null ? '' : '. '}
      </span>
      {notChecking === null ? null : (
        <Text component="span" inherit c="dimmed" opacity={0.8}>
          {notChecking}
        </Text>
      )}
    </>
  );
}

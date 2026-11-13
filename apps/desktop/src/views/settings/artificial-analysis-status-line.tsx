import type { BenchmarkStatusDto } from '@10db/contracts';
import { Anchor, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useBenchmarkStatus } from '../../daemon/benchmark-queries';
import { shortAgo } from '../factory/short-ago';
import { SettingsSectionKey } from './sections';

/** The card these links open, in Settings › Integrations. */
const CARD = 'artificial-analysis';

function sentence(status: BenchmarkStatusDto): { text: string; link: string | null } {
  if (status.off)
    return {
      text: 'Artificial Analysis is off: 10db was started with TENDB_BENCHMARKS=off',
      link: null,
    };
  if (!status.keyConfigured)
    return {
      text: 'No Artificial Analysis key: models are compared without scores',
      link: 'Add Key',
    };
  const synced = status.syncing
    ? 'syncing'
    : status.lastSuccessAt === null
      ? 'not synced yet'
      : `synced ${shortAgo(status.lastSuccessAt)}`;
  return { text: `Scores from Artificial Analysis · ${synced}`, link: 'Manage' };
}

/** Under the Models page's catalogue line: whether the scores come from a connected Artificial Analysis key. */
export function ArtificialAnalysisStatusLine() {
  const query = useBenchmarkStatus();
  if (query.data === undefined)
    return query.isError ? (
      <Text size="xs" c="dimmed">
        The Artificial Analysis status could not be read.
      </Text>
    ) : null;
  const { text, link } = sentence(query.data);
  return (
    <Text size="xs" c="dimmed">
      {text}
      {link === null ? null : (
        <>
          {' · '}
          <Anchor
            size="xs"
            underline="always"
            renderRoot={(props) => (
              <Link
                {...props}
                to="/settings/$section"
                params={{ section: SettingsSectionKey.Integrations }}
                search={{ focus: CARD }}
              />
            )}
          >
            {link}
          </Anchor>
        </>
      )}
    </Text>
  );
}

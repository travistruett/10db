import type { BenchmarkStatusDto } from '@10db/contracts';
import { Anchor, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useBenchmarkStatus } from '../../daemon/benchmark-queries';
import { fromNow } from '../../shell/relative';
import { SettingsSectionKey } from './sections';

/** The place in Settings › Decisions where the account decisions are paid by is chosen. */
const PAID_BY = 'paid-by';

const OFF_WORDS =
  "OpenRouter isn't read while 10db runs with TENDB_JUDGE=off or TENDB_BENCHMARKS=off.";

function sentence(status: BenchmarkStatusDto): { text: string; link: boolean } {
  const { openRouter } = status;
  if (openRouter.off) return { text: OFF_WORDS, link: false };
  switch (openRouter.outcome) {
    case 'ok': {
      const read =
        openRouter.lastSuccessAt === null ? '' : ` · read ${fromNow(openRouter.lastSuccessAt)}`;
      return {
        text: status.keyConfigured
          ? `Speed and more scores from OpenRouter${read}`
          : `Scores at max effort only, from Artificial Analysis through OpenRouter, and speed${read}`,
        link: false,
      };
    }
    case 'unauthorized':
      return {
        text: 'OpenRouter refused the key of the account decisions are paid by.',
        link: true,
      };
    case 'failed':
    case 'rate_limited':
      return { text: openRouter.message ?? 'OpenRouter could not be read.', link: false };
    case 'no_key':
    case null:
      return openRouter.keyConfigured
        ? { text: 'Reading OpenRouter…', link: false }
        : { text: 'Add an OpenRouter account for measured speed and more scores', link: true };
  }
}

/** Under the Artificial Analysis line: whether OpenRouter's speed and scores are being read, and what to do when not. */
export function OpenRouterStatusLine() {
  const query = useBenchmarkStatus();
  if (query.data === undefined) return null;
  const { text, link } = sentence(query.data);
  return (
    <Text size="xs" c="dimmed">
      {text}
      {link ? (
        <>
          {' · '}
          <Anchor
            size="xs"
            underline="always"
            renderRoot={(props) => (
              <Link
                {...props}
                to="/settings/$section"
                params={{ section: SettingsSectionKey.Decisions }}
                search={{ focus: PAID_BY }}
              />
            )}
          >
            Paid by
          </Anchor>
        </>
      ) : null}
    </Text>
  );
}

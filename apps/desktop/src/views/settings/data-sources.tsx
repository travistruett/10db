import { CatalogueAttempt } from '@10db/contracts';
import { Button, Popover, Stack, Text } from '@mantine/core';
import { IconDatabase } from '@tabler/icons-react';
import { useBenchmarkStatus } from '../../daemon/benchmark-queries';
import { useCatalogueStatus } from '../../daemon/model-queries';
import { useNow } from '../../shell/relative';
import { ArtificialAnalysisCredit } from './artificial-analysis-credit';
import { ArtificialAnalysisStatusLine } from './artificial-analysis-status-line';
import { catalogueLine } from './model-format';
import { OpenRouterStatusLine } from './openrouter-status-line';

/** Where the page's prices, scores and speed come from, behind one quiet button; each source's own status is in it. */
export function DataSources() {
  const now = useNow();
  const status = useCatalogueStatus();
  return (
    <Popover width={360} position="bottom-end" withArrow>
      <Popover.Target>
        <Button
          variant="subtle"
          color="gray"
          size="compact-xs"
          leftSection={<IconDatabase size={14} stroke={1.5} />}
        >
          Data Sources
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text size="xs" c="dimmed">
            {status.data !== undefined
              ? catalogueLine(status.data, now)
              : status.isError
                ? 'The catalogue status could not be read.'
                : 'Reading the catalogue…'}{' '}
            <ArtificialAnalysisCredit />
          </Text>
          <ArtificialAnalysisStatusLine />
          <OpenRouterStatusLine />
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/** One short line, only when a source needs attention: a failed catalogue fetch or a refused or failed score read. */
export function DataSourcesWarning() {
  const status = useCatalogueStatus();
  const benchmarks = useBenchmarkStatus();
  const outcomes = [benchmarks.data?.outcome, benchmarks.data?.openRouter.outcome];
  const bad = (outcome: string | null | undefined) =>
    outcome === 'unauthorized' || outcome === 'failed' || outcome === 'rate_limited';
  const warning =
    status.data?.lastAttempt === CatalogueAttempt.Failed
      ? 'Could not reach models.dev; prices may be out of date.'
      : outcomes.some(bad)
        ? 'A score source refused or failed its last read. See Data Sources.'
        : null;
  return warning === null ? null : (
    <Text size="xs" c="yellow" role="status">
      {warning}
    </Text>
  );
}

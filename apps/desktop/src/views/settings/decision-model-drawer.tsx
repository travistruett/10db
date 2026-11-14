import type { DecisionModelDto, JudgeDecision } from '@10db/contracts';
import { Drawer, Stack, Text } from '@mantine/core';
import { DECISIONS } from './decision-catalogue';
import { costText, timeText } from './decision-models-table';
import { formatDecisionUsd } from './decision-numbers';
import { ModelMeasuresPanel } from './model-measures-panel';
import { decisionSourceText } from './number-source';
import { SourcedNumber } from './sourced-number';

function Body({
  model,
  usedBy,
}: {
  readonly model: DecisionModelDto;
  readonly usedBy: readonly JudgeDecision[];
}) {
  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Text size="sm" c="dimmed">
          {model.maker} ·{' '}
          <Text span ff="monospace" inherit>
            {model.id}
          </Text>
        </Text>
        {model.cantCall === null ? null : (
          <Text size="sm" c="dimmed">
            {model.cantCall}
          </Text>
        )}
        <Text size="sm" c="dimmed">
          Price per 1M tokens: {formatDecisionUsd(model.inputUsdPerMillion)} in ·{' '}
          {formatDecisionUsd(model.outputUsdPerMillion)} out
        </Text>
        <Text size="sm">
          Cost per million decisions{' '}
          <SourcedNumber
            text={costText(model)}
            source={model.costSource === null ? null : decisionSourceText(model.costSource)}
          />
          {' · '}Time per decision{' '}
          <SourcedNumber
            text={timeText(model)}
            source={model.timeSource === null ? null : decisionSourceText(model.timeSource)}
          />
        </Text>
        <Text size="sm" c="dimmed">
          {usedBy.length === 0
            ? 'No decision uses it.'
            : `Used by ${usedBy.map((d) => DECISIONS[d].label).join(', ')}.`}
        </Text>
      </Stack>
      <ModelMeasuresPanel model={model.id} account={null} />
    </Stack>
  );
}

/** One decision model's price, what a decision on it costs and takes, who uses it and OpenRouter's rows for it. */
export function DecisionModelDrawer({
  model,
  usedBy,
  opened,
  onClose,
}: {
  readonly model: DecisionModelDto | null;
  readonly usedBy: readonly JudgeDecision[];
  readonly opened: boolean;
  readonly onClose: () => void;
}) {
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="md"
      title={model?.name ?? 'Decision model'}
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      {model === null ? null : <Body key={model.id} model={model} usedBy={usedBy} />}
    </Drawer>
  );
}

import {
  AreaRole,
  type AreaDef,
  type ProjectViewDto,
  type WorkbenchSetupAreas,
} from '@10db/contracts';
import { Button, Checkbox, Code, Collapse, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useId } from 'react';
import { CountBadge } from '../../../shell/count-badge';
import { areasSummary } from './setup-rules';

export interface AreasSectionProps {
  readonly project: ProjectViewDto;
  readonly areas: WorkbenchSetupAreas;
  /** The list Apply would save, with the unticked pages folded back. */
  readonly result: readonly AreaDef[];
  readonly unticked: readonly string[];
  readonly onTick: (page: string, ticked: boolean) => void;
}

/**
 * The setup's Areas: what the rebuild comes to in one line, each new page as a row the builder may
 * untick, the other areas behind Show, and what is kept or left out with why.
 */
export function AreasSection({ project, areas, result, unticked, onTick }: AreasSectionProps) {
  const [othersOpen, others] = useDisclosure(false);
  const othersId = useId();
  const rest = result.filter((a) => a.role !== AreaRole.Page);
  return (
    <Stack gap="sm" component="section" aria-labelledby={`${othersId}-title`}>
      <Title order={3} id={`${othersId}-title`}>
        Areas
      </Title>
      <Text size="sm">{areasSummary(project.areas, result)}</Text>
      {areas.pages.length === 0 ? null : (
        <Stack gap="xs">
          {areas.pages.map((page) => (
            <Checkbox
              key={page.name}
              checked={!unticked.includes(page.name)}
              onChange={(event) => {
                onTick(page.name, event.currentTarget.checked);
              }}
              label={
                <>
                  {`Make `}
                  <Code>{page.name}</Code>
                  {page.route === undefined
                    ? ' a page, which no single path shows'
                    : ` a page at ${page.route}`}
                </>
              }
              description={page.folders.join(', ')}
            />
          ))}
        </Stack>
      )}
      {areas.kept.length === 0 ? null : (
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Kept as they are
          </Text>
          {areas.kept.map((kept) => (
            <Text key={kept.name} size="sm" c="dimmed">
              <Code>{kept.name}</Code> {kept.reason}
            </Text>
          ))}
        </Stack>
      )}
      <div>
        <Button
          variant="subtle"
          size="compact-sm"
          px={0}
          aria-expanded={othersOpen}
          aria-controls={othersId}
          onClick={others.toggle}
          rightSection={othersOpen ? null : <CountBadge count={rest.length} />}
        >
          {othersOpen ? 'Hide Other Areas' : 'Show Other Areas'}
        </Button>
        <Collapse expanded={othersOpen} id={othersId}>
          <Stack gap={4} pt="xs">
            {rest.map((area) => (
              <Text key={area.name} size="sm" style={{ overflowWrap: 'anywhere' }}>
                <Code>{area.name}</Code>
                {area.role === AreaRole.Shared ? ' shared' : ''}
                {area.catchAll === true ? ' catch-all' : ''}: {area.globs.join(' ')}
              </Text>
            ))}
          </Stack>
        </Collapse>
      </div>
      {areas.skipped.length === 0 ? null : (
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Left out
          </Text>
          {areas.skipped.map((skip) => (
            <Text key={`${skip.name}:${skip.reason}`} size="sm" c="dimmed">
              {`${skip.name}: ${skip.reason}`}
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

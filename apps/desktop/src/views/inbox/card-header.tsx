import type { InboxItemDto } from '@10db/contracts';
import { Group, Text } from '@mantine/core';
import type { Icon } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { ProjectLabel } from '../../shell/project-label';
import { absoluteTime, fromNow } from '../../shell/relative';
import classes from './card-header.module.css';

/**
 * A card's head: its title on a line of its own, then one dim line saying what it is, whose, how many and how
 * long ago. Where the card stands alone (`framed`) the title is a row title's size, in the Inbox's content a
 * pane's.
 */
export function CardHeader({
  item,
  icon: KindIcon,
  kind,
  count = 1,
  framed,
  extra = null,
}: {
  readonly item: Pick<InboxItemDto, 'title' | 'projectId' | 'createdAt'>;
  readonly icon: Icon;
  /** What the card is, in words. */
  readonly kind: string;
  /** How many identical cards the row stands for. */
  readonly count?: number;
  readonly framed: boolean;
  /** Marks that follow on the meta line, such as a principle's kind or the session that asked. */
  readonly extra?: ReactNode;
}) {
  return (
    <div className={classes['head']}>
      <Text
        className={classes['title']}
        fz={framed ? 14 : 16}
        fw={600}
        c="var(--mantine-color-bright)"
      >
        {item.title}
      </Text>
      <Group gap={8} wrap="wrap" className={classes['meta']}>
        <span className={classes['kind']}>
          <KindIcon size={14} stroke={1.75} className={classes['icon']} aria-hidden />
          {kind}
        </span>
        <span className={classes['dot']} aria-hidden />
        <ProjectLabel projectId={item.projectId} />
        {count > 1 ? (
          <>
            <span className={classes['dot']} aria-hidden />
            <span>{`${String(count)} identical`}</span>
          </>
        ) : null}
        <span className={classes['dot']} aria-hidden />
        <span title={absoluteTime(item.createdAt)}>{fromNow(item.createdAt)}</span>
        {extra}
      </Group>
    </div>
  );
}

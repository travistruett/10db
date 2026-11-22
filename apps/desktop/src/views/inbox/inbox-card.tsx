import {
  ACCOUNT_CARD_DETAIL,
  CARD_CLOSES_ITSELF,
  OPEN_INTEGRATIONS_DETAIL,
  AccountCardDetail,
  AccountProblem,
  InboxKind,
  isParkChoice,
  type DecisionRecording,
  type InboxItemDto,
} from '@10db/contracts';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  Kbd,
  Radio,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { z } from 'zod';
import { CodeSpans } from '../../shell/code-spans';
import { ExternalLink } from '../board/pull-request-link';
import { BatchCardActions } from './batch-card-actions';
import { CardOpensLink, cardOpens } from './card-opens-link';
import { CheckCard } from './check-card';
import { PlanCard } from './plan-card';
import { ReviewRejection, reviewRejection } from '../review/review-rejection';
import { McpApprovalDetails, mcpReview } from './mcp-approval';
import { CardActions } from './card-actions';
import { CardHeader } from './card-header';
import { CardSurface } from './card-surface';
import classes from './inbox-card.module.css';
import { KIND_ICONS } from './kind-icons';
import { KIND_LABELS, optionLabel } from './permission-labels';
import { usePrincipleOf } from './principle-card';
import { RecordDecision } from './record-decision';
import { PRINCIPLE_KIND_LABELS } from '../knowledge/knowledge-labels';
import { SettingsSectionKey } from '../settings/sections';
import { usePeople } from '../../daemon/people';
import { OpenTaskLink } from '../sessions/open-task-link';
import {
  OpenSessionLink,
  SessionBadge,
  useSessionOfCard,
  useTaskOfCard,
} from './session-card-link';
import { SlackPreview } from './slack-preview';
import {
  AskSomeoneFooter,
  ComposedMessage,
  RouteLineRow,
  SendInsteadLink,
  SentNotice,
} from './stakeholder-extras';
import { copyPeople, joinNames, StakeholderMode, stakeholderMode } from './route-line';

export interface InboxCardProps {
  readonly item: InboxItemDto;
  /** How many identical flags the row stands for; 1 for any other card. */
  readonly count: number;
  readonly selected: boolean;
  readonly choice: string | null;
  readonly note: string;
  /** How a question's answer is recorded as a decision; null records nothing. Used on the open card only. */
  readonly recording: DecisionRecording | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly noteRef: RefObject<HTMLTextAreaElement | null>;
  readonly onChoose: (choice: string) => void;
  readonly onNote: (note: string) => void;
  readonly onRecord: (recording: DecisionRecording | null) => void;
  /** What the builder typed for sending a check card back; kept while another card is open. */
  readonly sendBackNote: string;
  readonly onSendBackNote: (note: string) => void;
  /** A check or plan card found it was answered elsewhere. */
  readonly onAnsweredElsewhere?: () => void;
  readonly onNoteFocus: () => void;
  readonly onSubmit: () => void;
  /** Dismisses the row's flags; only offered for a flag with no options. */
  readonly onDismiss: () => void;
  /** Whether the card draws its own border; false in the Inbox's content area, which frames it. */
  readonly framed?: boolean;
  /** What the Inbox adds under the card's body, such as a question's last messages. */
  readonly context?: ReactNode;
  /** Whether the Inbox's keys answer the card, so each option shows its digit and Send its Enter. */
  readonly shortcuts?: boolean;
  /** Whether the builder chose Answer Myself on a drafted question, which swaps the preview for the options. */
  readonly answeringMyself?: boolean;
  readonly onAnswerMyself?: (value: boolean) => void;
}

/** Card text is untrusted (agent and tool output): it is only ever rendered as text. */
export function CardBody({ item }: { readonly item: InboxItemDto }) {
  if (item.body === '') return null;
  if (item.kind === InboxKind.Permission) {
    return (
      <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {item.body}
      </Code>
    );
  }
  return (
    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
      <CodeSpans text={item.body} />
    </Text>
  );
}

/** The pages the desktop app's opener may open, as its capability (`opener:allow-open-url`) says. */
const GITHUB_PAGE = 'https://github.com/';

/**
 * The page a flag card offers to open (`detail.link`, such as a failing check): a github.com page
 * only. The daemon's text is not trusted to be a link, and the desktop app opens nothing else, so a
 * check elsewhere (a third-party CI) gets no button; the card's body holds its address regardless.
 */
/** Whether the card says an account has no model 10db may run, which is fixed under Settings › Accounts. */
function needsAccountModels(item: InboxItemDto): boolean {
  const card = AccountCardDetail.safeParse(item.detail?.[ACCOUNT_CARD_DETAIL]);
  return card.success && card.data.problem === AccountProblem.NoUsableModel;
}

/** The Integrations card a flag card sends the builder to (`detail.openIntegrations`), or null. */
function integrationsFocusOf(item: InboxItemDto): string | null {
  const focus = z.string().min(1).safeParse(item.detail?.[OPEN_INTEGRATIONS_DETAIL]);
  return focus.success ? focus.data : null;
}

function cardLink(item: InboxItemDto): string | null {
  if (item.kind !== InboxKind.Flag) return null;
  const link = item.detail?.['link'];
  return typeof link === 'string' && link.startsWith(GITHUB_PAGE) ? link : null;
}

// Destructured: reading `props.x` in render, with a ref among the props, trips react-hooks/refs.
export function InboxCard({
  item,
  count,
  selected,
  choice,
  note,
  recording,
  error,
  pending,
  noteRef,
  onChoose,
  onNote,
  onRecord,
  sendBackNote,
  onSendBackNote,
  onAnsweredElsewhere,
  onNoteFocus,
  onSubmit,
  onDismiss,
  framed = true,
  context = null,
  shortcuts = true,
  answeringMyself = false,
  onAnswerMyself = () => undefined,
}: InboxCardProps) {
  const people = usePeople().data ?? [];
  const mode = stakeholderMode(item, people);
  const review = mcpReview(item);
  const rejection = reviewRejection(item);
  const principle = usePrincipleOf(item, selected);
  const session = useSessionOfCard(item);
  const taskOfCard = useTaskOfCard(item);
  const kind = review ? 'MCP server' : KIND_LABELS[item.kind];
  const header = (extra: ReactNode = null) => (
    <CardHeader
      item={item}
      icon={KIND_ICONS[item.kind]}
      kind={kind}
      count={count}
      framed={framed}
      extra={extra}
    />
  );

  if (item.kind === InboxKind.Plan) {
    return (
      <PlanCard
        item={item}
        framed={framed}
        note={sendBackNote}
        onNote={onSendBackNote}
        {...(onAnsweredElsewhere === undefined ? {} : { onAnsweredElsewhere })}
        header={header()}
      />
    );
  }

  if (item.kind === InboxKind.Check) {
    return (
      <CheckCard
        item={item}
        framed={framed}
        note={sendBackNote}
        onNote={onSendBackNote}
        {...(onAnsweredElsewhere === undefined ? {} : { onAnsweredElsewhere })}
        header={header()}
      />
    );
  }

  if (
    (mode === StakeholderMode.Draft || mode === StakeholderMode.Failed) &&
    item.send !== null &&
    !answeringMyself
  ) {
    return (
      <SlackPreview
        item={item}
        framed={framed}
        send={item.send}
        people={people}
        onAnswerMyself={() => {
          onAnswerMyself(true);
        }}
        header={header()}
      />
    );
  }

  const sendFromNote = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit();
    }
  };
  const hasOptions = item.options.length > 0;
  const link = cardLink(item);
  const opens = cardOpens(item);
  // A card that closes itself when its cause clears is never dismissed, so with no answer to send it has no button.
  const closesItself = item.detail?.[CARD_CLOSES_ITSELF] === true;
  // Parking the task stops the run and records nothing, so the control goes while that is chosen.
  const recordable =
    item.kind === InboxKind.Question && hasOptions && !(choice !== null && isParkChoice(choice));

  return (
    <CardSurface framed={framed} selected>
      <Stack gap={framed ? 'sm' : 'md'} className={framed ? undefined : classes['content']}>
        {header(
          <>
            {principle ? (
              <Badge size="xs" variant="outline" style={{ flexShrink: 0 }}>
                {PRINCIPLE_KIND_LABELS[principle.kind]}
              </Badge>
            ) : null}
            {session === null ? null : <SessionBadge chat={session} />}
          </>,
        )}
        {session === null ? null : <OpenSessionLink chat={session} />}
        {taskOfCard === null ? null : (
          <OpenTaskLink taskId={taskOfCard} projectId={item.projectId} />
        )}
        {review ? (
          <McpApprovalDetails review={review} body={item.body} />
        ) : (
          <CardBody item={item} />
        )}
        {context}
        {rejection ? <ReviewRejection review={rejection} /> : null}
        {link === null ? null : <ExternalLink url={link} label="Open on GitHub" />}
        {needsAccountModels(item) ? (
          // The account's drawer has no route of its own, so this opens the section that lists its accounts.
          <Anchor
            size="sm"
            renderRoot={(props) => (
              <Link
                {...props}
                to="/settings/$section"
                params={{ section: SettingsSectionKey.Accounts }}
              />
            )}
          >
            Open Accounts in Settings
          </Anchor>
        ) : null}
        {integrationsFocusOf(item) === null ? null : (
          <Anchor
            size="sm"
            renderRoot={(props) => (
              <Link
                {...props}
                to="/settings/$section"
                params={{ section: SettingsSectionKey.SignIns }}
                search={{ focus: integrationsFocusOf(item) ?? undefined }}
              />
            )}
          >
            Open Sign-ins
          </Anchor>
        )}
        {opens === null ? null : <CardOpensLink opens={opens} />}
        <RouteLineRow item={item} people={people} mode={mode} />
        <SentNotice item={item} />
        {mode === StakeholderMode.Copy ? (
          <ComposedMessage item={item} recipients={copyPeople(item, people)} />
        ) : null}
        {answeringMyself && item.send !== null ? (
          <SendInsteadLink
            names={joinNames(item.send.people.filter((p) => p.recipient).map((p) => p.name))}
            onClick={() => {
              onAnswerMyself(false);
            }}
          />
        ) : null}
        <BatchCardActions item={item} onDone={onDismiss} />
        {hasOptions ? (
          <Radio.Group value={choice} onChange={onChoose} aria-label="Answer">
            <Stack gap="xs">
              {item.options.map((option, index) => (
                <Radio.Card key={option.label} value={option.label} p="sm">
                  <Group wrap="nowrap" align="flex-start">
                    <Radio.Indicator />
                    {shortcuts && index < 4 ? <Kbd size="xs">{index + 1}</Kbd> : null}
                    <div>
                      <Group gap="xs">
                        <Text size="sm" fw={500}>
                          {optionLabel(item, option, principle?.area ?? null)}
                        </Text>
                        {item.recommendation === option.label ? (
                          <Badge size="xs" variant="outline">
                            Recommended
                          </Badge>
                        ) : null}
                      </Group>
                      {option.description ? (
                        <Text size="xs" c="dimmed">
                          {option.description}
                        </Text>
                      ) : null}
                    </div>
                  </Group>
                </Radio.Card>
              ))}
            </Stack>
          </Radio.Group>
        ) : null}
        {recordable ? <RecordDecision item={item} value={recording} onChange={onRecord} /> : null}
        {hasOptions ? (
          <Textarea
            ref={noteRef}
            label="Note"
            placeholder="Optional. Sent with your answer."
            autosize
            minRows={2}
            value={note}
            onChange={(e) => {
              onNote(e.currentTarget.value);
            }}
            onFocus={onNoteFocus}
            onKeyDown={sendFromNote}
          />
        ) : null}
        {error ? (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        ) : null}
      </Stack>
      <CardActions framed={framed}>
        {(mode === StakeholderMode.Unrouted || mode === StakeholderMode.Pending) && hasOptions ? (
          <AskSomeoneFooter item={item} people={people} />
        ) : null}
        {hasOptions || !closesItself ? (
          <Button
            size="sm"
            loading={pending}
            onClick={onSubmit}
            rightSection={
              shortcuts ? (
                <Kbd size="xs" aria-hidden>
                  ↵
                </Kbd>
              ) : null
            }
          >
            {hasOptions ? 'Send Answer' : count > 1 ? 'Dismiss All' : 'Dismiss'}
          </Button>
        ) : null}
      </CardActions>
    </CardSurface>
  );
}

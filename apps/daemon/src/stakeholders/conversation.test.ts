import type { SlackMessage, SlackReaction } from '../slack';
import { describe, expect, it } from 'vitest';
import { conversationState, mentionsToAdd, newMessages } from './index';

const BOT = 'UBOT';
const MARK = 'UMARK';
const ANA = 'UANA';
const PRIYA = 'UPRIYA';
const BASE = 1731300000;
/** A Slack ts `seconds` after the question. */
const at = (seconds: number) => `${String(BASE + seconds)}.000100`;

function msg(
  seconds: number,
  user: string | null,
  text: string,
  over: Partial<SlackMessage> = {},
): SlackMessage {
  return {
    ts: at(seconds),
    threadTs: at(0),
    user,
    botId: null,
    subtype: null,
    text,
    edited: false,
    reactions: [],
    metadata: null,
    ...over,
  };
}

const tick = (seconds: number) => new Date((BASE + seconds) * 1000);
const minutes = (count: number) => tick(count * 60);

const proposal = (reactions: SlackReaction[] = [], letter = 'B') => ({
  ts: at(100),
  letter,
  reactions,
});
const check = (...users: string[]): SlackReaction => ({ name: 'white_check_mark', users });

type Input = Parameters<typeof conversationState>[0];

function state(over: Partial<Input>) {
  return conversationState({
    messages: [],
    recipients: [MARK],
    participants: [MARK],
    botUserId: BOT,
    quietSince: null,
    now: tick(10),
    proposal: null,
    settledThroughTs: null,
    askedWhichWay: null,
    approvalSeen: null,
    ...over,
  });
}

describe('newMessages', () => {
  const base = { participants: [MARK, ANA], botUserId: BOT, afterTs: at(0) };

  it('keeps a participant, with the author, in order', () => {
    const messages = [msg(20, ANA, 'later'), msg(10, MARK, 'first')];
    expect(newMessages({ ...base, messages })).toEqual([
      { ts: at(10), userId: MARK, text: 'first' },
      { ts: at(20), userId: ANA, text: 'later' },
    ]);
  });

  it.each([
    ['a non-participant', msg(10, PRIYA, 'hi')],
    ["the bot's own message", msg(10, BOT, 'Q')],
    ['a bot message', msg(10, null, 'hi', { botId: 'B1', subtype: 'bot_message' })],
    ['a message with a bot id and a user', msg(10, MARK, 'hi', { botId: 'B1' })],
    ['a message with no author', msg(10, null, 'hi')],
    ['an edit event', msg(10, MARK, 'hi', { subtype: 'message_changed' })],
    ['a deletion event', msg(10, MARK, 'hi', { subtype: 'message_deleted' })],
    ['a message at the cursor', msg(0, MARK, 'hi')],
    ['a message before the cursor', msg(-5, MARK, 'hi')],
  ])('drops %s', (_name, message) => {
    expect(newMessages({ ...base, messages: [message] })).toEqual([]);
  });

  it('keeps a message that was edited, with its latest text', () => {
    const edited = msg(10, MARK, 'B, fixed', { edited: true });
    expect(newMessages({ ...base, messages: [edited] })).toHaveLength(1);
  });

  it('compares timestamps as numbers, not text', () => {
    const early = msg(5, MARK, 'a', { ts: '999999999.000100' });
    expect(newMessages({ ...base, afterTs: '1000000000.000000', messages: [early] })).toEqual([]);
  });
});

describe('mentionsToAdd', () => {
  const participants = [MARK, ANA];

  it.each([
    ['a new person', [msg(10, MARK, 'can you add <@UPRIYA>?')], [PRIYA]],
    ['a mention with a label', [msg(10, MARK, 'cc <@UPRIYA|priya>')], [PRIYA]],
    ['the bot', [msg(10, MARK, '<@UBOT> thanks')], []],
    ['a participant', [msg(10, MARK, 'ask <@UANA>')], []],
    ['a mention by a non-participant', [msg(10, PRIYA, 'bring in <@USAM>')], []],
    ['a mention by the bot', [msg(10, BOT, 'hello <@USAM>')], []],
    ['no mention', [msg(10, MARK, 'plain')], []],
    [
      'two people and a repeat, in order',
      [msg(10, MARK, '<@UPRIYA> and <@USAM>'), msg(20, ANA, 'yes <@UPRIYA>')],
      [PRIYA, 'USAM'],
    ],
    ['a channel mention is not a person', [msg(10, MARK, '<!channel> and <#C123|general>')], []],
  ])('%s', (_name, messages, expected) => {
    expect(mentionsToAdd(messages, participants, BOT)).toEqual(expected);
  });
});

describe('conversationState: one recipient who alone replies', () => {
  it('waits on the first tick that sees the reply', () => {
    expect(state({ messages: [msg(10, MARK, 'B')], quietSince: null })).toEqual({
      kind: 'waiting',
    });
  });

  it('is a lone reply on a quiet second tick', () => {
    expect(state({ messages: [msg(10, MARK, 'B')], quietSince: at(10) })).toEqual({
      kind: 'lone_reply',
      words: 'B',
      messageCount: 1,
      lastTs: at(10),
    });
  });

  it('waits another tick when more arrived since the last one', () => {
    const messages = [msg(10, MARK, 'B'), msg(20, MARK, 'wait, C')];
    expect(state({ messages, quietSince: at(10) })).toEqual({ kind: 'waiting' });
  });

  it('joins what the person wrote, in order, once quiet', () => {
    const messages = [msg(20, MARK, 'wait, C'), msg(10, MARK, 'B')];
    expect(state({ messages, quietSince: at(20) })).toEqual({
      kind: 'lone_reply',
      words: 'B\nwait, C',
      messageCount: 2,
      lastTs: at(20),
    });
  });

  it('ignores the bot and non-participants when working out who spoke', () => {
    const messages = [msg(5, BOT, 'Q'), msg(6, PRIYA, 'not in this'), msg(10, MARK, 'B')];
    expect(state({ messages, quietSince: at(10) }).kind).toBe('lone_reply');
  });

  it('a group where nobody else spoke still gives a lone reply', () => {
    expect(
      state({ messages: [msg(10, MARK, 'B')], participants: [MARK, PRIYA], quietSince: at(10) })
        .kind,
    ).toBe('lone_reply');
  });

  it('with no message at all waits', () => {
    expect(state({ quietSince: at(10) })).toEqual({ kind: 'waiting' });
  });
});

describe('conversationState: others in the conversation settle', () => {
  const two = { participants: [MARK, PRIYA] };

  it("Priya's message makes it settle-only, never a lone reply", () => {
    const messages = [msg(10, MARK, 'hmm'), msg(20, PRIYA, 'I think we should wait')];
    expect(state({ ...two, messages, quietSince: at(20), now: minutes(5) })).toEqual({
      kind: 'waiting',
    });
  });

  it('a message naming a letter and then a quiet tick settles', () => {
    const messages = [
      msg(10, MARK, 'hmm'),
      msg(20, PRIYA, 'B is the only option legal will sign off on'),
    ];
    expect(state({ ...two, messages, quietSince: at(20), now: minutes(5) })).toEqual({
      kind: 'settled',
    });
  });

  it('a letter that was only just written waits for its quiet tick', () => {
    const messages = [msg(10, MARK, 'hmm'), msg(20, PRIYA, 'B')];
    expect(state({ ...two, messages, quietSince: at(10), now: minutes(5) }).kind).toBe('waiting');
    expect(state({ ...two, messages, quietSince: null, now: minutes(5) }).kind).toBe('waiting');
  });

  it('a letter inside a sentence about something else does not settle it', () => {
    const messages = [msg(10, MARK, 'hmm'), msg(20, PRIYA, 'Is a customer on a plan affected?')];
    expect(state({ ...two, messages, quietSince: at(20), now: minutes(5) }).kind).toBe('waiting');
  });

  it('names an option written as "option B"', () => {
    const messages = [msg(10, MARK, 'hmm'), msg(20, PRIYA, 'I prefer option B here')];
    expect(state({ ...two, messages, quietSince: at(20), now: minutes(5) }).kind).toBe('settled');
  });

  it.each([
    ['29 minutes quiet waits', 29, 'waiting'],
    ['30 minutes quiet settles', 30, 'settled'],
    ['31 minutes quiet settles', 31, 'settled'],
  ])('%s', (_name, quiet, kind) => {
    const messages = [msg(10, MARK, 'hmm'), msg(20, PRIYA, 'no idea yet')];
    const now = new Date(tick(20).getTime() + quiet * 60_000);
    expect(state({ ...two, messages, quietSince: null, now }).kind).toBe(kind);
  });

  it('never settles again for messages at or before settledThroughTs', () => {
    const messages = [msg(10, MARK, 'hmm'), msg(20, PRIYA, 'B')];
    expect(
      state({
        ...two,
        messages,
        quietSince: at(20),
        now: minutes(120),
        settledThroughTs: at(20),
      }),
    ).toEqual({ kind: 'waiting' });
  });

  it('settles again on a message after settledThroughTs', () => {
    const messages = [msg(10, MARK, 'hmm'), msg(20, PRIYA, 'B'), msg(300, MARK, 'C then')];
    expect(
      state({ ...two, messages, quietSince: at(300), now: minutes(10), settledThroughTs: at(20) }),
    ).toEqual({ kind: 'settled' });
  });

  it('the thirty minutes run from the newest message after settledThroughTs', () => {
    const messages = [msg(10, PRIYA, 'B'), msg(300, PRIYA, 'chatter')];
    const now = new Date(tick(300).getTime() + 29 * 60_000);
    expect(state({ ...two, messages, settledThroughTs: at(10), now }).kind).toBe('waiting');
  });
});

describe('conversationState: after a which-way line', () => {
  const asked = { at: tick(100), ts: at(100) };
  const both = { participants: [MARK, PRIYA], askedWhichWay: asked, settledThroughTs: at(90) };

  it('a lone recipient own reply is a lone reply after a quiet tick, with only their words', () => {
    const messages = [
      msg(80, PRIYA, 'B is right'),
      msg(150, MARK, 'Go with B'),
      msg(160, PRIYA, 'agreed'),
    ];
    expect(state({ ...both, messages, quietSince: at(160) })).toEqual({
      kind: 'lone_reply',
      words: 'Go with B',
      messageCount: 1,
      lastTs: at(150),
    });
  });

  it('waits for the quiet tick', () => {
    expect(
      state({ ...both, messages: [msg(150, MARK, 'Go with B')], quietSince: at(100) }),
    ).toEqual({ kind: 'waiting' });
  });

  it('a quiet conversation after the line posts nothing more', () => {
    const messages = [msg(80, PRIYA, 'B is right')];
    expect(state({ ...both, messages, quietSince: at(80), now: minutes(300) })).toEqual({
      kind: 'waiting',
    });
  });

  it('a message from someone else after the line settles on its own rules', () => {
    const messages = [msg(80, PRIYA, 'B is right'), msg(150, PRIYA, 'B really')];
    expect(state({ ...both, messages, quietSince: at(150) }).kind).toBe('settled');
  });

  it('with several recipients it reads as an ordinary conversation', () => {
    const messages = [msg(150, MARK, 'hmm')];
    expect(
      state({
        ...both,
        recipients: [MARK, ANA],
        participants: [MARK, ANA],
        messages,
        quietSince: at(150),
        now: minutes(5),
      }).kind,
    ).toBe('waiting');
  });
});

describe('conversationState: a proposal is open', () => {
  const base = { participants: [MARK, PRIYA], settledThroughTs: at(90) };
  const withProposal = (over: Partial<Input>) =>
    state({ ...base, proposal: proposal([check(BOT)]), ...over });

  it("the bot's own ✅ alone is waiting", () => {
    expect(withProposal({})).toEqual({ kind: 'waiting' });
  });

  it("Mark's ✅ is approval seen, with the bot's ✅ beside it ignored", () => {
    expect(withProposal({ proposal: proposal([check(BOT, MARK)]) })).toEqual({
      kind: 'approval_seen',
      by: MARK,
    });
  });

  it.each([['white_check_mark'], ['heavy_check_mark'], ['+1'], ['+1::skin-tone-3']])(
    'a %s reaction approves',
    (name) => {
      const reactions: SlackReaction[] = [{ name, users: [MARK] }];
      expect(withProposal({ proposal: proposal(reactions) }).kind).toBe('approval_seen');
    },
  );

  it.each([['eyes'], ['x'], ['thumbsdown']])('a %s reaction approves nothing', (name) => {
    expect(withProposal({ proposal: proposal([{ name, users: [MARK] }]) }).kind).toBe('waiting');
  });

  it("Priya's ✅ does not approve", () => {
    expect(withProposal({ proposal: proposal([check(BOT, PRIYA)]) })).toEqual({
      kind: 'waiting',
    });
  });

  it.each([['Yes.'], ['yes'], ['  Approved! '], ['OK'], ['👍'], ['👍🏽'], ['Ok.'], ['approve']])(
    "Mark's %j approves",
    (words) => {
      expect(withProposal({ messages: [msg(110, MARK, words)] })).toEqual({
        kind: 'approval_seen',
        by: MARK,
      });
    },
  );

  it.each([['yes but'], ['not yet'], ['hmm'], ['I would rather wait']])(
    "Mark's %j withdraws the proposal",
    (words) => {
      expect(withProposal({ messages: [msg(110, MARK, words)] })).toEqual({ kind: 'withdrawn' });
    },
  );

  it.each([['Yes sir'], ['sounds good'], ['Go ahead'], ['yep'], ['Sure, thanks']])(
    'the fallback list reads %j as an approval',
    (words) => {
      expect(withProposal({ messages: [msg(110, MARK, words)] }).kind).toBe('approval_seen');
    },
  );

  it("the judge's read of a reply wins over the fallback list", () => {
    const messages = [msg(110, MARK, 'Yes sir')];
    expect(withProposal({ messages, judgedApprovals: new Map([[at(110), true]]) }).kind).toBe(
      'approval_seen',
    );
    expect(withProposal({ messages, judgedApprovals: new Map([[at(110), false]]) }).kind).toBe(
      'withdrawn',
    );
    const odd = [msg(110, MARK, 'make it so')];
    expect(withProposal({ messages: odd, judgedApprovals: new Map([[at(110), true]]) }).kind).toBe(
      'approval_seen',
    );
  });

  it('a recipient letter is a pick, even beside a proposal for another', () => {
    expect(withProposal({ messages: [msg(110, MARK, 'C')] })).toEqual({
      kind: 'picked',
      by: MARK,
      choice: 'C',
    });
  });

  it("Priya's reply withdraws the proposal", () => {
    expect(withProposal({ messages: [msg(110, PRIYA, 'wait, what about legal?')] })).toEqual({
      kind: 'withdrawn',
    });
  });

  it('Priya writing before Mark said yes does not block it', () => {
    const messages = [msg(105, PRIYA, 'sounds right to me'), msg(110, MARK, 'yes')];
    expect(withProposal({ messages }).kind).toBe('approval_seen');
  });

  it('Priya writing after Mark said yes withdraws it', () => {
    const messages = [msg(110, MARK, 'yes'), msg(115, PRIYA, 'hold on')];
    expect(withProposal({ messages }).kind).toBe('withdrawn');
  });

  it("Mark's ✅ with Priya writing after the proposal withdraws it", () => {
    const messages = [msg(110, PRIYA, 'one more thing')];
    expect(withProposal({ proposal: proposal([check(BOT, MARK)]), messages }).kind).toBe(
      'withdrawn',
    );
  });

  it("Mark's letter is a pick even when Priya wrote after the proposal", () => {
    const messages = [msg(105, PRIYA, 'ok'), msg(110, MARK, 'C')];
    expect(withProposal({ messages }).kind).toBe('picked');
  });

  it('messages before the proposal are not read against it', () => {
    expect(withProposal({ messages: [msg(50, MARK, 'hmm'), msg(60, PRIYA, 'B')] })).toEqual({
      kind: 'waiting',
    });
  });
});

describe('conversationState: an approval already seen', () => {
  const base = {
    participants: [MARK, PRIYA],
    settledThroughTs: at(90),
    approvalSeen: { at: at(120), by: MARK },
  };
  const seen = (over: Partial<Input>) =>
    state({ ...base, proposal: proposal([check(BOT, MARK)]), ...over });

  it('confirms an approval that still stands', () => {
    expect(seen({})).toEqual({ kind: 'approved', by: MARK });
  });

  it('confirms a message approval that still stands', () => {
    const messages = [msg(110, MARK, 'yes')];
    expect(seen({ proposal: proposal([check(BOT)]), messages })).toEqual({
      kind: 'approved',
      by: MARK,
    });
  });

  it('a ✅ removed in between is approval lost, with the proposal kept', () => {
    expect(seen({ proposal: proposal([check(BOT)]) })).toEqual({ kind: 'approval_lost' });
  });

  it('a ✅ added again on a later tick is approval seen again', () => {
    expect(
      state({ ...base, approvalSeen: null, proposal: proposal([check(BOT, MARK)]) }).kind,
    ).toBe('approval_seen');
  });

  it("Priya writing during the wait does not block Mark's approval", () => {
    expect(seen({ messages: [msg(130, PRIYA, 'fine by me')] })).toEqual({
      kind: 'approved',
      by: MARK,
    });
  });

  it('the approver writing a letter is a pick', () => {
    expect(seen({ messages: [msg(130, MARK, 'C')] })).toEqual({
      kind: 'picked',
      by: MARK,
      choice: 'C',
    });
  });

  it('the approver approving again stays approved', () => {
    expect(seen({ messages: [msg(130, MARK, 'yes please')] })).toEqual({
      kind: 'approved',
      by: MARK,
    });
  });

  it('the approver writing anything else clears the approval and withdraws the proposal', () => {
    expect(seen({ messages: [msg(130, MARK, 'hmm, one thing')] })).toEqual({ kind: 'withdrawn' });
    expect(seen({ messages: [msg(130, MARK, 'actually C then')] })).toEqual({ kind: 'withdrawn' });
  });

  it('messages before the approval was seen are not counted against it', () => {
    expect(seen({ messages: [msg(110, MARK, 'hmm'), msg(115, MARK, 'yes')] }).kind).toBe(
      'approved',
    );
  });
});

describe('conversationState: several recipients', () => {
  const group = { recipients: [MARK, ANA], participants: [MARK, ANA] };

  describe('with a proposal open', () => {
    const open = (over: Partial<Input>) =>
      state({ ...group, settledThroughTs: at(90), proposal: proposal([check(BOT)]), ...over });

    it("Ana's ✅ approves as Ana", () => {
      expect(open({ proposal: proposal([check(BOT, ANA)]) })).toEqual({
        kind: 'approval_seen',
        by: ANA,
      });
    });

    it('two ✅ in one tick credit the first in routing order, whoever clicked first', () => {
      expect(open({ proposal: proposal([check(BOT, ANA, MARK)]) })).toEqual({
        kind: 'approval_seen',
        by: MARK,
      });
    });

    it("Mark's B and Ana's C is disagreed", () => {
      const messages = [msg(110, MARK, 'B'), msg(115, ANA, 'C')];
      expect(open({ messages }).kind).toBe('disagreed');
    });

    it('Mark\'s ✅ and Ana\'s "hold on" in one tick is disagreed', () => {
      const messages = [msg(115, ANA, 'hold on')];
      expect(open({ proposal: proposal([check(BOT, MARK)]), messages })).toEqual({
        kind: 'disagreed',
      });
    });

    it('Mark\'s ✅ and Ana\'s "yes" in one tick credits Mark', () => {
      const messages = [msg(115, ANA, 'yes')];
      expect(open({ proposal: proposal([check(BOT, MARK)]), messages })).toEqual({
        kind: 'approval_seen',
        by: MARK,
      });
    });

    it("Mark's pick with Ana's other words is disagreed", () => {
      const messages = [msg(110, MARK, 'B'), msg(115, ANA, 'not sure')];
      expect(open({ messages }).kind).toBe('disagreed');
    });

    it('with Mark approved, Ana writing something else is disagreed', () => {
      const approvalSeen = { at: at(120), by: MARK };
      const messages = [msg(130, ANA, 'hold on')];
      expect(open({ approvalSeen, proposal: proposal([check(BOT, MARK)]), messages })).toEqual({
        kind: 'disagreed',
      });
    });

    it("with Mark approved, Ana's own approval keeps it approved, and anything else is disagreed", () => {
      const approvalSeen = { at: at(120), by: MARK };
      const withMark = proposal([check(BOT, MARK)]);
      const run = (text: string) =>
        open({ approvalSeen, proposal: withMark, messages: [msg(130, ANA, text)] }).kind;
      expect(run('yes')).toBe('approved');
      expect(run('B')).toBe('approved');
      expect(run('hmm wait')).toBe('disagreed');
      expect(run('C')).toBe('disagreed');
    });

    it('with Mark approved, Ana naming a different letter is disagreed and the same letter is fine', () => {
      const approvalSeen = { at: at(120), by: MARK };
      const withMark = proposal([check(BOT, MARK)]);
      expect(open({ approvalSeen, proposal: withMark, messages: [msg(130, ANA, 'C')] }).kind).toBe(
        'disagreed',
      );
      expect(open({ approvalSeen, proposal: withMark, messages: [msg(130, ANA, 'B')] }).kind).toBe(
        'approved',
      );
    });
  });

  describe('with no proposal', () => {
    const noProposal = (over: Partial<Input>) => state({ ...group, ...over });

    it('different letters are disagreed at once', () => {
      const messages = [msg(10, MARK, 'B'), msg(20, ANA, 'C')];
      expect(noProposal({ messages, quietSince: null })).toEqual({ kind: 'disagreed' });
    });

    it("one recipient's letter waits for a quiet tick, then is their pick", () => {
      const messages = [msg(10, MARK, 'B')];
      expect(noProposal({ messages, quietSince: null }).kind).toBe('waiting');
      expect(noProposal({ messages, quietSince: at(10) })).toEqual({
        kind: 'picked',
        by: MARK,
        choice: 'B',
      });
    });

    it('both naming the same letter credits the first to name it', () => {
      const messages = [msg(20, ANA, 'B'), msg(10, MARK, 'b)')];
      expect(noProposal({ messages, quietSince: at(20) })).toEqual({
        kind: 'picked',
        by: MARK,
        choice: 'B',
      });
    });

    it('a recipient whose latest message is not a letter has not picked, and the judge reads it', () => {
      const messages = [msg(10, MARK, 'B'), msg(20, MARK, 'hmm, wait')];
      expect(noProposal({ messages, quietSince: at(20), now: minutes(2) }).kind).toBe('settled');
    });

    it("one recipient taking back their letter with later words stops the other's pick", () => {
      const messages = [
        msg(10, MARK, 'B'),
        msg(20, ANA, 'B'),
        msg(30, ANA, 'hold on, I am not sure'),
      ];
      expect(noProposal({ messages, quietSince: at(30), now: minutes(2) }).kind).toBe('settled');
    });

    it('a recipient who never named a letter and only chatted does not take back anyone', () => {
      const messages = [msg(10, MARK, 'B'), msg(20, ANA, 'good question')];
      expect(noProposal({ messages, quietSince: at(20) })).toEqual({
        kind: 'picked',
        by: MARK,
        choice: 'B',
      });
    });

    describe('after a disagreement (the returned card)', () => {
      const afterDisagreement = { afterDisagreement: true, settledThroughTs: at(20) };

      it("counts a letter only when every recipient's latest letter agrees", () => {
        const alone = [msg(10, MARK, 'B'), msg(20, MARK, 'C'), msg(300, MARK, 'C')];
        expect(
          noProposal({ messages: alone, quietSince: at(300), ...afterDisagreement }).kind,
        ).not.toBe('picked');
        const both = [msg(10, MARK, 'B'), msg(20, ANA, 'C'), msg(300, MARK, 'C')];
        expect(noProposal({ messages: both, quietSince: at(300), ...afterDisagreement })).toEqual({
          kind: 'picked',
          by: ANA,
          choice: 'C',
        });
      });

      it('does not count a letter from one recipient while the other has not written one', () => {
        const messages = [msg(300, MARK, 'B')];
        expect(noProposal({ messages, quietSince: at(300), ...afterDisagreement }).kind).not.toBe(
          'picked',
        );
      });
    });

    it("after a disagreement, a recipient moving to the other's letter is agreement", () => {
      const messages = [msg(10, MARK, 'B'), msg(20, ANA, 'C'), msg(300, MARK, 'C')];
      expect(noProposal({ messages, quietSince: at(300), settledThroughTs: at(20) })).toEqual({
        kind: 'picked',
        by: ANA,
        choice: 'C',
      });
    });

    it('after a disagreement nothing new is waiting', () => {
      const messages = [msg(10, MARK, 'B'), msg(20, ANA, 'C')];
      expect(
        noProposal({ messages, quietSince: at(20), settledThroughTs: at(20), now: minutes(300) }),
      ).toEqual({ kind: 'waiting' });
    });

    it('a chatty conversation with no letter settles after 30 minutes', () => {
      const messages = [msg(10, MARK, 'hmm'), msg(20, ANA, 'we should talk')];
      const now = new Date(tick(20).getTime() + 30 * 60_000);
      expect(noProposal({ messages, now })).toEqual({ kind: 'settled' });
    });

    it("a letter from a non-recipient settles for the judge and is nobody's pick", () => {
      const messages = [msg(10, MARK, 'hmm'), msg(20, PRIYA, 'B')];
      expect(
        noProposal({ participants: [MARK, ANA, PRIYA], messages, quietSince: at(20) }).kind,
      ).toBe('settled');
    });
  });
});

describe('conversationState: the option count', () => {
  it('a letter past the option count is not a pick', () => {
    const open = {
      participants: [MARK, PRIYA],
      settledThroughTs: at(90),
      proposal: proposal([check(BOT)]),
      messages: [msg(110, MARK, 'D')],
    };
    expect(state({ ...open, optionCount: 4 }).kind).toBe('picked');
    expect(state({ ...open, optionCount: 3 }).kind).toBe('withdrawn');
  });
});

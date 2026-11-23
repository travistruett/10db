#!/usr/bin/env node
// A fake Slack Web API for the dev window: `TENDB_FAKE_SLACK=on pnpm dev:window` starts it and points the
// daemon at it (TENDB_SLACK_API), so the Slack screens can be clicked through with made-up workspaces.
// Tokens: xoxb-fake-acme and xoxb-fake-globex. A question sent to someone gets their reply 20 s later.
// It keeps everything in memory and stops when the dev script that started it ends.
import { createServer } from 'node:http';

const port = Number(process.env.FAKE_SLACK_PORT ?? 4399);
const REPLY_AFTER_MS = 20_000;

const member = (id, team, realName, title, email) => ({
  id,
  team_id: team,
  name: realName.split(' ')[0].toLowerCase(),
  real_name: realName,
  profile: { real_name: realName, display_name: '', title, email },
});

const TEAMS = {
  'xoxb-fake-acme': {
    id: 'T0FAKEACME',
    name: 'Acme',
    members: [
      member('U0ACMESAM', 'T0FAKEACME', 'Sam Rivera', 'Founder', 'sam@acme.test'),
      member('U0ACMEDANA', 'T0FAKEACME', 'Dana Ruiz', 'Head of Product', 'dana@acme.test'),
      member('U0ACMEMARK', 'T0FAKEACME', 'Mark Ellis', 'Billing Lead', 'mark@acme.test'),
      member('U0ACMEPRIYA', 'T0FAKEACME', 'Priya Shah', 'Designer', 'priya@acme.test'),
    ],
  },
  'xoxb-fake-globex': {
    id: 'T0FAKEGLBX',
    name: 'Globex',
    members: [
      member('U0GLBXSAM', 'T0FAKEGLBX', 'Sam Rivera', 'Contractor', 'sam@globex.test'),
      member('U0GLBXHANK', 'T0FAKEGLBX', 'Hank Scorpio', 'CEO', 'hank@globex.test'),
      member('U0GLBXLEE', 'T0FAKEGLBX', 'Lee Park', 'Engineer', 'lee@globex.test'),
    ],
  },
};

/** Posted messages by channel, each with its thread; replies appear once their time has come. */
const channels = new Map();
let clock = Date.now() * 1000;
const nextTs = () => {
  clock += 1;
  return `${String(Math.floor(clock / 1e6))}.${String(clock % 1e6).padStart(6, '0')}`;
};

function teamOf(req) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  return TEAMS[token] ?? null;
}

function visible(list, oldest) {
  const now = Date.now();
  return list.filter((m) => (m.showAt ?? 0) <= now && Number(m.ts) >= Number(oldest ?? 0));
}

function strip(m) {
  const rest = { ...m };
  delete rest.showAt;
  return rest;
}

function answer(method, team, args) {
  switch (method) {
    case 'auth.test':
      return { team_id: team.id, team: team.name, user_id: `${team.id}BOT`, user: '10db' };
    case 'users.list':
      return { members: team.members, response_metadata: { next_cursor: '' } };
    case 'users.info': {
      const found = team.members.find((m) => m.id === args.user);
      return found ? { user: found } : { ok: false, error: 'user_not_found' };
    }
    case 'conversations.open':
      return { channel: { id: `D-${String(args.users).replaceAll(',', '-')}` } };
    case 'chat.postMessage': {
      const ts = nextTs();
      const list = channels.get(args.channel) ?? [];
      const message = {
        ts,
        bot_id: 'B0FAKE',
        text: args.text ?? '',
        ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
        ...(args.metadata ? { metadata: args.metadata } : {}),
      };
      list.push(message);
      if (!args.thread_ts) {
        const person = String(args.channel).replace(/^D-/, '').split('-')[0];
        list.push({
          ts: nextTs(),
          thread_ts: ts,
          user: person,
          text: 'Seven days works for us. Thanks for checking!',
          showAt: Date.now() + REPLY_AFTER_MS,
        });
      }
      channels.set(args.channel, list);
      return { ts };
    }
    case 'chat.getPermalink':
      return { permalink: `https://fake-slack.test/${args.channel}/p${args.message_ts}` };
    case 'conversations.history': {
      const list = channels.get(args.channel) ?? [];
      return {
        messages: visible(
          list.filter((m) => !m.thread_ts),
          args.oldest,
        ).map(strip),
      };
    }
    case 'conversations.replies': {
      const list = channels.get(args.channel) ?? [];
      const thread = list.filter((m) => m.ts === args.ts || m.thread_ts === args.ts);
      return { messages: visible(thread, args.oldest).map(strip) };
    }
    case 'reactions.get':
      return { message: { reactions: [] } };
    case 'reactions.add':
      return {};
    default:
      return { ok: false, error: 'unknown_method' };
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(port)}`);
  const method = url.pathname.replace(/^\//, '');
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    const args = Object.fromEntries(url.searchParams);
    if (raw !== '') Object.assign(args, JSON.parse(raw));
    const team = teamOf(req);
    const body = team === null ? { ok: false, error: 'invalid_auth' } : answer(method, team, args);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...body }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(
    `fake Slack on http://127.0.0.1:${String(port)} (tokens: ${Object.keys(TEAMS).join(', ')})`,
  );
});

// Started in the background by scripts/dev.sh, which then execs pnpm: once that ends, this is orphaned.
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.exit(0);
}, 2000).unref();

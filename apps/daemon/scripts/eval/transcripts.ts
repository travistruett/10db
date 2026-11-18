import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Provider } from '@10db/contracts';
import { z } from 'zod';

/** The tool names Claude Code starts a subagent with: `Agent`, and `Task` in older releases. */
export const SpawnTool = { Agent: 'Agent', Task: 'Task' } as const;
const SPAWN_TOOLS: ReadonlySet<string> = new Set(Object.values(SpawnTool));

/** The part of a transcript line that carries a tool call; everything else is ignored. */
const TranscriptLine = z.object({
  type: z.literal('assistant'),
  message: z.object({
    content: z.array(z.object({ type: z.string(), name: z.string().optional() })),
  }),
});

/** The subagents a session started: its assistant messages' Agent and Task calls. */
export function countSpawns(transcript: string): number {
  let spawns = 0;
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = TranscriptLine.safeParse(json);
    if (!parsed.success) continue;
    for (const block of parsed.data.message.content)
      if (block.type === 'tool_use' && block.name !== undefined && SPAWN_TOOLS.has(block.name))
        spawns += 1;
  }
  return spawns;
}

export interface SessionTranscript {
  readonly sessionId: string;
  readonly provider: string;
  readonly providerSessionId: string | null;
  /** The Claude Code config dir the session ran with, whose `projects/` holds its transcript. */
  readonly configDir: string;
}

export interface KeptTranscripts {
  readonly kept: readonly { sessionId: string; spawns: number }[];
  /** Sessions whose transcript was not on disk. */
  readonly missing: readonly string[];
  /** Sessions on a provider whose transcripts this runner does not read yet. */
  readonly unsupported: readonly string[];
}

/** `<configDir>/projects/<slug>/<id>.jsonl`, under whichever project slug Claude Code gave the checkout. */
function findTranscript(configDir: string, providerSessionId: string): string | null {
  const projects = join(configDir, 'projects');
  if (!existsSync(projects)) return null;
  for (const slug of readdirSync(projects)) {
    const file = join(projects, slug, `${providerSessionId}.jsonl`);
    if (existsSync(file)) return join(projects, slug);
  }
  return null;
}

/**
 * Copies each Claude session's transcript, and its subagents' beside it, into `into` as
 * `<sessionId>.jsonl` and `<sessionId>/subagents/`, so a run's transcripts outlive any cleanup.
 */
export function keepTranscripts(
  sessions: readonly SessionTranscript[],
  into: string,
): KeptTranscripts {
  mkdirSync(into, { recursive: true });
  const kept: { sessionId: string; spawns: number }[] = [];
  const missing: string[] = [];
  const unsupported: string[] = [];
  for (const s of sessions) {
    if (s.provider !== Provider.Claude) {
      unsupported.push(s.sessionId);
      continue;
    }
    const dir =
      s.providerSessionId === null ? null : findTranscript(s.configDir, s.providerSessionId);
    if (dir === null || s.providerSessionId === null) {
      missing.push(s.sessionId);
      continue;
    }
    const file = join(into, `${s.sessionId}.jsonl`);
    cpSync(join(dir, `${s.providerSessionId}.jsonl`), file);
    const subagents = join(dir, s.providerSessionId, 'subagents');
    if (existsSync(subagents))
      cpSync(subagents, join(into, s.sessionId, 'subagents'), { recursive: true });
    kept.push({ sessionId: s.sessionId, spawns: countSpawns(readFileSync(file, 'utf8')) });
  }
  return { kept, missing, unsupported };
}

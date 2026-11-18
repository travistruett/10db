import {
  DecisionEdit,
  DecisionId,
  DecisionWrite,
  KnowledgeItemKind,
  KnowledgeListKind,
  KnowledgeListShelf,
  KnowledgeScope,
  PrincipleEdit,
  PrincipleId,
  PrincipleWrite,
} from '@10db/contracts';
import { z } from 'zod';
import { TendbError } from './errors';

// What the Knowledge commands decide without the API: which flags make a list query, how a record reads on
// a line, and whether a body fits the daemon's own write schemas.

/** Who an agent's writes are attributed to when its file names no source of its own. */
const SKILL_SOURCE_VIA = '10db-task';

/** The parts of a decision or principle the commands read; the daemon's item has many more. */
export const KnowledgeItemView = z.looseObject({
  kind: z.enum(KnowledgeItemKind),
  id: z.string(),
  scope: z.enum(KnowledgeScope),
  area: z.string().nullish(),
  state: z.string(),
  supersedesId: z.string().nullish(),
  principleKind: z.string().optional(),
  topicKey: z.string().optional(),
  statement: z.string().optional(),
  question: z.string().optional(),
  choice: z.string().optional(),
});
export type KnowledgeItemView = z.infer<typeof KnowledgeItemView>;

export const KnowledgeListView = z.object({
  items: z.array(KnowledgeItemView),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  search: z.object({ available: z.boolean(), message: z.string().nullable() }),
});
export type KnowledgeListView = z.infer<typeof KnowledgeListView>;

const LIST_USAGE =
  'usage: knowledge <projectId> [--q <text>] [--kind decision|principle|policy|heuristic|belief]... [--scope you|project|area] [--shelf current|past|all] [--page <n>]';

const LIST_FLAGS: Record<string, string> = {
  '--q': 'q',
  '--kind': 'kind',
  '--scope': 'scope',
  '--shelf': 'shelf',
  '--page': 'page',
};

function checkedFlag(name: string, value: string): string {
  const allowed: Record<string, readonly string[] | null> = {
    kind: KnowledgeListKind.options,
    scope: Object.values(KnowledgeScope),
    shelf: Object.values(KnowledgeListShelf),
    q: null,
    page: null,
  };
  const choices = allowed[name];
  if (choices && !choices.includes(value)) {
    throw new TendbError(`--${name} is ${choices.join(', ')}, not ${value}.`);
  }
  if (name === 'page' && !/^[1-9]\d*$/.test(value)) {
    throw new TendbError(`--page is a number from 1, not ${value}.`);
  }
  return value;
}

/** The list route for a project and the command's flags, in a fixed order; no flags is the daemon's default. */
export function knowledgeListPath(projectId: string, args: readonly string[]): string {
  const values = new Map<string, string[]>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? '';
    const name = LIST_FLAGS[flag];
    const value = args[i + 1];
    if (name === undefined || value === undefined) throw new TendbError(LIST_USAGE);
    values.set(name, [...(values.get(name) ?? []), checkedFlag(name, value)]);
  }
  const query = new URLSearchParams();
  for (const name of Object.values(LIST_FLAGS)) {
    for (const value of values.get(name) ?? []) query.append(name, value);
  }
  const text = query.toString();
  return `/projects/${projectId}/knowledge${text === '' ? '' : `?${text}`}`;
}

/** Where a record applies: its scope, and its area for an area record. */
function placeOf(item: Pick<KnowledgeItemView, 'scope' | 'area'>): string {
  return item.area ? `${item.scope}:${item.area}` : item.scope;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** What a record says: a decision's question and choice, or a principle's statement. */
function textOf(item: KnowledgeItemView): string {
  if (item.kind === KnowledgeItemKind.Decision) {
    return oneLine(`${item.question ?? ''} -> ${item.choice ?? ''}`);
  }
  return oneLine(item.statement ?? '');
}

/** One tab-separated line: id, place, state, kind, topic key and text. */
export function knowledgeLine(item: KnowledgeItemView): string {
  const kind = item.kind === KnowledgeItemKind.Decision ? 'decision' : (item.principleKind ?? '');
  return [item.id, placeOf(item), item.state, kind, item.topicKey ?? '', textOf(item)].join('\t');
}

/** A record's place as the Knowledge view names it: the builder's own scope, `you`, shows as All Projects. */
export function placeLabel(item: Pick<KnowledgeItemView, 'scope' | 'area'>): string {
  return item.scope === KnowledgeScope.You ? 'All Projects' : placeOf(item);
}

/** The record's own words, for a line that says what was written. */
export function summaryOf(item: KnowledgeItemView): string {
  return item.kind === KnowledgeItemKind.Decision ? oneLine(item.question ?? '') : textOf(item);
}

/** A decision's or principle's id, which says which routes act on it; null for any other id. */
export function kindOfId(id: string): KnowledgeItemKind | null {
  if (DecisionId.safeParse(id).success) return KnowledgeItemKind.Decision;
  if (PrincipleId.safeParse(id).success) return KnowledgeItemKind.Principle;
  return null;
}

const SCHEMAS = {
  write: { decision: DecisionWrite, principle: PrincipleWrite },
  edit: { decision: DecisionEdit, principle: PrincipleEdit },
} as const;

function issues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`);
}

/**
 * The body for a write, checked with the daemon's own schema so a refusal reads word for word as the API's.
 * It carries the file's own `source` or one naming this skill, and `dryRun` when asked.
 */
export function knowledgeBody(
  act: 'write' | 'edit',
  kind: KnowledgeItemKind,
  raw: unknown,
  cwd: string,
  dryRun: boolean,
): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TendbError(
      "The body doesn't fit 10db's Knowledge rules:\n- (body): must be a JSON object",
    );
  }
  const body: Record<string, unknown> = { ...raw };
  if (body['source'] === undefined) body['source'] = { via: SKILL_SOURCE_VIA, cwd };
  if (dryRun) body['dryRun'] = true;
  const parsed = SCHEMAS[act][kind].safeParse(body);
  if (!parsed.success) {
    throw new TendbError(
      `The body doesn't fit 10db's Knowledge rules:\n- ${issues(parsed.error).join('\n- ')}`,
    );
  }
  return body;
}

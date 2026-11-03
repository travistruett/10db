import {
  InvalidError,
  ShapeAttachment,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeProposalBody,
  ShapeProposalKind,
  type ShapeAttachTarget,
  type ShapeAttachmentDto,
  type ShapeId,
} from '@10db/contracts';
import {
  insertShapeAttachment,
  insertShapeMessage,
  listShapeAttachments,
  listShapeLinks,
  listShapeProposals,
  type DbReader,
  type WriteContext,
} from '@10db/db';

// Shape spec §10.3. The session attaches a Mermaid diagram, a chart or an HTML mockup to a proposed
// task or goal, or to one this conversation converted. The schema already refused a chart that names a
// URL; the screen renders every attachment inert.

/** Every key a proposal row answers to: its own, and a goal's tasks' keys. */
function proposalKeys(db: DbReader, shapeId: ShapeId): Set<string> {
  const keys = new Set<string>();
  for (const row of listShapeProposals(db, shapeId)) {
    keys.add(row.key);
    if (row.kind === ShapeProposalKind.Goal)
      for (const task of ShapeProposalBody.goal.parse(row.body).tasks) keys.add(task.key);
  }
  return keys;
}

export function attach(
  ctx: WriteContext,
  shapeId: ShapeId,
  input: { readonly target: ShapeAttachTarget; readonly attachment: ShapeAttachment },
): { readonly attached: true } {
  const { target, attachment } = input;
  let key: string;
  let goalId = null;
  let taskId = null;
  if ('key' in target) {
    if (!proposalKeys(ctx.tx, shapeId).has(target.key))
      throw new InvalidError(`There is no task or goal with the key ${target.key} in the plan`);
    key = target.key;
  } else {
    const links = listShapeLinks(ctx.tx, shapeId);
    const id = 'goalId' in target ? target.goalId : target.taskId;
    if (!links.some((l) => l.goalId === id || l.taskId === id))
      throw new InvalidError(`${id} did not come from this conversation`);
    key = id;
    if ('goalId' in target) goalId = target.goalId;
    else taskId = target.taskId;
  }
  const body =
    attachment.kind === 'mermaid'
      ? attachment.source
      : attachment.kind === 'mockup'
        ? attachment.html
        : JSON.stringify(attachment.spec);
  insertShapeAttachment(ctx, { shapeId, kind: attachment.kind, key, body, goalId, taskId });
  insertShapeMessage(ctx, shapeId, {
    author: ShapeMessageAuthor.Claude,
    kind: ShapeMessageKind.Tool,
    body: `attach · ${attachment.kind} · ${key}`,
  });
  return { attached: true };
}

/** The attachment a stored row holds; null for a spec, an eval, or a body that no longer parses. */
function attachmentOf(kind: string, body: string): ShapeAttachment | null {
  let candidate: unknown;
  if (kind === 'mermaid') candidate = { kind, source: body };
  else if (kind === 'mockup') candidate = { kind, html: body };
  else if (kind === 'chart') {
    try {
      candidate = { kind, spec: JSON.parse(body) as unknown };
    } catch {
      return null;
    }
  } else return null;
  const parsed = ShapeAttachment.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** The view's attachments: diagrams, charts and mockups, oldest first. */
export function attachmentsOf(db: DbReader, shapeId: ShapeId): ShapeAttachmentDto[] {
  return listShapeAttachments(db, shapeId).flatMap((row) => {
    const attachment = attachmentOf(row.kind, row.body);
    return attachment === null
      ? []
      : [{ id: row.id, key: row.key, goalId: row.goalId, taskId: row.taskId, attachment }];
  });
}

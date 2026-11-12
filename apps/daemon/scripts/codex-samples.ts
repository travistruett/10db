import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

export class SampleError extends Error {
  override readonly name = 'SampleError';
}

/** One JSON Schema node, as far as the sampler reads it. Every other key is checked by name. */
const SchemaNode = z.looseObject({
  type: z.union([z.string(), z.array(z.string())]).optional(),
  enum: z.array(z.unknown()).optional(),
  const: z.unknown().optional(),
  $ref: z.string().optional(),
  anyOf: z.array(z.unknown()).optional(),
  oneOf: z.array(z.unknown()).optional(),
  allOf: z.array(z.unknown()).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
  items: z.unknown().optional(),
  definitions: z.record(z.string(), z.unknown()).optional(),
});
type SchemaNode = z.infer<typeof SchemaNode>;

/** The keys the sampler reads to shape a value. */
const SHAPING = new Set([
  'type',
  'enum',
  'const',
  '$ref',
  'anyOf',
  'oneOf',
  'allOf',
  'properties',
  'required',
  'items',
]);

/**
 * Keys that never stop a sample from being valid: annotations, the definitions a `$ref` reads, and
 * constraints the samples meet (`additionalProperties`, since a sample holds only required
 * properties; `format`, `minimum` and `minLength`, which the generated schema test checks).
 */
const IGNORED = new Set([
  '$schema',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'definitions',
  'additionalProperties',
  'format',
  'minimum',
  'minLength',
]);

const LOCAL_REF = '#/definitions/';

/**
 * Sample payloads a per-type JSON schema allows: a base instance, then one instance for each
 * alternative a `oneOf` or `anyOf` branch, a `type` list or an `enum` offers anywhere, with every
 * other choice at its first option. An object holds its required properties and those that may be
 * null (`allowsNull`), and an array one item. Duplicates are dropped and the order is stable. A
 * keyword that shapes a value and is not read here throws `SampleError` naming it.
 */
export function sampleInstances(document: unknown): unknown[] {
  const root = parseNode(document, '#');
  return new Sampler(root.definitions ?? {}).sample(document, '#');
}

function parseNode(raw: unknown, at: string): SchemaNode {
  const parsed = SchemaNode.safeParse(raw);
  if (!parsed.success) throw new SampleError(`${at} is not a schema node this sampler reads`);
  for (const key of Object.keys(parsed.data))
    if (!SHAPING.has(key) && !IGNORED.has(key))
      throw new SampleError(`${at} uses "${key}", which the sampler does not read`);
  return parsed.data;
}

/**
 * Whether a property's schema offers null directly: how the generated schema writes a Rust `Option`,
 * which serde sends as null when unset, so Codex sends the property though `required` leaves it out.
 */
function allowsNull(raw: unknown): boolean {
  const node = SchemaNode.safeParse(raw);
  if (!node.success) return false;
  const { type, anyOf, oneOf } = node.data;
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) return true;
  return [...(anyOf ?? []), ...(oneOf ?? [])].some(
    (branch) => SchemaNode.safeParse(branch).data?.type === 'null',
  );
}

function unique(values: readonly unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (const value of values)
    if (!kept.some((other) => isDeepStrictEqual(other, value))) kept.push(value);
  return kept;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The shaping keys of a node, without the one being expanded. */
function rest(node: SchemaNode, without: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(node).filter(([key]) => key !== without && SHAPING.has(key)),
  );
}

class Sampler {
  private readonly definitions: Readonly<Record<string, unknown>>;
  private readonly resolving = new Set<string>();

  constructor(definitions: Readonly<Record<string, unknown>>) {
    this.definitions = definitions;
  }

  sample(raw: unknown, at: string): unknown[] {
    // `true` allows any value; null is one.
    if (raw === true) return [null];
    if (raw === false) throw new SampleError(`${at} allows no value`);
    const node = parseNode(raw, at);
    if (node.$ref !== undefined) return this.reference(node, at);
    if (node.allOf !== undefined) return this.allOf(node, node.allOf, at);
    const branches = node.oneOf ?? node.anyOf;
    if (branches !== undefined) {
      const key = node.oneOf === undefined ? 'anyOf' : 'oneOf';
      const shared = rest(node, key);
      const choices = Object.keys(shared).length === 0;
      return this.choose(
        branches.map((branch) => (choices ? branch : { allOf: [shared, branch] })),
        `${at}/${key}`,
      );
    }
    if (node.const !== undefined) return [node.const];
    if (node.enum !== undefined) return unique(node.enum);
    if (Array.isArray(node.type))
      return this.choose(
        node.type.map((type) => ({ ...node, type })),
        `${at}/type`,
      );
    const type = node.type ?? (node.properties !== undefined ? 'object' : undefined);
    switch (type) {
      case undefined:
        if (node.required !== undefined || node.items !== undefined)
          throw new SampleError(`${at} names properties or items with no type`);
        return [null];
      case 'string':
        return ['x'];
      case 'integer':
      case 'number':
        return [0];
      case 'boolean':
        return [false];
      case 'null':
        return [null];
      case 'array':
        return this.sample(node.items ?? true, `${at}/items`).map((item) => [item]);
      case 'object':
        return this.object(node, at);
      default:
        throw new SampleError(`${at} has type "${type}", which the sampler does not read`);
    }
  }

  private reference(node: SchemaNode, at: string): unknown[] {
    const ref = node.$ref ?? '';
    if (!ref.startsWith(LOCAL_REF))
      throw new SampleError(`${at} refers outside the document: ${ref}`);
    const shared = rest(node, '$ref');
    if (Object.keys(shared).length > 0) return this.sample({ allOf: [shared, { $ref: ref }] }, at);
    const name = ref.slice(LOCAL_REF.length);
    if (!(name in this.definitions)) throw new SampleError(`${at} refers to a missing ${ref}`);
    if (this.resolving.has(name)) throw new SampleError(`${at} reaches ${ref} inside itself`);
    this.resolving.add(name);
    try {
      return this.sample(this.definitions[name], ref);
    } finally {
      this.resolving.delete(name);
    }
  }

  /** Each alternative's base and variants, in order. */
  private choose(alternatives: readonly unknown[], at: string): unknown[] {
    if (alternatives.length === 0) throw new SampleError(`${at} offers no alternative`);
    return unique(
      alternatives.flatMap((alternative, i) => this.sample(alternative, `${at}/${String(i)}`)),
    );
  }

  private object(node: SchemaNode, at: string): unknown[] {
    const properties = node.properties ?? {};
    const required = new Set(node.required ?? []);
    const kept = [
      ...required,
      ...Object.keys(properties).filter(
        (name) => !required.has(name) && allowsNull(properties[name]),
      ),
    ];
    const samples = kept.map(
      (name) => [name, this.sample(properties[name] ?? true, `${at}/properties/${name}`)] as const,
    );
    const base = Object.fromEntries(samples.map(([name, values]) => [name, values[0]]));
    const variants = samples.flatMap(([name, values]) =>
      values.slice(1).map((value) => ({ ...base, [name]: value })),
    );
    return unique([base, ...variants]);
  }

  private allOf(node: SchemaNode, parts: readonly unknown[], at: string): unknown[] {
    const shared = rest(node, 'allOf');
    const all = Object.keys(shared).length > 0 ? [shared, ...parts] : parts;
    const samples = all.map((part, i) => this.sample(part, `${at}/allOf/${String(i)}`));
    const merge = (picked: readonly unknown[]): unknown => {
      if (picked.length === 1) return picked[0];
      if (picked.every(isPlainObject)) return Object.fromEntries(picked.flatMap(Object.entries));
      throw new SampleError(`${at} merges parts that are not all objects`);
    };
    const bases = samples.map((values) => values[0]);
    const variants = samples.flatMap((values, i) =>
      values.slice(1).map((value) => merge(bases.map((b, j) => (j === i ? value : b)))),
    );
    return unique([merge(bases), ...variants]);
  }
}

import { createServer, type Http2ServerRequest } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { AccountKind } from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { askModel, type ModelQuestion } from './ask';
import { JudgeCallError } from './credential';
import { ModelApi } from './openrouter';

// Bedrock's runtime client speaks HTTP/2, so the stand-in runtime does too (cleartext, on loopback).
// Value: protects=the request shape and answer parse of a decision on an Anthropic key or Bedrock; fails_when=the schema loses its option enum, the choice is not matched to an offered option, or a malformed answer is accepted; why_new=core: these answers decide crosses_limit; no_claim=a live call to either API succeeds

const base = {
  model: 'claude-haiku-4-5',
  api: ModelApi.Chat,
  state: 'a diff',
  question: 'Does it need review?',
  options: ['review', 'skip'],
  signal: new AbortController().signal,
  fetch,
} as const satisfies Omit<ModelQuestion, 'credential'>;

const answerBody = (text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    model: 'claude-haiku-4-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 1000, output_tokens: 100 },
    ...extra,
  });

describe('an Anthropic API key account', () => {
  it('sends the schema with the options, reads the answer and refuses a bad one', async () => {
    let seen: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    const answer = await askModel({
      ...base,
      price: { inputUsdPerMillion: 1, outputUsdPerMillion: 5 },
      credential: { kind: AccountKind.AnthropicApiKey, key: 'sk-ant-test' },
      fetch: (url, init) => {
        seen = {
          url: typeof url === 'string' ? url : '',
          headers: new Headers(init?.headers),
          body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
            string,
            unknown
          >,
        };
        return Promise.resolve(
          new Response(answerBody('{"choice":"SKIP","confidence":1.4}'), { status: 200 }),
        );
      },
    });
    expect(seen?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen?.headers.get('x-api-key')).toBe('sk-ant-test');
    expect(JSON.stringify(seen?.body)).toContain('"enum":["review","skip"]');
    // Casing is matched to the options, and a confidence past 1 is clamped.
    expect(answer).toEqual({
      choice: 'skip',
      confidence: 1,
      model: 'claude-haiku-4-5',
      costUsd: 0.0015,
    });

    const ask = (text: string, extra?: Record<string, unknown>): Promise<unknown> =>
      askModel({
        ...base,
        credential: { kind: AccountKind.AnthropicApiKey, key: 'sk-ant-test' },
        fetch: () => Promise.resolve(new Response(answerBody(text, extra), { status: 200 })),
      });
    await expect(ask('not json')).rejects.toBeInstanceOf(JudgeCallError);
    await expect(ask('{"choice":"maybe","confidence":0.9}')).rejects.toBeInstanceOf(JudgeCallError);
    await expect(
      ask('{"choice":"skip","confidence":0.9}', { stop_reason: 'refusal' }),
    ).rejects.toBeInstanceOf(JudgeCallError);
  });
});

describe('a Bedrock account', () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  async function runtime(reply: (request: Http2ServerRequest, body: string) => string): Promise<{
    endpoint: string;
    seen: { url?: string | undefined; auth?: string | undefined; body?: string | undefined };
  }> {
    const seen: { url?: string | undefined; auth?: string | undefined; body?: string | undefined } =
      {};
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        seen.url = request.url;
        seen.auth = request.headers.authorization;
        seen.body = body;
        response.setHeader('content-type', 'application/json');
        response.end(reply(request, body));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, seen };
  }

  it('invokes the model with Anthropic’s body and a bearer token, and reads the answer, refusing a bad one', async () => {
    let text = '{"choice":"review","confidence":0.8}';
    const { endpoint, seen } = await runtime(() => answerBody(text));
    const question: ModelQuestion = {
      ...base,
      model: 'us.anthropic.claude-haiku-4-5-v1:0',
      credential: {
        kind: AccountKind.Bedrock,
        region: 'us-west-2',
        awsProfile: null,
        bearerToken: 'bedrock-token',
      },
      bedrockEndpoint: endpoint,
    };
    const answer = await askModel(question);
    expect(seen.url).toContain('/model/us.anthropic.claude-haiku-4-5-v1%3A0/invoke');
    expect(seen.auth).toBe('Bearer bedrock-token');
    expect(seen.body).toContain('"anthropic_version":"bedrock-2023-05-31"');
    expect(seen.body).toContain('"enum":["review","skip"]');
    expect(answer).toMatchObject({ choice: 'review', confidence: 0.8, costUsd: null });
    text = '{"choice":"review"}';
    await expect(askModel(question)).rejects.toBeInstanceOf(JudgeCallError);
  });
});

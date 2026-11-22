import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';
import { z } from 'zod';
import {
  ERROR_DETAIL_CHARS,
  messagesBody,
  parseMessagesResponse,
  scrubbed,
  type MessagesQuestion,
} from './anthropic';
import { JudgeCallError } from './credential';
import type { ModelAnswer } from './openrouter';

const BEDROCK_VERSION = 'bedrock-2023-05-31';

export type BedrockClientConfig = NonNullable<
  ConstructorParameters<typeof BedrockRuntimeClient>[0]
>;
export type BedrockClientFactory = (config: BedrockClientConfig) => BedrockRuntimeClient;
const sdkClient: BedrockClientFactory = (config) => new BedrockRuntimeClient(config);

/**
 * A profile's client is kept per profile and region, so the SDK's own credential cache (an SSO token, a
 * `credential_process` result) is shared across decisions instead of redone inside every call's timeout.
 */
const profileClients = new Map<string, BedrockRuntimeClient>();

/** The SDK's error carries the HTTP status here; it is read at the boundary, not cast. */
const SdkErrorMetadata = z.object({ $metadata: z.object({ httpStatusCode: z.number() }) });

export interface BedrockQuestion extends MessagesQuestion {
  readonly region: string;
  /** Null: sign with `bearerToken`. */
  readonly awsProfile: string | null;
  readonly bearerToken: string | null;
  /** Builds the runtime client; production builds the SDK's own. */
  readonly client?: BedrockClientFactory;
  readonly signal: AbortSignal;
}

/**
 * One InvokeModel call on Bedrock's runtime with Anthropic's body. A profile signs with SigV4 through the shared AWS
 * config; a bearer token (a Bedrock API key) goes to the client's `token` option with the bearer scheme preferred,
 * the same path `AWS_BEARER_TOKEN_BEDROCK` takes. Throws JudgeCallError, or what the SDK throws.
 */
export async function askBedrock(q: BedrockQuestion): Promise<ModelAnswer> {
  const auth =
    q.awsProfile !== null
      ? { credentials: fromIni({ profile: q.awsProfile }) }
      : q.bearerToken !== null
        ? { token: { token: q.bearerToken }, authSchemePreference: ['httpBearerAuth'] }
        : null;
  if (auth === null) throw new JudgeCallError('Bedrock has neither an AWS profile nor a token');
  // Only the SDK's own client for a profile is kept; a bearer token can change, and an injected client is the caller's.
  const keep = q.client === undefined && q.awsProfile !== null;
  const key = `${q.awsProfile ?? ''}|${q.region}`;
  const client =
    (keep ? profileClients.get(key) : undefined) ??
    (q.client ?? sdkClient)({ region: q.region, ...auth });
  if (keep) profileClients.set(key, client);
  try {
    const result = await client.send(
      new InvokeModelCommand({
        modelId: q.model,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({ anthropic_version: BEDROCK_VERSION, ...messagesBody(q) }),
      }),
      { abortSignal: q.signal },
    );
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(result.body));
    } catch {
      throw new JudgeCallError('Bedrock did not answer with JSON');
    }
    return parseMessagesResponse('Bedrock', q, value);
  } catch (error) {
    if (error instanceof JudgeCallError || q.signal.aborted) throw error;
    const status = SdkErrorMetadata.safeParse(error).data?.$metadata.httpStatusCode;
    const name = error instanceof Error ? error.name : 'error';
    const message =
      error instanceof Error
        ? `: ${scrubbed(error.message, q.bearerToken).slice(0, ERROR_DETAIL_CHARS)}`
        : '';
    throw new JudgeCallError(
      scrubbed(
        `Bedrock answered ${status === undefined ? '' : `HTTP ${String(status)} `}${name}${message}`,
        q.bearerToken,
      ),
    );
  } finally {
    if (!keep) client.destroy();
  }
}

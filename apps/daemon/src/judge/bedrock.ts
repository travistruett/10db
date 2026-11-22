import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';
import { messagesBody, parseMessagesResponse, type MessagesQuestion } from './anthropic';
import { JudgeCallError } from './credential';
import type { ModelAnswer } from './openrouter';

const BEDROCK_VERSION = 'bedrock-2023-05-31';

export interface BedrockQuestion extends MessagesQuestion {
  readonly region: string;
  /** Null: sign with `bearerToken`. */
  readonly awsProfile: string | null;
  readonly bearerToken: string | null;
  /** Replaces the regional runtime endpoint. */
  readonly endpoint?: string;
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
  const client = new BedrockRuntimeClient({
    region: q.region,
    ...(q.endpoint === undefined ? {} : { endpoint: q.endpoint }),
    ...auth,
  });
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
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    // An SDK error can quote the request; only its name and status are kept.
    const name = error instanceof Error ? error.name : 'error';
    throw new JudgeCallError(
      `Bedrock answered ${status === undefined ? '' : `HTTP ${String(status)} `}${name}`.trim(),
    );
  } finally {
    client.destroy();
  }
}

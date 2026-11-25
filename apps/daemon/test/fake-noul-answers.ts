import { z } from 'zod';

const NoulRequest = z.object({
  model: z.string(),
  questions: z.record(z.string(), z.object({ type: z.literal('noul') })),
});
const ChatNoulRequest = z.object({
  model: z.string(),
  response_format: z.object({
    json_schema: z.object({ schema: z.object({ required: z.array(z.string()) }) }),
  }),
});

/**
 * OpenRouter's answer to a request asking yes/no questions, each answered no with 0.1, on whichever endpoint it was
 * sent to; null when the request asks something else, so the fake answers it as before.
 */
export function noulAnswer(url: string, body: unknown): Response | null {
  const raw: unknown = typeof body === 'string' ? JSON.parse(body) : null;
  if (url.endsWith('/chat/completions')) {
    const chat = ChatNoulRequest.safeParse(raw);
    if (!chat.success) return null;
    const ids = chat.data.response_format.json_schema.schema.required;
    if (ids.includes('choice')) return null;
    return Response.json({
      model: chat.data.model,
      choices: [
        { message: { content: JSON.stringify(Object.fromEntries(ids.map((id) => [id, 0.1]))) } },
      ],
      usage: { cost: 0 },
    });
  }
  const asked = NoulRequest.safeParse(raw);
  if (!asked.success) return null;
  return Response.json({
    model: asked.data.model,
    answers: Object.fromEntries(
      Object.keys(asked.data.questions).map((id) => [id, { type: 'noul', noul: 0.1 }]),
    ),
    usage: { input_tokens: 10, output_tokens: 2, cost: 0 },
  });
}

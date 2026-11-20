/**
 * Whether the Plan's agent can run the rehearsal's implementer: null while its conversation loads, so
 * nothing starts or hides on a guess. A conversation that can't be read keeps what Claude has always
 * done (rehearse); on an agent without subagents that turn starts, and the agent says it can't rehearse.
 */
export function agentRehearses(conversation: {
  readonly isError: boolean;
  readonly data?: { readonly capabilities: { readonly subagents: boolean } } | undefined;
}): boolean | null {
  if (conversation.data !== undefined) return conversation.data.capabilities.subagents;
  return conversation.isError ? true : null;
}

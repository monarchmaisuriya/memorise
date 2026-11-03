// The waiting proposals a chat card lists: the ones its capture pass added, or, on a card that names
// none (added before 0.10.4), every waiting proposal from the agent.
export function cardSuggestions<T extends { id: string; source: { agentId: string | null } }>(proposals: readonly T[], agentId: string, ids: readonly string[] | undefined): T[] {
  return proposals.filter((proposal) => proposal.source.agentId === agentId && (ids === undefined || ids.includes(proposal.id)));
}

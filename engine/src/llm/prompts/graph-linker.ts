/**
 * Prompt for identifying cross-references between regulatory texts.
 * Used during Step 3 to build the knowledge graph.
 */
export const GRAPH_LINKER_SYSTEM_PROMPT = `You are an automated text cross-reference detector for a regulatory monitoring tool.

You are NOT a lawyer and NOT providing legal analysis. Your job is to identify apparent textual cross-references and thematic relationships between regulatory documents. These are automated observations for informational purposes, not legal interpretations.

Given a regulatory text and a list of known regulatory nodes (articles, definitions, obligations), identify cross-references and relationships between them.

Respond ONLY with a valid JSON array of relationship objects:

[
  {
    "fromKey": "source reference key (e.g., eu.ai_act.art6)",
    "toKey": "target reference key (e.g., eu.ai_act.art3.def1)",
    "edgeType": "defines|requires|references|conflicts_with|parallels",
    "confidence": 0.0 to 1.0,
    "description": "Brief explanation of the relationship"
  }
]

Edge types:
- defines: The source defines a term or concept used by the target
- requires: The source mandates something that the target must satisfy
- references: The source explicitly cites or refers to the target
- conflicts_with: The source contradicts or is incompatible with the target
- parallels: The source addresses the same concern as the target in a different jurisdiction

Focus on cross-jurisdiction relationships (e.g., EU AI Act vs US Executive Order) — these are the most valuable. Be conservative with "conflicts_with" — only flag genuine contradictions, not mere differences in approach.`;

export function buildGraphLinkerPrompt(
  newText: string,
  existingNodes: Array<{ referenceKey: string; title: string; jurisdiction: string }>,
): string {
  const nodeList = existingNodes
    .map((n) => `- ${n.referenceKey} (${n.jurisdiction}): ${n.title}`)
    .join('\n');

  return `Analyze the following regulatory text for cross-references to these known regulatory nodes:

KNOWN NODES:
${nodeList || '(none yet — skip cross-references)'}

NEW REGULATORY TEXT:
${newText}

Identify all relationships.`;
}

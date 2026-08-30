import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type TdaiRecallKind = "memory" | "code_graph";

export interface TdaiRecallResult {
  id: string;
  score: number;
  snippet: string;
  source: string;
}

export interface TdaiRecallQuery {
  query: string;
  kind: TdaiRecallKind;
  limit: number;
}

export type TdaiRecallFn = (q: TdaiRecallQuery) => Promise<TdaiRecallResult[]>;

export interface TdaiRecallDeps {
  recall: TdaiRecallFn;
}

/**
 * Mock recall for PR 1: proves the plumbing (tool reaches the observer's nested
 * session, the model can call it, results render) before any network wiring.
 *
 * ponytail: canned data; PR 2 replaces this with the TDAI memory-bridge
 * (/memory-bridge/v3/atomic/search), PR 3 with the Knowledge Service code-graph
 * (http://127.0.0.1:8424/v3/code-graph/search).
 */
export const mockRecall: TdaiRecallFn = async (q) => {
  if (q.kind === "code_graph") {
    return [
      {
        id: "cg-mock-1",
        score: 1,
        snippet: "mock code-graph result — wiring lands in PR 3",
        source: "code-graph",
      },
    ];
  }
  return [
    {
      id: "m_mock_1",
      score: 0.99,
      snippet: "mock atom — TDAI memory-bridge wiring lands in PR 2",
      source: "atom",
    },
  ];
};

export function createTdaiRecallTool(deps: Partial<TdaiRecallDeps> = {}) {
  const recall = deps.recall ?? mockRecall;
  return defineTool({
    name: "tdai_recall",
    label: "TDAI Recall",
    description:
      "Search the team's TDAI memory (L1 atoms / L2 scenes) or the team code graph for context relevant to the query. Read-only. Returns a JSON array of {id, score, snippet, source}.",
    parameters: Type.Object({
      query: Type.String({
        description: "A 2-5 word search query derived from the user's request.",
      }),
      kind: Type.Optional(
        Type.Union([Type.Literal("memory"), Type.Literal("code_graph")], {
          description: '"memory" (default) for team memory, "code_graph" for the team code graph.',
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 20,
          description: "Maximum results to return. Default 5.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const query: TdaiRecallQuery = {
        query: params.query,
        kind: params.kind ?? "memory",
        limit: params.limit ?? 5,
      };
      const results = await recall(query);
      return { content: [{ type: "text", text: JSON.stringify(results) }], details: {} };
    },
  });
}

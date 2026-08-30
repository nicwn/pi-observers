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

export interface TdaiBridgeConfig {
  baseUrl: string;
  serviceId: string;
  conversationId: string;
  fetchImpl?: typeof fetch;
}

/** Truncate to max code points without splitting a surrogate pair. */
function truncatePoints(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

const BRIDGE_TIMEOUT_MS = 5000;

/**
 * Real recall for kind=memory: the TDAI memory-bridge L1 atomic search, scoped to
 * the HOST session's conversation (the same pi-{sessionId} identity the
 * @nicwn/tencentdb-agent-memory-proxy extension registers). Any failure returns
 * [] so the observer stays silent — an unreachable TDAI must never become noise
 * in the host session.
 *
 * ponytail: kind=code_graph delegates to mockRecall; PR 3 wires the Knowledge
 * Service (http://127.0.0.1:8424/v3/code-graph/list + /search).
 */
export function createBridgeRecall(cfg: TdaiBridgeConfig): TdaiRecallFn {
  return async (q) => {
    if (q.kind === "code_graph") return mockRecall(q);
    try {
      const res = await (cfg.fetchImpl ?? fetch)(`${cfg.baseUrl}/memory-bridge/v3/atomic/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": cfg.serviceId,
          "x-conversation-id": cfg.conversationId,
        },
        body: JSON.stringify({ query: q.query, limit: q.limit }),
        signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      const envelope = (await res.json()) as {
        code?: number;
        data?: { items?: Array<{ id?: unknown; type?: unknown; content?: unknown; score?: unknown }> };
      };
      if (envelope.code !== 0) return [];
      const items = envelope.data?.items ?? [];
      return items.map((i) => ({
        id: String(i.id ?? ""),
        score: Number(i.score ?? 0),
        snippet: truncatePoints(String(i.content ?? ""), 200),
        source: String(i.type ?? "atom"),
      }));
    } catch {
      return [];
    }
  };
}

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

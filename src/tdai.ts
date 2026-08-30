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
        data?: {
          items?: Array<{ id?: unknown; type?: unknown; content?: unknown; score?: unknown }>;
        };
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

export interface TdaiCodeGraphConfig {
  baseUrl: string;
  serviceId: string;
  teamId: string;
  fetchImpl?: typeof fetch;
}

const KS_TIMEOUT_MS = 8000;

export interface CodeGraphEntry {
  name: string;
  kind: string;
  location: string;
}

/**
 * Parse the Knowledge Service search text: entries are
 * `**name** (kind)\npath/to/file.ts:line\n\`signature\``.
 * The `**Search Results (N found)**` header has its count INSIDE the bold text
 * with no trailing ` (kind)`, so the entry pattern cannot match it.
 */
export function parseCodeGraphResults(text: string): CodeGraphEntry[] {
  const entries: CodeGraphEntry[] = [];
  const re = /\*\*(.+?)\*\* \((\w+)\)\n(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const { 1: name, 2: kind, 3: location } = m;
    if (name === undefined || kind === undefined || location === undefined) continue;
    entries.push({ name, kind, location });
  }
  return entries;
}

interface KsGraph {
  code_graph_id: string;
  status?: string;
}

/**
 * Real recall for kind=code_graph: the TDAI Knowledge Service. The team's ready
 * graphs are listed once and cached per recall instance (the runner creates one
 * per session); each is searched with {code_graph_id, query, limit}. The KS search
 * endpoint needs no team_id — only the list does, which is why cfg requires it.
 * Any failure → [] so the observer stays silent.
 */
export function createCodeGraphRecall(cfg: TdaiCodeGraphConfig): TdaiRecallFn {
  const doFetch = cfg.fetchImpl ?? fetch;
  let graphsCache: KsGraph[] | undefined;
  const listGraphs = async (): Promise<KsGraph[]> => {
    if (graphsCache) return graphsCache;
    try {
      const res = await doFetch(`${cfg.baseUrl}/v3/code-graph/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tdai-service-id": cfg.serviceId },
        body: JSON.stringify({ team_id: cfg.teamId }),
        signal: AbortSignal.timeout(KS_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      const envelope = (await res.json()) as { code?: number; data?: { items?: KsGraph[] } };
      if (envelope.code !== 0) return [];
      graphsCache = envelope.data?.items ?? [];
      return graphsCache;
    } catch {
      return [];
    }
  };
  return async (q) => {
    const graphs = await listGraphs();
    const results: TdaiRecallResult[] = [];
    for (const g of graphs) {
      if (results.length >= q.limit) break;
      if (g.status !== undefined && g.status !== "ready") continue;
      try {
        const res = await doFetch(`${cfg.baseUrl}/v3/code-graph/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tdai-service-id": cfg.serviceId },
          body: JSON.stringify({ code_graph_id: g.code_graph_id, query: q.query, limit: q.limit }),
          signal: AbortSignal.timeout(KS_TIMEOUT_MS),
        });
        if (!res.ok) continue;
        const envelope = (await res.json()) as { code?: number; data?: { text?: string } };
        if (envelope.code !== 0) continue;
        for (const e of parseCodeGraphResults(String(envelope.data?.text ?? ""))) {
          if (results.length >= q.limit) break;
          results.push({
            id: `${g.code_graph_id}:${e.location}`,
            score: 1 - results.length * 0.01,
            snippet: `${e.name} (${e.kind}) ${e.location}`,
            source: "code-graph",
          });
        }
      } catch {
        continue;
      }
    }
    return results;
  };
}

export interface TdaiRecallEnv {
  conversationId?: string;
  teamId?: string;
  bridgeBaseUrl?: string;
  bridgeServiceId?: string;
  ksBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Production recall, dispatched by kind: memory via the bridge (needs the host
 * conversation id), code_graph via the Knowledge Service (needs a team id).
 * A kind whose config is missing returns [] — silent, never mock. `mockRecall`
 * stays a test/tool-level default only.
 */
export function createTdaiRecall(env: TdaiRecallEnv): TdaiRecallFn {
  const memoryFn: TdaiRecallFn = env.conversationId
    ? createBridgeRecall({
        baseUrl: env.bridgeBaseUrl ?? "http://127.0.0.1:8096",
        serviceId: env.bridgeServiceId ?? "default",
        conversationId: env.conversationId,
        fetchImpl: env.fetchImpl,
      })
    : async () => [];
  const cgFn: TdaiRecallFn = env.teamId
    ? createCodeGraphRecall({
        baseUrl: env.ksBaseUrl ?? "http://127.0.0.1:8424",
        serviceId: env.bridgeServiceId ?? "default",
        teamId: env.teamId,
        fetchImpl: env.fetchImpl,
      })
    : async () => [];
  return (q) => (q.kind === "memory" ? memoryFn(q) : cgFn(q));
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

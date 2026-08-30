# TDAI memory-bridge wiring (PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mock recall behind `tdai_recall`'s `kind=memory` path with a real call to the TDAI memory-bridge, scoped to the host session's team/agent identity. Resolves the PR-1 review finding (bundled observer depending on mock data). `kind=code_graph` stays mock until PR 3.

**Architecture:** The bridge (`POST {TDAI_PROXY_URL}/memory-bridge/v3/atomic/search`) derives identity from the `x-conversation-id` header, which must match the host pi session's initialized conversation id (`pi-{sessionId}` — same formula as `@nicwn/tencentdb-agent-memory-proxy`). `src/index.ts` reads the session id at `session_start` and threads it through `createObserverRunner` into `createTdaiRecallTool`; `src/tdai.ts` gains `createBridgeRecall(cfg)`. Failures return `[]` — the observer stays silent when TDAI is unreachable or the session isn't initialized, which also keeps one-shot/non-interactive sessions quiet.

**Tech Stack:** TypeScript, Node global `fetch` with `AbortSignal.timeout`, vitest.

**Spec:** Approved fork plan, PR 2 of 4; conversation 2026-08-30 ("OK 2" — build PR 2 immediately, merge with PR 1).

## Global Constraints

- Read-only: the tool only ever POSTs a search.
- No new dependencies.
- Observer sessions not using `tdai_recall` stay byte-identical to upstream.
- `kind=code_graph` still returns mock data (PR 3 wires the Knowledge Service).
- 665+ tests green, typecheck + lint clean.

---

### Task 1: `createBridgeRecall` in `src/tdai.ts`

**Files:**
- Modify: `src/tdai.ts`
- Test: `test/tdai.test.ts`

**Interfaces:**
- Produces: `createBridgeRecall(cfg: { baseUrl: string; serviceId: string; conversationId: string; fetchImpl?: typeof fetch }): TdaiRecallFn`. For `kind=memory` it POSTs `{query, limit}` to `{baseUrl}/memory-bridge/v3/atomic/search` with headers `x-tdai-service-id: cfg.serviceId`, `x-conversation-id: cfg.conversationId`; maps `data.items[]` → `{id, score, snippet (content, ≤200 code points), source (type)}`. For `kind=code_graph` it delegates to `mockRecall` (PR 3). Any failure (network, non-200, `code !== 0`) → `[]`.

- [ ] **Step 1: Failing tests** — append to `test/tdai.test.ts`:

```typescript
describe("createBridgeRecall", () => {
  const ok = (items: unknown[]) =>
    ({ ok: true, status: 200, json: async () => ({ code: 0, data: { items } }) });

  it("POSTs the query with bridge identity headers and maps items", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url, init });
      return ok([
        { id: "m_1", type: "episodic", content: "proxy port moved to 8096", score: 0.8 },
      ]);
    }) as unknown as typeof fetch;
    const recall = createBridgeRecall({
      baseUrl: "http://x:1",
      serviceId: "default",
      conversationId: "pi-s1",
      fetchImpl,
    });
    const results = await recall({ query: "proxy port", kind: "memory", limit: 3 });
    expect(results).toEqual([
      { id: "m_1", score: 0.8, snippet: "proxy port moved to 8096", source: "episodic" },
    ]);
    expect(calls[0].url).toBe("http://x:1/memory-bridge/v3/atomic/search");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-tdai-service-id"]).toBe("default");
    expect(headers["x-conversation-id"]).toBe("pi-s1");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: "proxy port", limit: 3 });
  });

  it("truncates snippets to 200 code points", async () => {
    const long = "x".repeat(300);
    const fetchImpl = (async () =>
      ok([{ id: "m_2", type: "atom", content: long, score: 1 }])) as unknown as typeof fetch;
    const recall = createBridgeRecall({
      baseUrl: "http://x:1", serviceId: "d", conversationId: "c", fetchImpl,
    });
    const results = await recall({ query: "q", kind: "memory", limit: 1 });
    expect(Array.from(results[0].snippet).length).toBeLessThanOrEqual(200);
  });

  it("returns [] on code != 0, non-200, and fetch rejection", async () => {
    const mk = (envelope: unknown, okStatus = true) =>
      (async () => ({ ok: okStatus, status: okStatus ? 200 : 500, json: async () => envelope })) as unknown as typeof fetch;
    const base = { baseUrl: "http://x:1", serviceId: "d", conversationId: "c" };
    const q = { query: "q", kind: "memory" as const, limit: 1 };
    expect(await createBridgeRecall({ ...base, fetchImpl: mk({ code: 40101 }) })(q)).toEqual([]);
    expect(await createBridgeRecall({ ...base, fetchImpl: mk({ code: 0 }, false) })(q)).toEqual([]);
    expect(
      await createBridgeRecall({ ...base, fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch })(q),
    ).toEqual([]);
  });

  it("code_graph still uses mock until PR 3 (no fetch call)", async () => {
    const fetchImpl = vi.fn(async () => ok([])) as unknown as typeof fetch;
    const recall = createBridgeRecall({ baseUrl: "http://x:1", serviceId: "d", conversationId: "c", fetchImpl });
    const results = await recall({ query: "q", kind: "code_graph", limit: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(results[0].source).toBe("code-graph");
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run test/tdai.test.ts` → FAIL (no `createBridgeRecall` export).
- [ ] **Step 3: Implement** in `src/tdai.ts` (above `createTdaiRecallTool`):

```typescript
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
 * the HOST session's conversation (same pi-{sessionId} identity the
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
```

- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat: wire tdai_recall memory path to the TDAI memory-bridge`.

---

### Task 2: Thread the host conversation id through the runner

**Files:**
- Modify: `src/runner.ts` (`CreateRunnerOptions` + recall selection)
- Modify: `src/index.ts` (pass `conversationId` at session_start)
- Test: `test/tdai.test.ts` (runner uses bridge recall when given a conversation id)

**Interfaces:**
- `CreateRunnerOptions` gains `conversationId?: string` and `tdaiRecall?: TdaiRecallFn` (test seam).
- Runner recall selection: `opts.tdaiRecall ?? (opts.conversationId ? createBridgeRecall({ baseUrl: env TDAI_PROXY_URL ?? "http://127.0.0.1:8096", serviceId: env TDAI_SPACE_ID ?? "default", conversationId }) : mockRecall)`.
- `src/index.ts` passes `conversationId: "pi-" + ctx.sessionManager.getSessionId()` (try/catch guarded) to `deps.createRunner`.

- [ ] **Step 1: Failing test** — append to the runner-injection describe:

```typescript
  it("uses the bridge recall when a conversationId is provided", async () => {
    let names: string[] = [];
    const factory = vi.fn(async (opts: { customTools?: Array<{ name: string }> }) => {
      names = opts.customTools?.map((t) => t.name) ?? [];
      return { session: { prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}), dispose: vi.fn() } };
    });
    const runner = await createObserverRunner({
      def: tdaiDef(["tdai_recall"]),
      model,
      cwd: repo,
      agentDir: repo,
      createSession: factory,
      conversationId: "pi-test",
      tdaiRecall: async () => [{ id: "m_x", score: 1, snippet: "s", source: "atom" }],
    });
    expect(names).toContain("tdai_recall");
    // and the injected recall is reachable through the runner's tool
    expect(runner.name).toBe("memory-recall");
  });
```

plus a direct env-default test asserting `createObserverRunner` without `conversationId` still works (mock path) — covered by existing tests.

- [ ] **Step 2: Run** → FAIL (unknown fields on CreateRunnerOptions).
- [ ] **Step 3: Implement.**

`src/runner.ts`:
```typescript
export interface CreateRunnerOptions {
  def: ObserverDefinition;
  model: ModelLike;
  cwd: string;
  agentDir: string;
  /** Injectable for tests. Defaults to the real SDK call. */
  createSession?: SessionFactory;
  /** Host session conversation id (pi-{sessionId}); enables bridge-backed recall. */
  conversationId?: string;
  /** Test seam: overrides the tdai_recall recall fn entirely. */
  tdaiRecall?: TdaiRecallFn;
}
```

In `createObserverRunner`, replace the `tdaiTools` construction:

```typescript
  const recall =
    opts.tdaiRecall ??
    (opts.conversationId
      ? createBridgeRecall({
          baseUrl: process.env.TDAI_PROXY_URL ?? "http://127.0.0.1:8096",
          serviceId: process.env.TDAI_SPACE_ID ?? "default",
          conversationId: opts.conversationId,
        })
      : mockRecall);
  const tdaiTools = def.tools.includes("tdai_recall") ? [createTdaiRecallTool({ recall })] : [];
```

`src/index.ts`, in the `session_start` createRunner call:

```typescript
      const runner = await deps.createRunner({
        def,
        model: resolution.model,
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        conversationId: hostConversationId(ctx),
      });
```

with a guarded helper near `modelLookup`:

```typescript
/** The conversation id the TDAI memory proxy binds this pi session to, if it has one. */
function hostConversationId(ctx: ExtensionContext): string | undefined {
  try {
    const sid = ctx.sessionManager?.getSessionId?.();
    return typeof sid === "string" && sid !== "" ? `pi-${sid}` : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run** `npx vitest run test/tdai.test.ts test/runner.test.ts test/index.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat: thread host conversation id into tdai_recall for bridge-scoped search`.

---

### Task 3: Full gates + live dogfood + ship

- [ ] **Step 1:** `npm test && npm run typecheck && npm run lint` → all green.
- [ ] **Step 2:** Live dogfood in an interactive pi session from the fork checkout: `pi -e ./src/index.ts`, ask something touching team memory, confirm the advisory quotes a real atom id (not `m_mock_1`).
- [ ] **Step 3:** Branch `pr2/tdai-memory-bridge` off `pr1/tdai-recall-scaffold`, push, open stacked PR against `pr1/tdai-recall-scaffold`, titled "PR 2: wire tdai_recall memory path to the TDAI memory-bridge". Both PRs merge together (PR 1 first, PR 2 retargets to main automatically).
- [ ] **Step 4:** Verify roborev reviews the new commits on codex.

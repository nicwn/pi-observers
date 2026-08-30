import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelLike } from "../src/models.ts";
import { createObserverRunner } from "../src/runner.ts";
import {
  createBridgeRecall,
  createTdaiRecallTool,
  mockRecall,
  type TdaiRecallFn,
} from "../src/tdai.ts";
import { isAllowedTool, type ObserverDefinition } from "../src/types.ts";

// biome-ignore lint/suspicious/noExplicitAny: test harness for the tool execute signature
const call = (tool: any, params: unknown) =>
  // biome-ignore lint/suspicious/noExplicitAny: test harness for the tool execute signature
  tool.execute("id", params, undefined, undefined, {} as any);

describe("createTdaiRecallTool", () => {
  it("names the tool tdai_recall", () => {
    const tool = createTdaiRecallTool();
    expect(tool.name).toBe("tdai_recall");
  });

  it("returns JSON results from the injected recall fn", async () => {
    const recall: TdaiRecallFn = vi.fn(async () => [
      { id: "m_1", score: 0.9, snippet: "pi-observers fork in progress", source: "atom" },
    ]);
    const tool = createTdaiRecallTool({ recall });
    const out = await call(tool, { query: "pi observers" });
    const body = JSON.parse(out.content[0].text);
    expect(body).toEqual([
      { id: "m_1", score: 0.9, snippet: "pi-observers fork in progress", source: "atom" },
    ]);
    expect(recall).toHaveBeenCalledWith({ query: "pi observers", kind: "memory", limit: 5 });
  });

  it("passes kind and limit through", async () => {
    const recall: TdaiRecallFn = vi.fn(async () => []);
    const tool = createTdaiRecallTool({ recall });
    await call(tool, { query: "runner", kind: "code_graph", limit: 3 });
    expect(recall).toHaveBeenCalledWith({ query: "runner", kind: "code_graph", limit: 3 });
  });

  it("mockRecall returns canned atom data", async () => {
    const results = await mockRecall({ query: "anything", kind: "memory", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({ source: "atom" });
  });
});

describe("tdai_recall runner injection", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "pi-observers-tdai-"));
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const model = { provider: "test", id: "m", contextWindow: 100000 } as unknown as ModelLike;

  function tdaiDef(tools: string[]): ObserverDefinition {
    return {
      name: "memory-recall",
      description: "d",
      enabled: true,
      on: "turn_end",
      sees: ["last_user_message"],
      tools: tools as ObserverDefinition["tools"],
      can: ["advise"],
      deliver: "next_prompt",
      fallback: [],
      thinking: "low",
      priority: 50,
      maxAdvisoryChars: 300,
      timeoutMs: 20000,
      systemPrompt: "Watch memory.",
      sourcePath: "/o.md",
      scope: "builtin",
    };
  }

  it("tdai_recall is an allowed observer tool", () => {
    expect(isAllowedTool("tdai_recall")).toBe(true);
  });

  it("injects tdai_recall into customTools and the allowlist when requested", async () => {
    let captured: { tools?: string[]; customTools?: Array<{ name: string }> } = {};
    const factory = vi.fn(
      async (opts: { tools?: string[]; customTools?: Array<{ name: string }> }) => {
        captured = { tools: opts.tools, customTools: opts.customTools };
        return {
          session: {
            prompt: vi.fn(async () => {}),
            abort: vi.fn(async () => {}),
            dispose: vi.fn(),
          },
        };
      },
    );
    await createObserverRunner({
      def: tdaiDef(["tdai_recall"]),
      model,
      cwd: repo,
      agentDir: repo,
      createSession: factory,
    });
    expect(captured.customTools?.map((t) => t.name)).toContain("tdai_recall");
    expect(captured.tools).toContain("tdai_recall");
  });

  it("does not inject tdai_recall when not requested", async () => {
    let names: string[] = [];
    const factory = vi.fn(async (opts: { customTools?: Array<{ name: string }> }) => {
      names = opts.customTools?.map((t) => t.name) ?? [];
      return {
        session: { prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}), dispose: vi.fn() },
      };
    });
    await createObserverRunner({
      def: tdaiDef(["read"]),
      model,
      cwd: repo,
      agentDir: repo,
      createSession: factory,
    });
    expect(names).not.toContain("tdai_recall");
  });

  it("passes a bridge recall through to the tool when conversationId is set", async () => {
    const repo2 = mkdtempSync(join(tmpdir(), "pi-observers-tdai2-"));
    let toolsByName = new Map<string, unknown>();
    const factory = vi.fn(async (opts: { customTools?: Array<{ name: string }> }) => {
      toolsByName = new Map((opts.customTools ?? []).map((t) => [t.name, t]));
      return {
        session: { prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}), dispose: vi.fn() },
      };
    });
    const spyRecall = vi.fn(async () => [{ id: "m_x", score: 1, snippet: "s", source: "atom" }]);
    const runner = await createObserverRunner({
      def: tdaiDef(["tdai_recall"]),
      model,
      cwd: repo2,
      agentDir: repo2,
      createSession: factory,
      conversationId: "pi-test",
      tdaiRecall: spyRecall,
    });
    expect(runner.name).toBe("memory-recall");
    // Execute the injected tool: the seam recall must be the one behind it.
    const tdaiTool = toolsByName.get("tdai_recall");
    if (!tdaiTool) throw new Error("tdai_recall not injected");
    const out = await call(tdaiTool, { query: "proxy port" });
    expect(spyRecall).toHaveBeenCalledWith({ query: "proxy port", kind: "memory", limit: 5 });
    expect(JSON.parse(out.content[0].text)).toEqual([
      { id: "m_x", score: 1, snippet: "s", source: "atom" },
    ]);
    rmSync(repo2, { recursive: true, force: true });
  });
});

describe("createBridgeRecall", () => {
  const ok = (items: unknown[]) =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { items } }),
    }) as unknown as Response;

  it("POSTs the query with bridge identity headers and maps items", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return ok([{ id: "m_1", type: "episodic", content: "proxy port moved to 8096", score: 0.8 }]);
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
    expect(calls[0]?.url).toBe("http://x:1/memory-bridge/v3/atomic/search");
    const headers = calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.["x-tdai-service-id"]).toBe("default");
    expect(headers?.["x-conversation-id"]).toBe("pi-s1");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ query: "proxy port", limit: 3 });
  });

  it("truncates snippets to 200 code points", async () => {
    const long = "x".repeat(300);
    const fetchImpl = (async () =>
      ok([{ id: "m_2", type: "atom", content: long, score: 1 }])) as unknown as typeof fetch;
    const recall = createBridgeRecall({
      baseUrl: "http://x:1",
      serviceId: "d",
      conversationId: "c",
      fetchImpl,
    });
    const results = await recall({ query: "q", kind: "memory", limit: 1 });
    const first = results[0];
    if (!first) throw new Error("no result");
    expect(Array.from(first.snippet).length).toBeLessThanOrEqual(200);
  });

  it("returns [] on code != 0, non-200, and fetch rejection", async () => {
    const mk = (envelope: unknown, okStatus = true) =>
      (async () => ({
        ok: okStatus,
        status: okStatus ? 200 : 500,
        json: async () => envelope,
      })) as unknown as typeof fetch;
    const base = { baseUrl: "http://x:1", serviceId: "d", conversationId: "c" };
    const q = { query: "q", kind: "memory" as const, limit: 1 };
    expect(await createBridgeRecall({ ...base, fetchImpl: mk({ code: 40101 }) })(q)).toEqual([]);
    expect(await createBridgeRecall({ ...base, fetchImpl: mk({ code: 0 }, false) })(q)).toEqual([]);
    expect(
      await createBridgeRecall({
        ...base,
        fetchImpl: (async () => {
          throw new Error("down");
        }) as unknown as typeof fetch,
      })(q),
    ).toEqual([]);
  });

  it("code_graph still uses mock until PR 3 (no fetch call)", async () => {
    const fetchImpl = vi.fn(async () => ok([])) as unknown as typeof fetch;
    const recall = createBridgeRecall({
      baseUrl: "http://x:1",
      serviceId: "d",
      conversationId: "c",
      fetchImpl,
    });
    const results = await recall({ query: "q", kind: "code_graph", limit: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    const first = results[0];
    if (!first) throw new Error("no result");
    expect(first.source).toBe("code-graph");
  });
});

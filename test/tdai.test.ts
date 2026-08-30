import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelLike } from "../src/models.ts";
import { createObserverRunner } from "../src/runner.ts";
import { createTdaiRecallTool, mockRecall, type TdaiRecallFn } from "../src/tdai.ts";
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
});

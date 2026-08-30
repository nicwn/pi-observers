import { describe, expect, it, vi } from "vitest";
import { createTdaiRecallTool, mockRecall, type TdaiRecallFn } from "../src/tdai.ts";

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
    const out = await tool.execute("call-1", { query: "pi observers" });
    const body = JSON.parse(out.content[0].text);
    expect(body).toEqual([
      { id: "m_1", score: 0.9, snippet: "pi-observers fork in progress", source: "atom" },
    ]);
    expect(recall).toHaveBeenCalledWith({ query: "pi observers", kind: "memory", limit: 5 });
  });

  it("passes kind and limit through", async () => {
    const recall: TdaiRecallFn = vi.fn(async () => []);
    const tool = createTdaiRecallTool({ recall });
    await tool.execute("call-2", { query: "runner", kind: "code_graph", limit: 3 });
    expect(recall).toHaveBeenCalledWith({ query: "runner", kind: "code_graph", limit: 3 });
  });

  it("mockRecall returns canned atom data", async () => {
    const results = await mockRecall({ query: "anything", kind: "memory", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({ source: "atom" });
  });
});

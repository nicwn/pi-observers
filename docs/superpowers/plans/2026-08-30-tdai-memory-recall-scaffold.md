# TDAI memory-recall scaffold (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bundled flat-file `memory-recall` observer with a TDAI-backed one, and add the `tdai_recall` custom tool scaffold (mock data) that observers can call from inside their nested sessions.

**Architecture:** This fork keeps erans/pi-observers' framework intact. We add one custom tool (`tdai_recall`) defined in `src/tdai.ts`, allow it in `ALLOWED_TOOLS`, inject it into an observer's nested session from `src/runner.ts` when the definition requests it, and rewrite `observers/memory-recall.md` to use it. PR 1 ships the tool with mock recall data; PR 2 wires `kind=memory` to the TDAI memory-bridge (`/memory-bridge/v3/atomic/search`); PR 3 wires `kind=code_graph` to the Knowledge Service (`http://127.0.0.1:8424/v3/code-graph/list` + `/search`).

**Tech Stack:** TypeScript, pi extension API (`defineTool` from `@earendil-works/pi-coding-agent`), typebox, vitest.

**Spec:** The approved fork plan from the 2026-08-30 conversation (tool-fit-review verdict → fork plan → "start PR1"). This plan is PR 1 of 4.

## Global Constraints

- Observers stay read-only: `tdai_recall` must not mutate anything.
- Upstream framework code (`slices.ts`, `reconciler.ts`, `bus.ts`, `models.ts`, `settings.ts`, `commands.ts`, `memory.ts`, `discovery.ts`, `index.ts`) is NOT modified in this PR except `runner.ts` and `types.ts` for tool injection — minimize fork divergence.
- `npm test` (658 tests) must stay green; `npm run typecheck` and `npm run lint` must pass.
- Tool executes against mock data in this PR; the real fetch lands in PR 2/3.
- pi >= 0.83 compatibility retained (no new peer deps).

---

### Task 1: The `tdai_recall` tool scaffold

**Files:**
- Create: `src/tdai.ts`
- Test: `test/tdai.test.ts`

**Interfaces:**
- Produces: `createTdaiRecallTool(deps?: { recall?: TdaiRecallFn })` returning a pi `Tool` named `tdai_recall`; `TdaiRecallFn = (q: { query: string; kind: "memory" | "code_graph"; limit: number }) => Promise<TdaiRecallResult[]>`; `TdaiRecallResult = { id: string; score: number; snippet: string; source: string }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/tdai.test.ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/tdai.test.ts`
Expected: FAIL — `Cannot find module '../src/tdai.ts'`

- [ ] **Step 3: Implement `src/tdai.ts`**

```typescript
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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/tdai.test.ts`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add src/tdai.ts test/tdai.test.ts
git commit -m "feat: add tdai_recall custom tool scaffold (mock recall)"
```

---

### Task 2: Allowlist + runner injection

**Files:**
- Modify: `src/types.ts` (ALLOWED_TOOLS)
- Modify: `src/runner.ts` (inject tdai tools)
- Test: `test/tdai.test.ts` (runner injection describe block)

**Interfaces:**
- Consumes: `createTdaiRecallTool` from Task 1.
- Produces: `ALLOWED_TOOLS` includes `"tdai_recall"`; `createObserverRunner` passes `tdai_recall` into the nested session's `customTools` and allowlist when `def.tools` includes it.

- [ ] **Step 1: Write the failing tests** (append to `test/tdai.test.ts`)

```typescript
// appended imports:
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { createObserverRunner } from "../src/runner.ts";
import { isAllowedTool } from "../src/types.ts";
import type { ObserverDefinition } from "../src/types.ts";
import type { ModelLike } from "../src/models.ts";

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
    const factory = vi.fn(async (opts: { tools?: string[]; customTools?: Array<{ name: string }> }) => {
      captured = { tools: opts.tools, customTools: opts.customTools };
      return { session: { prompt: vi.fn(async () => {}), dispose: vi.fn() } };
    });
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
      return { session: { prompt: vi.fn(async () => {}), dispose: vi.fn() } };
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/tdai.test.ts`
Expected: FAIL — `tdai_recall is an allowed observer tool` fails (isAllowedTool returns false), and injection tests fail (customTools lacks tdai_recall).

- [ ] **Step 3: Implement**

`src/types.ts` — one line:

```typescript
export const ALLOWED_TOOLS = ["read", "grep", "find", "ls", "tdai_recall"] as const;
```

`src/runner.ts` — import the tool and inject. After the `createOutputTools` call:

```typescript
import { createTdaiRecallTool } from "./tdai.ts";
```

```typescript
  const { tools, collector } = createOutputTools(def);
  // Injected only when the definition asks for it: an observer that does not list
  // tdai_recall must not gain a second data source, and the hermetic session stays
  // byte-identical to upstream for every other observer.
  const tdaiTools = def.tools.includes("tdai_recall") ? [createTdaiRecallTool()] : [];
```

and in the `factory({...})` call, extend the two fields:

```typescript
    tools: [...def.tools, ...tools.map((t) => t.name), ...tdaiTools.map((t) => t.name)],
    customTools: [...tools, ...tdaiTools],
```

Also update the `tools:` doc comment above the allowlist to mention `tdai_recall` joining `propose`/`veto` names there.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/tdai.test.ts test/runner.test.ts test/types.test.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/runner.ts test/tdai.test.ts
git commit -m "feat: allow tdai_recall as an observer tool and inject it into nested sessions"
```

---

### Task 3: Replace the bundled memory-recall observer

**Files:**
- Modify: `observers/memory-recall.md` (full rewrite)
- Test: `test/bundled.test.ts` (update the mutating-tool allowlist assertion)

**Interfaces:**
- Consumes: `tdai_recall` tool from Tasks 1-2.
- Produces: bundled `memory-recall` observer backed by `tdai_recall` instead of `.pi/memory/` greps.

- [ ] **Step 1: Update the failing bundled test**

In `test/bundled.test.ts`, the `it("none request a mutating tool")` block hardcodes the four upstream read-only tools. Extend it:

```typescript
  it("none request a mutating tool", () => {
    for (const o of load().observers) {
      for (const tool of o.tools) {
        expect(["read", "grep", "find", "ls", "tdai_recall"]).toContain(tool);
      }
    }
  });
```

Also update the memory-recall deliver/trigger expectations if they change (they do not: `on: turn_end`, `deliver: next_prompt` stay).

- [ ] **Step 2: Rewrite `observers/memory-recall.md`**

```markdown
---
name: memory-recall
description: Surface a TDAI team memory atom relevant to the next reply
enabled: true
on: turn_end
sees: [last_user_message]
tools: [tdai_recall]
can: [advise]
deliver: next_prompt
priority: 40
max_advisory_chars: 300
---
You watch one axis: whether a stored team memory is relevant to what the user
just asked.

Team memory lives in TDAI (the team's memory service), not in local files.
Query it with `tdai_recall`, using a 2-5 word query derived from the user's
request.

Your procedure:
1. Derive a short query from the user's request.
2. Call `tdai_recall` with it.
3. Judge whether any result bears directly on the request.
4. If exactly one does, propose a single sentence stating the salient fact and
   the result's id.

Propose only for a memory that would change what the agent does. A result that
is merely topically adjacent is not worth interrupting for. When in doubt, stay
silent.
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run test/bundled.test.ts`
Expected: PASS (all four observers parse; memory-recall uses tdai_recall)

- [ ] **Step 4: Run the full suite + gates**

Run: `npm test && npm run typecheck && npm run lint`
Expected: 658+ tests pass, typecheck clean, lint clean.

- [ ] **Step 5: Commit**

```bash
git add observers/memory-recall.md test/bundled.test.ts
git commit -m "feat: replace memory-recall with TDAI-backed observer"
```

---

### Task 4: Rebrand, verify, ship

**Files:**
- Modify: `package.json` (name → `pi-observers-tdai`)
- Modify: `README.md` (fork note at top)

- [ ] **Step 1: Rebrand**

`package.json`: `"name": "pi-observers-tdai"`. Keep version `0.1.3`, add `"forkOf": "erans/pi-observers"` is NOT a real npm field — skip it; the README note carries provenance.

`README.md`: insert after the title:

```markdown
> **Fork:** `nicwn/pi-observers-tdai` — Eran's pi-observers with TDAI-backed
> observers. `memory-recall` queries the team's TDAI memory via the `tdai_recall`
> tool instead of `.pi/memory/` files. Upstream: `erans/pi-observers`.
```

- [ ] **Step 2: Full gate**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 3: Dogfood smoke test**

Run: `pi -e ./src/index.ts` in the repo, then in that session run `/observers` and confirm `memory-recall` shows as active with the session model (mock tool needs no network).

- [ ] **Step 4: Commit, push, PR**

```bash
git add package.json README.md
git commit -m "chore: rebrand fork as pi-observers-tdai"
git push -u origin pr1/tdai-recall-scaffold
```

Open PR: `nicwn/pi-observers` `pr1/tdai-recall-scaffold` → `main`, titled "PR 1: TDAI memory-recall scaffold (mock tdai_recall)".

- [ ] **Step 5: roborev review**

```bash
roborev init && roborev install-hook
```

Confirm the daemon enqueues reviews on the PR commits and they run on codex (`default_agent=codex`, `default_model=gpt-5.4`).

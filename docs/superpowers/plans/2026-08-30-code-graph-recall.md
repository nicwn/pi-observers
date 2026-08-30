# Team code-graph recall (PR 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bundled `code-graph-recall` observer and wire `tdai_recall`'s `kind=code_graph` path to the TDAI Knowledge Service (`:8424`), replacing the mock.

**Architecture:** `createCodeGraphRecall(cfg)` lists the team's ready code graphs once (cached per recall instance) via `POST /v3/code-graph/list` (needs `team_id` from `TDAI_TEAM_ID` env — the same convention the memory-proxy extension uses for non-interactive session-init), then searches each via `POST /v3/code-graph/search` (`{code_graph_id, query, limit}`, no team_id needed), parsing the `**name** (kind)\nfile:line` entries from `data.text`. A composite `createTdaiRecall(env)` dispatches by kind: memory → bridge (conversation id), code_graph → KS (team id). Missing config for a kind → `[]` (silent), never mock. `mockRecall` remains only as a test/tool-level default.

**Tech Stack:** TypeScript, Node fetch, vitest.

**Spec:** Approved fork plan, PR 3 of 4. Verified live: list/get/search on `127.0.0.1:8424` work; search accepts `limit`; response text format `**Search Results (N found)**` + `**name** (kind)\npath:line\n\`sig\``.

## Global Constraints

- Read-only. No new deps. 670+ tests green, typecheck + lint clean.
- Production recall never returns mock data; unavailable config → `[]`.
- Upstream framework files untouched except `runner.ts` (recall selection) and `observers/` (new file).

---

### Task 1: `createCodeGraphRecall` + `parseCodeGraphResults` + composite `createTdaiRecall` (src/tdai.ts)

- [ ] Failing tests (`test/tdai.test.ts`):
  - `parseCodeGraphResults` parses `**name** (kind)\nfile:line` entries and skips the `**Search Results (N found)**` header.
  - `createCodeGraphRecall` lists once then caches across searches; searches each ready graph with `{code_graph_id, query, limit}` + `x-tdai-service-id`; maps entries to `{id: graphId:location, snippet: "name (kind) location", source: "code-graph"}`; skips non-ready graphs; list/search/network failure → `[]`; respects `q.limit` across graphs.
  - `createTdaiRecall({conversationId})` routes memory queries to the bridge (spy) and code_graph queries to KS (spy); missing `teamId` → code_graph `[]`; missing `conversationId` → memory `[]`.
- [ ] Implement (code in plan body: regex `/\*\*(.+?)\*\* \((\w+)\)\n(\S+)/g`; 8s timeouts; per-instance graphs cache).
- [ ] `npx vitest run test/tdai.test.ts` → PASS. Commit.

### Task 2: Runner uses the composite; new bundled observer

- [ ] `src/runner.ts`: recall selection becomes `opts.tdaiRecall ?? createTdaiRecall({ conversationId: opts.conversationId, teamId: process.env.TDAI_TEAM_ID, bridgeBaseUrl: process.env.TDAI_PROXY_URL, ksBaseUrl: process.env.TDAI_KNOWLEDGE_URL, bridgeServiceId: process.env.TDAI_SPACE_ID })`.
- [ ] `observers/code-graph-recall.md` — `on: before_agent_start`, `sees: [last_user_message]`, `tools: [tdai_recall]`, `can: [advise]`, `deliver: next_prompt`, priority 45, max 250 chars; prompt derives symbol/module names from the request, calls `tdai_recall` with `kind=code_graph`, proposes only when a hit would change the approach.
- [ ] Update `test/bundled.test.ts`: names list, enabled state, trigger expectations. README bundled-observers table + `TDAI_TEAM_ID` env doc.
- [ ] Full gates: `npm test && npm run typecheck && npm run lint`.

### Task 3: Live smoke + ship

- [ ] Live smoke with the running KS: `createCodeGraphRecall` with `team-azqo3jvm25` returns real symbols from `cg-te68nxhq` (e.g. `skill-core.ts:503`), no mock ids.
- [ ] Branch `pr3/code-graph-recall` off `main`, push, PR titled "PR 3: code-graph-recall observer wired to the Knowledge Service".
- [ ] Verify roborev reviews on codex.

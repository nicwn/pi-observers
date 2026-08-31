# pi-observers-tdai — Status & Handoff

**Date frozen:** 2026-08-30 · **State:** work paused by Nick ("I still don't feel certain we are doing this right")

## Origin

Nick shared `erans/pi-observers` (Muse Code-inspired background observer agents for pi) from
his AGI group chat. A tool-fit-review verdict: ADOPT-IF — adopt the framework, replace
flat-file `memory-recall` with a TDAI-backed one. Approved plan: fork + customize in 4 PRs.
PRs 1–3 were built and merged; PR 4 (install/config) was applied to Nick's machine; work
stopped before the open items below were resolved.

## What is merged on `nicwn/pi-observers` main

| PR | Content | State |
|---|---|---|
| #1 | `tdai_recall` custom tool scaffold; `memory-recall` observer rewritten for TDAI; `ALLOWED_TOOLS` + conditional runner injection (other observers stay byte-identical to upstream) | merged |
| #2 | `createBridgeRecall`: real `POST {TDAI_PROXY_URL}/memory-bridge/v3/atomic/search`, scoped by host session `pi-{sessionId}` (same identity formula as `@nicwn/tencentdb-agent-memory-proxy`); failures → `[]` (silent, never noise) | merged |
| #3 | `code-graph-recall` observer + `createCodeGraphRecall`: KS `/v3/code-graph/list` (cached) + `/search`, entry parsing; composite `createTdaiRecall` (memory→bridge, code_graph→KS, unconfigured kind → `[]`, never mock) | merged |

- 677 tests green (658 upstream + 19 fork), typecheck + biome clean.
- Every commit reviewed by roborev (codex). PR-3 review findings were fixed and the fix
  commit came back "No issues found."
- Live-verified against the running stack: real bridge atoms (top hit for "pi observers
  adoption" was the memory of deciding to fork) and real `cg-te68nxhq` symbols.
- Plan docs: `docs/superpowers/plans/2026-08-30-*.md` (3 files, one per PR).
- roborev is initialized in the repo (post-commit hook, codex via `default_agent=codex`,
  `default_model=gpt-5.4` pinned globally on 2026-08-30).

## Machine config applied during PR 4 (Nick's box)

1. `pi install git:github.com/nicwn/pi-observers` (fork installed as package)
2. `~/.pi/agent/settings.json` gained:
   `"observers": { "enabled": true, "defaultModel": "tdai/glm-5.2-vision", "maxAdvisoriesPerTurn": 2, "vetoBudget": 3 }`
3. `~/.pi/agent/observers/verification.md` — user-layer copy of bundled `verification`
   with `enabled: true`.

**Cleanup needed when going back to stock `pi-observers`:**
- Uninstall fork (`pi uninstall git:github.com/nicwn/pi-observers`), install `npm:pi-observers`.
- **Delete `~/.pi/agent/observers/verification.md`** — it will produce the same
  "user layer overrides builtin" discovery error against stock (upstream treats any
  cross-layer name override as a loud error, even though the override takes effect).
- The settings block is stock-compatible and optional; `defaultModel: tdai/glm-5.2-vision`
  keeps observers cheap, or remove the block for pristine stock defaults.
- `TDAI_TEAM_ID` was never set anywhere (deliberately — see below).

## Open items (why work stopped)

### 1. verification observer "override" error
Surfaced at session start: `Error: observer "verification" from user layer overrides builtin`.
Cause: the PR-4 user-layer shadow file. Agreed fix (not applied): delete the user-layer
file and flip bundled `observers/verification.md` to `enabled: true` in our fork — one
commit. Cosmetic; the observer worked despite the error.

### 2. code-graph-recall needs team_id — the design question we didn't settle
- KS `code-graph/list` requires `team_id`; `search` does not (id-scoped). The fork has no
  legitimate runtime source for team_id today, so `code-graph-recall` is **silent by design**.
- **Rejected:** `TDAI_TEAM_ID` env var. Nick's memory-proxy extension consumes that var to
  skip the interactive team/agent/task picker (non-interactive session-init), so hardcoding
  it would pin every new pi session to one team and break per-session selection.
- **Proposed but not pursued:** a generic `POST /memory-bridge/v3/session/info` endpoint in
  TencentDB-Agent-Memory's MemoryProxy (bridge-local subpath returning the resolved
  `{user_id, team_id, agent_id, task_id, ...}` for a conversation id; no `user_key`; reuses
  `deriveSessionId` + `loadSessionIdsL1/L2`). Nick's constraint: MemoryProxy is Tencent's
  codebase — any change must be an upstream contribution, and it must be a **generic
  plugin/introspection point** useful beyond pi-observers (e.g. any client wanting
  team-scoped Knowledge Service lookups), not a one-off for this extension. Nick was not
  yet certain the design was right, so this was dropped rather than forced.

### 3. Unverifiable interactively from the agent session
One-shot `pi -p` sessions abort observer runs at shutdown (documented upstream limitation),
so the final "observer advisory appears in a live interactive session" dogfood was never
observed by Nick directly. All other layers were verified (unit, integration tests,
live recall smokes against both backends, clean package load in a live session).

## Facts established during the investigation (keep)

- This machine (Mira) is `192.168.8.23` and hosts the authoritative TDAI stack
  (memory-core `:8420`, memory-hub panel `:8125` + Knowledge Service `:8424`, proxy `:8096`).
  `192.168.8.68` runs a second, empty TDAI stack (Nick's fresh-install pi-extension testing
  target — not to be confused with the real one; earlier "empty list" confusion came from
  probing it by mistake).
- KS conversation scope: identity comes from the proxy session store keyed by
  `pi-{sessionId}`; the picker (Nick's extension) is the only writer.
- KS code graphs on the real stack: `cg-te68nxhq` (TencentDB-Agent-Memory upstream v2,
  13,804 nodes) and `cg-g8qggddf` (pipa-jarvis), both `status=ready`, team
  `team-azqo3jvm25`. Wiki: `wiki-58pbxedw` (Homelab Runbook, 68 pages).
- Stock TDAI KS API: `POST /v3/code-graph/{list,get,search,node,callers,callees,files,impact,explore,status}`,
  `POST /v3/wiki/{list,get,search,...}` on `:8424`; list needs `team_id`, get/search are
  id-scoped; `search` accepts `limit`; response `data.text` with `**name** (kind)\nfile:line` entries.
- memory-bridge allowlist: `atomic/{search,query}`, `conversation/{search,query}`,
  `scenario/{ls,read}` — nothing exposes session identity today.

## How to resume

- Fork: `git clone git@github.com:nicwn/pi-observers.git` — everything is on `main`.
- If pursuing the upstream `session/info` idea: start from the sketch in this doc +
  the bridge source at `~/TencentDB-Agent-Memory-v2/MemoryProxy/src/memory/memory-bridge.ts`
  (identity resolution already exists at `loadSessionIdsL1/L2`); frame it as generic
  session introspection, not an pi-observers feature.
- If abandoning: the fork can be deleted; the only trace on Nick's machine is listed under
  "Machine config applied" above.

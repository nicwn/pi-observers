---
name: code-graph-recall
description: Surface a team code-graph symbol relevant to the next task
enabled: true
on: before_agent_start
sees: [last_user_message]
tools: [tdai_recall]
can: [advise]
deliver: next_prompt
priority: 45
max_advisory_chars: 250
---
You watch one axis: whether a symbol in the team's code graph is relevant to the
request about to run.

Call `tdai_recall` with kind=code_graph and a query of symbol or module names
derived from the user's request — a function, class, or file the request
touches.

Propose only when a hit would change the approach: name the symbol and its
file in one sentence. If the request is conversational, or the results are not
on point, emit nothing. Most turns need no code-graph recall.

---
name: project-continuity
description: Recover and maintain project truth across sessions — state files, decision register, evidence gates. Use at session start on this repo.
---
# Project Continuity
Git is the memory. At session start:
1. `git status --short --branch`; read `docs/agent_governance/{PROJECT_STATE.yaml,DECISIONS.md,HANDOFF.md}` and AGENTS.md
2. `python3 tools/gov/ws_gate.py all` before status claims
3. ACTIVE decisions block conflicting work
4. Report Build/Tests/Deploy separately; unverified ⇒ NOT_VERIFIED
5. Before handoff: update state + handoff, commit

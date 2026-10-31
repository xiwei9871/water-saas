#!/usr/bin/env python3
"""Emit hookSpecificOutput.additionalContext JSON for SessionStart/PostCompaction."""
import json, os, re, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STATE = os.path.join(ROOT, "docs/agent_governance/PROJECT_STATE.yaml")
KEEP = re.compile(r"^(version|phase|branch|head_commit|human_gate|next_safe_action|forbidden_next|device_tests|build|host_tests)\s*:")
def sh(*a):
    return subprocess.run(a, cwd=ROOT, capture_output=True, text=True).stdout.strip()
lines = [f"[continuity] {os.path.basename(ROOT)} @ {sh('git','rev-parse','--abbrev-ref','HEAD')} {sh('git','rev-parse','--short','HEAD')}"]
dirty = len([l for l in sh("git", "status", "--porcelain").splitlines() if l.strip()])
if dirty: lines.append(f"[continuity] {dirty} uncommitted change(s)")
if os.path.exists(STATE):
    for ln in open(STATE):
        if KEEP.match(ln.strip()): lines.append("[state] " + ln.strip())
lines.append("[continuity] read docs/agent_governance/{PROJECT_STATE.yaml,DECISIONS.md,HANDOFF.md} before acting")
out = {"hookSpecificOutput": {"hookEventName": sys.argv[1] if len(sys.argv) > 1 else "SessionStart",
                              "additionalContext": "\n".join(lines)}}
print(json.dumps(out))

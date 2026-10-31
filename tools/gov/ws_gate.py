#!/usr/bin/env python3
"""Governance gates for water-saas — read-only."""
import os, re, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STATE = os.path.join(ROOT, "docs/agent_governance/PROJECT_STATE.yaml")
REJECTED = [
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "D02 secrets committed"),
]
def _skip(rel):
    parts = rel.split("/")
    return any(p in ("node_modules", ".git", ".venv", "venv", "__pycache__", ".worktrees", "dist", "build") for p in parts) or rel.startswith(("tools/gov", "docs/agent_governance", "outputs"))

def sh(*a):
    return subprocess.run(a, cwd=ROOT, capture_output=True, text=True).stdout.strip()

def gate_state_head():
    txt = open(STATE).read() if os.path.exists(STATE) else ""
    m = re.search(r"head_commit:\s*([0-9a-f]{7,40})", txt)
    rec = m.group(1) if m else None
    head = sh("git", "rev-parse", "--short", "HEAD")
    cur = sh("git", "rev-parse", "--abbrev-ref", "HEAD")
    if not rec: return [("state-head", "FAIL", "no recorded head_commit")]
    if head.startswith(rec): return [("state-head", "PASS", f"on baseline {rec[:7]}")]
    base = sh("git", "rev-parse", "--short", "merge-base", "HEAD", rec) if sh("git","merge-base","HEAD",rec) else ""
    if base.startswith(rec) or rec.startswith(base):
        ok = cur.startswith("chore/")
        return [("state-head", "PASS" if ok else "FAIL", f"descendant on {cur}")]
    return [("state-head", "FAIL", "diverged from baseline")]

def gate_workspace():
    n = len([l for l in sh("git", "status", "--porcelain").splitlines() if l.strip()])
    return [("state-workspace", "PASS", "clean" if not n else f"{n} uncommitted — commit before handoff")]

def gate_decisions():
    hits = []
    for dp, _d, fs in os.walk(ROOT):
        for fn in fs:
            rel = os.path.relpath(os.path.join(dp, fn), ROOT)
            if _skip(rel): continue
            try:
                if os.path.getsize(os.path.join(dp, fn)) > 2_000_000: continue
            except OSError: continue
            try: txt = open(os.path.join(dp, fn), errors="ignore").read()
            except OSError: continue
            for pat, label in REJECTED:
                if re.search(pat, txt): hits.append(f"{rel}: {label}")
    return [("assets-decisions", "FAIL" if hits else "PASS",
             "; ".join(hits[:5]) if hits else "no rejected patterns")]

def gate_report():
    return [("report", "NOT_VERIFIED", "evidence-first: record verified build/test/deploy evidence in state")]

def gate_deploy():
    return [("deploy-auth", "BLOCKED", "deploy/termination/prod actions require explicit human authorization")]

def self_test():
    return [("T01 report NOT_VERIFIED", gate_report()[0][1] == "NOT_VERIFIED"),
            ("T02 deploy blocked", gate_deploy()[0][1] == "BLOCKED"),
            ("T03 decisions runnable", len(gate_decisions()) == 1)]

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    rows = {"all": gate_state_head() + gate_workspace() + gate_decisions(),
            "report": gate_report(), "deploy": gate_deploy(),
            "self-test": [("self-test", "PASS" if ok else "FAIL", n) for n, ok in self_test()]}.get(cmd)
    if rows is None: print(__doc__); return 2
    for n, s, d in rows: print(f"{s:4s}  {n:20s} {d}")
    return 0 if all(s != "FAIL" for _n, s, _d in rows) else 1

if __name__ == "__main__":
    sys.exit(main())

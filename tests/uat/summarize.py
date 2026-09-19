"""Summarize every attempt without hiding flaky first failures."""
import base64
import json
import re
import shutil
from pathlib import Path

root = Path("artifacts/uat")
report = json.loads((root / "results.json").read_text())
rows = []
evidence = root / "evidence"
evidence.mkdir(exist_ok=True)
events = []
index = []

def walk(suite):
    for spec in suite.get("specs", []):
        for test in spec.get("tests", []):
            slug = Path(spec["file"]).stem.replace(".spec", "") + "-" + re.sub(r"[^\w-]+", "-", spec["title"]).strip("-")
            for result in test.get("results", []):
                for attachment in result.get("attachments", []):
                    ext = {"application/json": ".json", "image/png": ".png", "text/plain": ".txt"}.get(attachment["contentType"])
                    if not ext or attachment["name"] == "visible-ui":
                        continue
                    dest = evidence / (slug + "-attempt" + str(result["retry"]) + "-" + attachment["name"] + ext)
                    if "body" in attachment:
                        dest.write_bytes(base64.b64decode(attachment["body"]))
                    elif "path" in attachment:
                        shutil.copy(attachment["path"], dest)
                    else:
                        continue
                    index.append({"test": spec["title"], "retry": result["retry"], "name": attachment["name"], "path": str(dest)})
                    if attachment["name"] == "browser-network":
                        events.extend(json.loads(dest.read_text()))
            rows.append({"title": spec["title"], "file": spec["file"], "status": test["status"],
                         "attempts": [{"retry": r["retry"], "status": r["status"],
                                       "errors": [e.get("message", "") for e in r.get("errors", [])]}
                                      for r in test.get("results", [])]})
    for child in suite.get("suites", []):
        walk(child)

for suite in report["suites"]:
    walk(suite)
summary = {"automated": len(rows), "passed": sum(r["status"] == "expected" for r in rows),
           "failed": sum(r["status"] == "unexpected" for r in rows),
           "blocked": sum(r["status"] == "skipped" for r in rows),
           "flaky": sum(r["status"] == "flaky" for r in rows), "tests": rows}
(root / "attempt-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
print(json.dumps({k: v for k, v in summary.items() if k != "tests"}, indent=2))
for row in rows:
    if row["status"] != "expected":
        print(row["status"], row["title"], [(a["retry"], a["status"]) for a in row["attempts"]])

(root / "evidence-index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2))
network = {kind: sum(e["kind"] == kind for e in events) for kind in sorted({e["kind"] for e in events})}
(root / "network-summary.json").write_text(json.dumps(network, indent=2))
print("Network events (including retries and expected 403 console messages):", network)

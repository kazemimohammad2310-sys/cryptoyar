"""Dispatch one cloud cycle for the freshly-pushed merge and wait for its result.

Usage: python3 scripts/gh-verify-update.py <token> <expected_head_sha>
"""
import json
import sys
import time
import urllib.request

REPO = "kazemimohammad2310-sys/cryptoyar"


def api(path: str, token: str, method: str = "GET", body: bytes | None = None):
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "cryptoyar-sync",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def main() -> int:
    token = sys.argv[1]
    expected = sys.argv[2]

    runs = api(f"/repos/{REPO}/actions/runs?per_page=10", token)
    for r in runs["workflow_runs"]:
        print("PAST", r["created_at"], r["event"], r["status"], r["conclusion"], r["head_sha"][:12])

    code = api(
        f"/repos/{REPO}/actions/workflows/cycle.yml/dispatches",
        token,
        method="POST",
        body=b'{"ref":"main"}',
    )
    print("DISPATCH_OK" if code is None else "DISPATCH_RESP", flush=True)

    deadline = time.time() + 540
    while time.time() < deadline:
        time.sleep(20)
        runs = api(f"/repos/{REPO}/actions/runs?per_page=10", token)
        mine = [
            r
            for r in runs["workflow_runs"]
            if r["head_sha"].startswith(expected)
        ]
        done = [r for r in mine if r["status"] == "completed"]
        pending = [r for r in mine if r["status"] != "completed"]
        print(
            f"POLL mine={len(mine)} pending={len(pending)} "
            + " ".join(f"{r['event']}:{r['status']}:{r['conclusion']}" for r in mine[:3]),
            flush=True,
        )
        if done:
            r = done[0]
            print("RESULT", r["conclusion"], r["html_url"])
            return 0 if r["conclusion"] == "success" else 1
    print("TIMEOUT")
    return 2


if __name__ == "__main__":
    sys.exit(main())

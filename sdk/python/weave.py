"""Weave Python client (standard library only).

    from weave import Weave
    w = Weave("https://weave.example.com", token="wv_...")
    s = w.open(goal="fix the bug", intent=["src/a.py"])
    w.write(s["id"], "src/a.py", new_content)
    print(w.submit(s["id"])["status"])
"""
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional


class WeaveError(Exception):
    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


class Weave:
    def __init__(self, url: str, token: Optional[str] = None, repo: str = "default", timeout: float = 60.0):
        self.url = url.rstrip("/")
        self.token = token
        self.repo = repo
        self.timeout = timeout

    def request(self, method: str, path: str, body: Any = None) -> Any:
        sep = "&" if "?" in path else "?"
        url = f"{self.url}/api/{path}{sep}repo={urllib.parse.quote(self.repo)}"
        headers = {"content-type": "application/json"}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        # omit None fields: absent means "use the default", and nulls would be read as explicit values by stricter servers
        clean = {k: v for k, v in (body or {}).items() if v is not None} if isinstance(body, dict) else (body or {})
        data = json.dumps(clean).encode() if method == "POST" else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                text = r.read().decode()
        except urllib.error.HTTPError as e:
            text = e.read().decode()
            try:
                msg = json.loads(text).get("error", text)
            except ValueError:
                msg = text
            raise WeaveError(msg, e.code) from None
        return json.loads(text) if text else {}

    # trunk
    def status(self): return self.request("GET", "status")
    def files(self): return self.request("GET", "trunk/files")["files"]
    def read_trunk(self, path: str): return self.request("GET", "trunk/file?path=" + urllib.parse.quote(path))["content"]
    # tasks, notifications, tags, releases
    def create_task(self, title: str, body: str = "", labels=None, priority: str = "normal", depends_on=None): return self.request("POST", "tasks", {"title": title, "body": body, "labels": labels or [], "priority": priority, "dependsOn": depends_on or []})
    def tasks(self, status: Optional[str] = None, label: Optional[str] = None, q: Optional[str] = None):
        params = {k: v for k, v in {"status": status, "label": label, "q": q}.items() if v}
        return self.request("GET", "tasks" + ("?" + urllib.parse.urlencode(params) if params else ""))
    def next_task(self, labels=None): return self.request("GET", "tasks/next" + ("?labels=" + ",".join(labels) if labels else ""))["task"]
    def task(self, n: int): return self.request("GET", f"tasks/{n}")
    def claim_task(self, n: int, lease_sec: Optional[int] = None): return self.request("POST", f"tasks/{n}/claim", {"leaseSec": lease_sec} if lease_sec else {})
    def heartbeat_task(self, n: int, lease_sec: Optional[int] = None): return self.request("POST", f"tasks/{n}/heartbeat", {"leaseSec": lease_sec} if lease_sec else {})
    def release_task(self, n: int): return self.request("POST", f"tasks/{n}/release", {})
    def close_task(self, n: int): return self.request("POST", f"tasks/{n}/close", {})
    def comment_task(self, n: int, body: str): return self.request("POST", f"tasks/{n}/comment", {"body": body})
    def notifications(self, unread: bool = False): return self.request("GET", "notifications" + ("?unread=1" if unread else ""))
    def mark_read(self, ids=None, all: bool = False): return self.request("POST", "notifications/read", {"ids": ids, "all": all})
    def tag(self, name: str, rev: Optional[int] = None, message: str = ""): return self.request("POST", "tags", {"name": name, "rev": rev, "message": message})
    def tags(self): return self.request("GET", "tags")
    def release(self, tag: str, title: str = "", notes: str = "", prerelease: bool = False): return self.request("POST", "releases", {"tag": tag, "title": title or tag, "notes": notes, "prerelease": prerelease})
    def claim_review(self, session: str, lease_sec: Optional[int] = None): return self.request("POST", f"sessions/{session}/claim-review", {"leaseSec": lease_sec} if lease_sec else {})
    def history(self, limit: int = 20): return self.request("GET", f"commits?limit={limit}")
    def provenance(self, rev: int): return self.request("GET", f"provenance/{rev}")

    # sessions
    def open(self, goal: str, intent=None, id: Optional[str] = None, model: Optional[str] = None, base_rev: Optional[int] = None, task: Optional[int] = None) -> dict:
        return self.request("POST", "sessions", {"goal": goal, "intent": intent or [], "id": id, "model": model, "baseRev": base_rev, "taskNumber": task})["session"]
    def read(self, sid: str, path: str): return self.request("GET", f"sessions/{sid}/file?path=" + urllib.parse.quote(path))["content"]
    def write(self, sid: str, path: str, content: Optional[str], based_on: Optional[int] = None):
        return self.request("POST", f"sessions/{sid}/file", {"path": path, "content": content, "basedOn": based_on})
    def declare(self, sid: str, paths): return self.request("POST", f"sessions/{sid}/intent", {"paths": paths})
    def preview(self, sid: str): return self.request("GET", f"sessions/{sid}/preview")
    def submit(self, sid: str, message: Optional[str] = None): return self.request("POST", f"sessions/{sid}/submit", {"message": message})
    def session(self, sid: str): return self.request("GET", f"sessions/{sid}")
    def resolve(self, sid: str, path: str, how="ours"):
        body = {"path": path, "choices": how} if isinstance(how, list) else {"path": path, "how": how}
        return self.request("POST", f"sessions/{sid}/resolve", body)
    def rerun_checks(self, sid: str): return self.request("POST", f"sessions/{sid}/rerun")
    def abandon(self, sid: str): return self.request("POST", f"sessions/{sid}/abandon")

    # review & verification
    def review_queue(self): return self.request("GET", "review/queue")
    def review_pack(self, sid: str): return self.request("GET", f"sessions/{sid}/review-pack")
    def review(self, sid: str, approve: bool, note: Optional[str] = None): return self.request("POST", f"sessions/{sid}/review", {"approve": approve, "note": note})
    def verify(self, sid: str, passed: bool, note: Optional[str] = None): return self.request("POST", f"sessions/{sid}/verify", {"passed": passed, "note": note})
    def comment(self, sid: str, path: str, line: int, body: str = "", suggestion: Optional[str] = None, blocking: bool = False):
        return self.request("POST", f"sessions/{sid}/comments", {"path": path, "line": line, "body": body, "suggestion": suggestion, "blocking": blocking})

    # admin
    def create_identity(self, name: str, kind: str = "agent", **kw): return self.request("POST", "identities", {"name": name, "kind": kind, **kw})
    def configure(self, **cfg): return self.request("POST", "config", cfg)

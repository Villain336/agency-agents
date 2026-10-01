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
        data = json.dumps(body if body is not None else {}).encode() if method == "POST" else None
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
    def history(self, limit: int = 20): return self.request("GET", f"commits?limit={limit}")
    def provenance(self, rev: int): return self.request("GET", f"provenance/{rev}")

    # sessions
    def open(self, goal: str, intent=None, id: Optional[str] = None, model: Optional[str] = None) -> dict:
        return self.request("POST", "sessions", {"goal": goal, "intent": intent or [], "id": id, "model": model})["session"]
    def read(self, sid: str, path: str): return self.request("GET", f"sessions/{sid}/file?path=" + urllib.parse.quote(path))["content"]
    def write(self, sid: str, path: str, content: Optional[str]): return self.request("POST", f"sessions/{sid}/file", {"path": path, "content": content})
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

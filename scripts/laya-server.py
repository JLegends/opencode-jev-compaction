#!/usr/bin/env python3
"""A TypeSafe-Jev-compatible HTTP server backed by local Laya (MLX, Apple Silicon).

Laya is the open-weight System-1 decision model, and its response shape is already the
Jev one (`answers[name].noul`), so this is a thin transport: it exists only so the
opencode plugin can speak HTTP to a local process instead of a paid API.

    python laya-server.py                     # 127.0.0.1:8000, multilingual checkpoint
    LAYA_PORT=8010 python laya-server.py
    LAYA_SUBFOLDER=typed-decisions python laya-server.py

Endpoints:
    POST /v1/systemone   {model, state, questions} -> {model, answers, usage}
    GET  /v1/models      [{id, object}]

First start downloads the checkpoint (a few hundred MB) into the Hugging Face cache.

Requirements: Python 3.11+, Apple Silicon, `pip install laya-mlx`.
"""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("LAYA_HOST", "127.0.0.1")
PORT = int(os.environ.get("LAYA_PORT", "8000"))
REPO = os.environ.get("LAYA_REPO", "convaiinnovations/laya")
SUBFOLDER = os.environ.get("LAYA_SUBFOLDER", "multilingual")

_lock = threading.Lock()
_agent = None


def load():
    global _agent
    import laya_mlx as laya

    print(f"[laya] loading {REPO} (subfolder={SUBFOLDER}) ...", flush=True)
    # load() is called without a subfolder when it would be redundant, so a locally
    # exported checkpoint can be pointed at with LAYA_REPO=/path/to/model.
    try:
        _agent = laya.load(REPO, subfolder=SUBFOLDER)
    except TypeError:
        _agent = laya.load(REPO)
    print("[laya] ready", flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # keep the console readable
        return

    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            return self._send(200, {"object": "list", "data": [{"id": "laya", "object": "model"}]})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") not in ("/v1/systemone", "/systemone"):
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception as error:
            return self._send(400, {"error": f"bad request: {error}"})

        state = body.get("state")
        questions = body.get("questions")
        if not isinstance(questions, dict) or not questions:
            return self._send(400, {"error": "questions must be a non-empty object"})

        try:
            # One model instance, one inference at a time: MLX is not reliably reentrant.
            with _lock:
                result = _agent.system_one(state, questions)
        except Exception as error:
            return self._send(500, {"error": f"{type(error).__name__}: {error}"})

        return self._send(200, result)


def main():
    try:
        load()
    except ImportError:
        print("[laya] laya-mlx is not installed. pip install laya-mlx", file=sys.stderr)
        sys.exit(2)
    except Exception as error:
        print(f"[laya] failed to load: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(2)

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[laya] listening on http://{HOST}:{PORT}/v1/systemone", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[laya] stopping", flush=True)
        server.server_close()


if __name__ == "__main__":
    main()

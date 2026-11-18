#!/usr/bin/env python3
"""aiRoute gateway for Homie‑Gang‑Leader.
Provides two HTTP endpoints:
* POST /v1/infer – validates a Firebase JWT (stub), forwards payload to Litellm (stub), updates usage.
* POST /v1/worker – runs a short‑lived Podman container (or mock) based on a job description.
"""

import json, os, sys, subprocess, shutil
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

# ---------- Config (environment variables) ----------
FIREBASE_PROJECT = os.getenv("FIREBASE_PROJECT", "your-firebase-id")
LITELLM_ENDPOINT = os.getenv("LITELLM_ENDPOINT", "https://litellm.example.com/v1/completions")
LITELLM_API_KEY = os.getenv("LITELLM_API_KEY", "<litellm-api-key>")
# Config for mock mode (useful in CI)
MOCK_PODMAN = os.getenv('MOCK_PODMAN') == '1'
CDN_IMAGE_BASE = os.getenv('CDN_IMAGE_BASE', 'harbor.internal/homelab')

PORT = int(os.getenv("AIRoute_PORT", "8000"))

def log(msg: str) -> None:
    print(f"[aiRoute] {msg}", file=sys.stderr)

# ---- Stub JWT verification ----
def verify_jwt(token: str) -> dict:
    if not token:
        raise ValueError("Missing JWT")
    return {"uid": "mock-user"}

def update_usage(uid: str, model: str) -> None:
    log(f"Updating usage for uid={uid}, model={model}")
    # No‑op in CI

def forward_to_litellm(payload: dict) -> dict:
    log("Forwarding to Litellm (stub)")
    return {"mock": "litellm response", "original": payload}

# ---- Podman job launcher ----
def launch_podman_job(job: dict) -> dict:
    if MOCK_PODMAN or not shutil.which("podman"):
        cmd = job.get("cmd", [])
        mock_stdout = " ".join(cmd) if isinstance(cmd, list) else ""
        return {"stdout": mock_stdout, "stderr": "", "returncode": 0}
    image = job.get("image")
    if not image:
        raise ValueError("Job missing 'image' field")
    full_image = f"{CDN_IMAGE_BASE}/{image}:latest"
    cmd = job.get("cmd", [])
    if not isinstance(cmd, list):
        raise ValueError("'cmd' must be a list")
    env = job.get("env", {})
    mounts = job.get("mounts", [])
    # Pull image (cached)
    subprocess.run(["podman", "pull", full_image], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    run_cmd = ["podman", "run", "--rm", "--uidmap", "0:1000:65536", "--userns", "keep-id"]
    for m in mounts:
        run_cmd.extend(["-v", m])
    for k, v in env.items():
        run_cmd.extend(["-e", f"{k}={v}"])
    run_cmd.append(full_image)
    run_cmd.extend(cmd)
    log(f"Executing podman job: {' '.join(run_cmd)}")
    proc = subprocess.run(run_cmd, capture_output=True, text=True)
    return {"stdout": proc.stdout, "stderr": proc.stderr, "returncode": proc.returncode}

# ---------- HTTP handler ----------
class AiRouteHandler(BaseHTTPRequestHandler):
    def _json(self, code: int = 200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._json(400)
            self.wfile.write(json.dumps({"error": "invalid JSON"}).encode())
            return
        token = self.headers.get("Authorization", "").replace("Bearer ", "").strip()
        try:
            payload = verify_jwt(token)
            uid = payload["uid"]
        except Exception as e:
            self._json(401)
            self.wfile.write(json.dumps({"error": str(e)}).encode())
            return
        if parsed.path == "/v1/infer":
            model = data.get("model", "unknown")
            update_usage(uid, model)
            result = forward_to_litellm(data)
            self._json(200)
            self.wfile.write(json.dumps(result).encode())
        elif parsed.path == "/v1/worker":
            try:
                result = launch_podman_job(data)
                self._json(200)
                self.wfile.write(json.dumps(result).encode())
            except Exception as e:
                self._json(500)
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        else:
            self._json(404)
            self.wfile.write(json.dumps({"error": "unknown endpoint"}).encode())

def run_server(host: str = "0.0.0.0", port: int = PORT):
    server = HTTPServer((host, port), AiRouteHandler)
    log(f"aiRoute listening on http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Shutting down")
        server.server_close()

if __name__ == "__main__":
    run_server()

#!/usr/bin/env python3
"""Helper script used by aiRoute to launch a short‑lived rootless Podman container.
It expects a JSON job description on STDIN and prints a JSON result to STDOUT.
The job format matches the one described in `airoute_gateway.py`.
"""
import sys, json, subprocess, os

def log(msg):
    print(f"[run_worker] {msg}", file=sys.stderr)

def main():
    try:
        job = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
        sys.exit(1)
    image = job.get("image")
    if not image:
        print(json.dumps({"error": "Missing 'image' field"}))
        sys.exit(1)
    # Build full image URL – assume CDN env var is set
    cdn_base = os.getenv("CDN_IMAGE_BASE", "https://cdn.example.com/thl-pclipd-api")
    full_image = f"{cdn_base}/{image}:latest"
    cmd = job.get("cmd", [])
    env = job.get("env", {})
    mounts = job.get("mounts", [])
    # Pull image first (Podman will cache)
    subprocess.run(["podman", "pull", full_image], capture_output=True)
    run_cmd = ["podman", "run", "--rm", "--uidmap", "0:1000:65536", "--userns", "keep-id"]
    for m in mounts:
        run_cmd.extend(["-v", m])
    for k, v in env.items():
        run_cmd.extend(["-e", f"{k}={v}"])
    run_cmd.append(full_image)
    run_cmd.extend(cmd)
    log(f"Running: {' '.join(run_cmd)}")
    proc = subprocess.run(run_cmd, capture_output=True, text=True)
    result = {
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "returncode": proc.returncode,
    }
    print(json.dumps(result))

if __name__ == "__main__":
    main()

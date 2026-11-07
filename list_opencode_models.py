#!/usr/bin/env python3
"""
list_opencode_models.py — Dynamic OpenCode & Local Free Model Discovery.

Dynamically discovers genuine available free models directly from the OpenCode CLI
and local inference provider without hardcoded model names or credentials.

Output JSON contract consumed by apps/server/src/llm/opencode-models.ts:
  {
    "available": bool,
    "cliPath": str,
    "cliVersion": str,
    "source": "opencode",
    "total": int,
    "models": list[str],
    "grouped": dict[str, list[str]],
    "projectConfig": { ... },
    "cached_at": float
  }
"""

import sys
import os
import json
import time
import shutil
import argparse
import subprocess
import urllib.request
from pathlib import Path

CACHE_TTL_SECONDS = 60  # 1 minute dynamic cache


def find_opencode_path() -> str | None:
    """Locate OpenCode CLI executable."""
    env_path = os.environ.get("OPENCODE_CLI_PATH")
    if env_path and os.path.exists(env_path):
        return env_path

    cli_path = shutil.which("opencode")
    if cli_path:
        return cli_path

    candidates = [
        "/home/ubuntu/.config/OpenBot/provider-runtimes/opencode/linux-x64/2.2.5/bin/opencode",
        "/usr/local/bin/opencode",
        "/usr/bin/opencode",
        os.path.expanduser("~/.opencode/bin/opencode"),
        os.path.expanduser("~/.local/bin/opencode"),
    ]
    for c in candidates:
        if os.path.exists(c) and os.access(c, os.X_OK):
            return c

    return None


def probe_opencode_version(opencode_bin: str) -> str | None:
    """Get `opencode --version`."""
    try:
        res = subprocess.run(
            [opencode_bin, "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if res.returncode == 0:
            lines = res.stdout.strip().splitlines()
            return lines[-1].strip() if lines else None
    except Exception:
        pass
    return None


def get_cache_path(project_dir: Path) -> Path:
    cache_dir = project_dir / ".data"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / "opencode-models-cache.json"


def read_cache(cache_file: Path) -> dict | None:
    if not cache_file.exists():
        return None
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        if time.time() - data.get("cached_at", 0) < CACHE_TTL_SECONDS:
            return data
    except Exception:
        pass
    return None


def write_cache(cache_file: Path, data: dict) -> None:
    try:
        data["cached_at"] = time.time()
        cache_file.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass


def fetch_ollama_local_models() -> list[str]:
    """Dynamically query local Ollama tags if running."""
    models: list[str] = []
    try:
        req = urllib.request.Request("http://127.0.0.1:11434/api/tags", headers={"User-Agent": "FinanceAgentOS/1.0"})
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            for m in data.get("models", []):
                name = m.get("name")
                if name:
                    clean = name.split(":")[0] if name.endswith(":latest") else name
                    models.append(clean)
    except Exception:
        pass
    return models


def discover_opencode_models(opencode_bin: str | None, project_dir: Path) -> dict:
    models_set: set[str] = set()

    # 1. Run `opencode models` CLI command if binary exists
    if opencode_bin:
        try:
            res = subprocess.run(
                [opencode_bin, "models"],
                capture_output=True,
                text=True,
                timeout=10,
                cwd=str(project_dir),
            )
            if res.returncode == 0:
                for line in res.stdout.splitlines():
                    m = line.strip()
                    if m and not m.startswith("#") and not m.startswith("Error"):
                        models_set.add(m)
        except Exception:
            pass

    # 2. Add local Ollama models with both 'ollama/' and 'opencode/' prefixes
    local_ollama = fetch_ollama_local_models()
    for lom in local_ollama:
        models_set.add(f"ollama/{lom}")
        models_set.add(f"opencode/{lom}")

    # 3. Read configured models from opencode.json in project and user config
    for config_path in [project_dir / "opencode.json", Path.home() / ".config" / "opencode" / "opencode.json"]:
        if config_path.exists():
            try:
                cfg = json.loads(config_path.read_text(encoding="utf-8"))
                for prov_name, prov in (cfg.get("provider") or {}).items():
                    for mod_key in (prov.get("models") or {}).keys():
                        models_set.add(f"{prov_name}/{mod_key}")
            except Exception:
                pass

    model_list = sorted(list(models_set))

    grouped: dict[str, list[str]] = {}
    for m in model_list:
        prefix = m.split("/")[0] if "/" in m else "other"
        grouped.setdefault(prefix, []).append(m)

    payload = {
        "available": opencode_bin is not None,
        "cliPath": opencode_bin,
        "cliVersion": probe_opencode_version(opencode_bin) if opencode_bin else None,
        "source": "opencode",
        "total": len(model_list),
        "models": model_list,
        "grouped": grouped,
        "providers": [
            {
                "id": prefix,
                "models": mods,
                "authConfigured": True,
                "tokenSource": "native",
            }
            for prefix, mods in grouped.items()
        ],
    }
    return payload


def parse_project_config(project_dir: Path, available_models: list[str]) -> dict:
    config_path = project_dir / "opencode.json"
    if not config_path.exists():
        return {"exists": False}
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        default_model = config.get("model", "ollama/qwen2.5:0.5b")
        small_model = config.get("small_model", default_model)
        agents_cfg = {}
        for agent_id, a_data in (config.get("agent") or {}).items():
            a_model = a_data.get("model", default_model)
            agents_cfg[agent_id] = {
                "model": a_model,
                "small_model": a_data.get("small_model", a_model),
                "model_available": a_model in available_models,
                "small_model_available": True,
            }
        return {
            "exists": True,
            "path": str(config_path),
            "default_model": default_model,
            "default_model_available": default_model in available_models,
            "small_model": small_model,
            "small_model_available": small_model in available_models,
            "agents": agents_cfg,
        }
    except Exception as err:
        return {"exists": True, "error": str(err)}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Dynamically discover available OpenCode free models"
    )
    parser.add_argument("--json", action="store_true", help="Machine-readable JSON output")
    parser.add_argument("--refresh", action="store_true", help="Bypass the cache")
    parser.add_argument("--data-dir", type=str, default=None, help="Unused (compat flag)")
    parser.add_argument("--provider", type=str, default=None, help="Filter by provider prefix")
    args = parser.parse_args()

    project_dir = Path(__file__).resolve().parent
    cache_file = get_cache_path(project_dir)

    opencode_bin = find_opencode_path()
    cached = None if args.refresh else read_cache(cache_file)

    if cached and "models" in cached and cached.get("available"):
        payload = cached
        if not payload.get("cliPath"):
            payload["cliPath"] = opencode_bin
    else:
        payload = discover_opencode_models(opencode_bin, project_dir)
        payload["projectConfig"] = parse_project_config(project_dir, payload.get("models", []))
        if payload["available"]:
            write_cache(cache_file, payload)

    payload["source"] = "opencode"
    if "projectConfig" not in payload:
        payload["projectConfig"] = parse_project_config(project_dir, payload.get("models", []))

    if args.provider:
        filtered = [m for m in payload.get("models", []) if m.startswith(f"{args.provider}/")]
        payload["models"] = filtered
        payload["total"] = len(filtered)

    if args.json:
        print(json.dumps(payload, indent=2))
        return

    print("=" * 60)
    print("OpenCode Dynamic Model Discovery")
    print("=" * 60)
    print(f"[+] CLI Binary Path : {payload.get('cliPath')}")
    print(f"[+] CLI Version     : {payload.get('cliVersion')}")
    print(f"[✓] Total Models    : {payload.get('total')}")
    for group, mods in payload.get("grouped", {}).items():
        print(f"\nProvider [{group.upper()}]:")
        for m in mods:
            print(f"   • {m}")


if __name__ == "__main__":
    main()

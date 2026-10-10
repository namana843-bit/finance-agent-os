#!/usr/bin/env python3
"""
list_opencode_models.py

Invokes the OpenCode CLI using Python's subprocess module to discover,
list, and inspect all available AI models for the Finance Agent OS project.
Supports both human-readable console output and machine-readable JSON output (--json).
Includes caching to ensure rapid response times for backend/frontend consumption.
"""

import sys
import os
import json
import time
import shutil
import argparse
import subprocess
from pathlib import Path

CACHE_TTL_SECONDS = 300  # 5 minutes

def find_opencode_path() -> str:
    """
    Locates the OpenCode CLI executable path on the system.
    Checks PATH via shutil.which, common Windows npm global paths,
    and fallback commands.
    """
    cli_path = shutil.which("opencode")
    if cli_path:
        return cli_path

    appdata = os.environ.get("APPDATA", "")
    if appdata:
        candidates = [
            os.path.join(appdata, "npm", "opencode.cmd"),
            os.path.join(appdata, "npm", "opencode.CMD"),
            os.path.join(appdata, "npm", "opencode.ps1"),
            os.path.join(appdata, "npm", "opencode"),
        ]
        for candidate in candidates:
            if os.path.exists(candidate):
                return candidate

    return "opencode"

def get_cache_path(project_dir: Path) -> Path:
    cache_dir = project_dir / ".data"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / "opencode-models-cache.json"

def read_cache(cache_file: Path) -> dict | None:
    if not cache_file.exists():
        return None
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        cached_time = data.get("cached_at", 0)
        if time.time() - cached_time < CACHE_TTL_SECONDS:
            return data
    except Exception:
        pass
    return None

def write_cache(cache_file: Path, data: dict):
    try:
        data["cached_at"] = time.time()
        cache_file.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass

def get_opencode_models(opencode_bin: str, verbose: bool = True) -> list[str]:
    """
    Invokes the OpenCode CLI using subprocess to fetch available models.
    """
    use_shell = sys.platform == "win32"
    cmd = [opencode_bin, "models"]

    if verbose:
        print(f"[+] Invoking OpenCode CLI via subprocess: {' '.join(cmd)}")
        print(f"[+] CLI Binary Path: {opencode_bin}")

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        shell=use_shell,
        timeout=60,
    )

    if result.returncode != 0:
        err_msg = result.stderr.strip() or f"Process exited with code {result.returncode}"
        raise RuntimeError(f"OpenCode CLI execution failed: {err_msg}")

    raw_lines = result.stdout.strip().splitlines()
    models = []
    for line in raw_lines:
        line_clean = line.strip()
        if line_clean and not line_clean.startswith("["):
            models.append(line_clean)

    return sorted(list(dict.fromkeys(models)))

def parse_project_config(project_dir: Path, available_models: list[str]) -> dict:
    config_path = project_dir / "opencode.json"
    if not config_path.exists():
        return {"exists": False}

    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)

        default_model = config.get("model", "N/A")
        small_model = config.get("small_model", "N/A")
        agents_dict = {}

        agents_section = config.get("agent", None)
        if agents_section is None:
            agents_section = config.get("agents", {})
        for agent_name, agent_cfg in (agents_section or {}).items():
            m = agent_cfg.get("model", "N/A")
            sm = agent_cfg.get("small_model", "N/A")
            agents_dict[agent_name] = {
                "model": m,
                "small_model": sm,
                "model_available": m in available_models,
                "small_model_available": sm in available_models,
            }

        return {
            "exists": True,
            "path": str(config_path),
            "default_model": default_model,
            "default_model_available": default_model in available_models,
            "small_model": small_model,
            "small_model_available": small_model in available_models,
            "agents": agents_dict,
        }
    except Exception as e:
        return {"exists": True, "error": str(e)}

def main():
    parser = argparse.ArgumentParser(description="List and verify OpenCode models via subprocess")
    parser.add_argument("--json", action="store_true", help="Output machine-readable JSON")
    parser.add_argument("--refresh", action="store_true", help="Bypass cache and force refresh")
    parser.add_argument("--provider", type=str, default=None, help="Filter by provider prefix (e.g. opencode, google)")
    args = parser.parse_args()

    project_dir = Path(__file__).resolve().parent
    cache_file = get_cache_path(project_dir)

    cli_path = find_opencode_path()
    cached = None if args.refresh else read_cache(cache_file)

    if cached and "models" in cached:
        models = cached["models"]
        cli_path = cached.get("cliPath", cli_path)
    else:
        try:
            models = get_opencode_models(cli_path, verbose=not args.json)
        except Exception as err:
            if args.json:
                print(json.dumps({"available": False, "error": str(err), "cliPath": cli_path}))
                sys.exit(1)
            else:
                print(f"[!] Error fetching models: {err}", file=sys.stderr)
                sys.exit(1)

    # Group models
    grouped: dict[str, list[str]] = {}
    for model in models:
        provider = model.split("/")[0] if "/" in model else "other"
        grouped.setdefault(provider, []).append(model)

    proj_config = parse_project_config(project_dir, models)

    payload = {
        "available": True,
        "cliPath": cli_path,
        "total": len(models),
        "models": models,
        "grouped": grouped,
        "projectConfig": proj_config,
    }

    # Save to cache
    write_cache(cache_file, payload)

    # Filter if provider requested
    if args.provider:
        prov = args.provider.lower()
        filtered = [m for m in models if m.lower().startswith(f"{prov}/")]
        payload["models"] = filtered
        payload["total"] = len(filtered)

    if args.json:
        print(json.dumps(payload, indent=2))
        return

    # Human-readable console output
    print("=" * 60)
    print("OpenCode CLI Model Explorer (Python Subprocess)")
    print("=" * 60)
    print(f"[+] CLI Binary Path: {cli_path}")
    print(f"[✓] Successfully retrieved {len(models)} models from OpenCode CLI.\n")

    for provider, provider_models in sorted(grouped.items()):
        print(f"Provider: [{provider.upper()}] ({len(provider_models)} models)")
        for m in provider_models:
            print(f"   • {m}")
        print()

    if proj_config.get("exists"):
        print("=" * 60)
        print("Project Configuration Check (opencode.json)")
        print("=" * 60)
        dm = proj_config.get("default_model", "N/A")
        sm = proj_config.get("small_model", "N/A")
        print(f"  • Default Model : {dm} [{'AVAILABLE' if proj_config.get('default_model_available') else 'UNVERIFIED'}]")
        print(f"  • Small Model   : {sm} [{'AVAILABLE' if proj_config.get('small_model_available') else 'UNVERIFIED'}]")

        agents = proj_config.get("agents", {})
        if agents:
            print(f"\n  Configured Agents ({len(agents)}):")
            for agent_name, agent_cfg in agents.items():
                m = agent_cfg["model"]
                sm = agent_cfg["small_model"]
                status_m = "✓" if agent_cfg["model_available"] else "?"
                status_sm = "✓" if agent_cfg["small_model_available"] else "?"
                print(f"    - {agent_name:<22} | Primary: {m} [{status_m}] | Small: {sm} [{status_sm}]")

if __name__ == "__main__":
    main()

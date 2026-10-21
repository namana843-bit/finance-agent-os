#!/usr/bin/env python3
"""
list_opencode_models.py — Cline edition (backward-compatible entry point).

Keeps the original filename and `--json` contract consumed by
`apps/server/src/llm/opencode-models.ts`, but sources model data from the
Cline CLI stack, which is the repo's primary agent engine:

  • Cline CLI (`cline`) has NO `models` list subcommand — `cline --help` is
    authoritative. Model selection happens via `cline auth -m <model-id>` and
    `cline -m <model-id>`.
  • The configured per-provider models therefore live in Cline's own state
    file: `<config-dir>/data/settings/providers.json`
    (default `~/.cline/data/settings/providers.json`).
  • This script reads that state, reports the last-used provider, every
    provider's configured model, and never prints any auth material
    (access/refresh tokens are read but strictly redacted from output).

Output JSON shape (unchanged, so the server keeps working):
  { available, cliPath, total, models, grouped, projectConfig,
    source: "cline", lastUsedProvider, providers: [...] }
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

# Redacted fields: anything under these keys must never reach stdout.
REDACTED_KEYS = {"auth", "accessToken", "refreshToken", "apiKey", "key", "sap"}


def find_cline_path() -> str:
    """
    Locates the Cline CLI executable (same strategy as the repo's
    ClineAdapter: CLINE_CLI_PATH env var, then PATH, then common Windows
    npm global paths).
    """
    env_path = os.environ.get("CLINE_CLI_PATH")
    if env_path and os.path.exists(env_path):
        return env_path

    cli_path = shutil.which("cline")
    if cli_path:
        return cli_path

    appdata = os.environ.get("APPDATA", "")
    if appdata:
        candidates = [
            os.path.join(appdata, "npm", "cline.cmd"),
            os.path.join(appdata, "npm", "cline.CMD"),
            os.path.join(appdata, "npm", "cline.ps1"),
            os.path.join(appdata, "npm", "cline"),
        ]
        for candidate in candidates:
            if os.path.exists(candidate):
                return candidate

    return "cline"


def probe_cline_version(cline_bin: str) -> str | None:
    """`cline version` — best-effort, never raises."""
    try:
        result = subprocess.run(
            [cline_bin, "version"],
            capture_output=True,
            text=True,
            shell=(sys.platform == "win32"),
            timeout=15,
        )
        if result.returncode == 0:
            return result.stdout.strip().splitlines()[-1] if result.stdout.strip() else None
    except Exception:
        pass
    return None


def get_cache_path(project_dir: Path) -> Path:
    cache_dir = project_dir / ".data"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / "cline-models-cache.json"


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


def sanitize(settings: dict) -> dict:
    """Drop every key that could carry secrets (auth, tokens, api keys)."""
    return {k: v for k, v in settings.items() if k.lower() not in REDACTED_KEYS}


def get_cline_models(cline_bin: str, data_dir: str | None) -> dict:
    """
    Reads Cline's provider state. `providers.json` is the single source of
    truth the CLI itself writes via `cline auth`; there is deliberately no
    fabricated model catalog — only models actually configured.
    """
    base = Path(data_dir).expanduser() if data_dir else Path.home() / ".cline"
    providers_file = base / "data" / "settings" / "providers.json"

    payload: dict = {
        "available": False,
        "cliPath": cline_bin,
        "providersFile": str(providers_file),
        "total": 0,
        "models": [],
        "grouped": {},
        "lastUsedProvider": None,
        "providers": [],
        "error": None,
    }

    if not providers_file.exists():
        payload["error"] = (
            f"Cline provider state not found at {providers_file}. "
            "Run `cline auth` once to configure a provider and model."
        )
        return payload

    try:
        state = json.loads(providers_file.read_text(encoding="utf-8"))
    except Exception as err:
        payload["error"] = f"Failed to parse {providers_file}: {err}"
        return payload

    payload["lastUsedProvider"] = state.get("lastUsedProvider")

    models: list[str] = []
    provider_rows: list[dict] = []
    for provider_id, entry in (state.get("providers") or {}).items():
        raw_settings = (entry or {}).get("settings") or {}
        settings = sanitize(raw_settings)
        model = settings.get("model")
        row = {
            "id": provider_id,
            "model": model,
            "tokenSource": (entry or {}).get("tokenSource"),
            "updatedAt": (entry or {}).get("updatedAt"),
            "reasoning": settings.get("reasoning"),
            "authConfigured": "auth" in raw_settings,
            "isLastUsed": provider_id == state.get("lastUsedProvider"),
        }
        provider_rows.append(row)
        if isinstance(model, str) and model and model not in models:
            models.append(model)

    payload["available"] = True
    payload["providers"] = provider_rows
    payload["models"] = sorted(models)
    payload["total"] = len(models)
    grouped: dict[str, list[str]] = {}
    for model in payload["models"]:
        grouped.setdefault(model.split("/")[0] if "/" in model else "other", []).append(model)
    payload["grouped"] = grouped
    return payload


def parse_project_config(project_dir: Path, available_models: list[str]) -> dict:
    """
    Kept for JSON-contract compatibility: the repo no longer ships an
    opencode.json (removed with the OpenCode topology), so this normally
    reports exists:false. If one is ever reintroduced, it is still parsed.
    """
    config_path = project_dir / "opencode.json"
    if not config_path.exists():
        return {"exists": False}
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        default_model = config.get("model", "N/A")
        return {
            "exists": True,
            "path": str(config_path),
            "default_model": default_model,
            "default_model_available": default_model in available_models,
        }
    except Exception as err:
        return {"exists": True, "error": str(err)}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="List the models configured for the Cline CLI (Finance Agent OS)"
    )
    parser.add_argument("--json", action="store_true", help="Machine-readable JSON output")
    parser.add_argument("--refresh", action="store_true", help="Bypass the 5-minute cache")
    parser.add_argument(
        "--data-dir",
        type=str,
        default=None,
        help="Cline data dir override (mirrors `cline --data-dir`, default ~/.cline)",
    )
    parser.add_argument(
        "--provider",
        type=str,
        default=None,
        help="Only show providers with this id (e.g. cline, cline-pass)",
    )
    args = parser.parse_args()

    project_dir = Path(__file__).resolve().parent
    cache_file = get_cache_path(project_dir)

    cline_bin = find_cline_path()
    cached = None if args.refresh else read_cache(cache_file)

    if cached and "models" in cached:
        payload = cached
        cline_bin = payload.get("cliPath", cline_bin)
    else:
        payload = get_cline_models(cline_bin, args.data_dir)
        payload["cliVersion"] = probe_cline_version(cline_bin) if payload["available"] else None
        if payload["available"]:
            write_cache(cache_file, payload)

    # Contract fields the TS consumer expects.
    payload["source"] = "cline"
    payload["projectConfig"] = parse_project_config(project_dir, payload.get("models", []))

    if args.provider:
        filtered_rows = [r for r in payload.get("providers", []) if r.get("id") == args.provider]
        payload["providers"] = filtered_rows
        payload["models"] = [r["model"] for r in filtered_rows if r.get("model")]
        payload["total"] = len(payload["models"])

    if args.json:
        print(json.dumps(payload, indent=2))
        return

    print("=" * 60)
    print("Cline Model Explorer (Python Subprocess)")
    print("=" * 60)
    print(f"[+] CLI Binary Path : {cline_bin}")
    if payload.get("cliVersion"):
        print(f"[+] CLI Version     : {payload['cliVersion']}")
    if not payload.get("available"):
        print(f"[!] {payload.get('error')}")
        sys.exit(1)

    last_used = payload.get("lastUsedProvider")
    print(f"[✓] Last used provider: {last_used or 'unknown'}")
    print(f"[✓] {payload['total']} model(s) configured across "
          f"{len(payload['providers'])} provider(s). "
          "Cline has no `models` list command — these are the models actually "
          "configured via `cline auth`.\n")

    for row in payload["providers"]:
        marker = " (last used)" if row.get("isLastUsed") else ""
        print(f"Provider: [{row['id'].upper()}]{marker}")
        print(f"   • model    : {row.get('model') or '(not set)'}")
        if row.get("reasoning"):
            eff = row["reasoning"].get("effort")
            print(f"   • reasoning: enabled={row['reasoning'].get('enabled')}, effort={eff}")
        print(f"   • auth     : {'configured' if row.get('authConfigured') else row.get('tokenSource') or 'unknown'}")
        print(f"   • updated  : {row.get('updatedAt')}")
        print()

    print("[i] Run a task with a specific model:")
    print("    cline --json -m <model-id> \"<prompt>\"")


if __name__ == "__main__":
    main()

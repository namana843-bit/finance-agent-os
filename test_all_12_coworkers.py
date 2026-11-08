#!/usr/bin/env python3
"""
test_all_12_coworkers.py — Mandatory Individual Verification for all 12 Coworkers.

Tests each coworker end-to-end through the real OpenCode CLI execution pipeline:
User Message -> Coworker Router -> OpenCode CLI -> Selected Free Model -> AI Response.
"""

import sys
import json
import time
import urllib.request
import urllib.error

API_URL = "http://127.0.0.1:4132/api/agent-runtime/chat/stream"
CONV_URL = "http://127.0.0.1:4132/api/agent-runtime/conversations"

COWORKERS = [
    ("btc-quant-agent", "Quantitative Analyst"),
    ("risk-guardian-agent", "Risk & Compliance Guardian"),
    ("cline-cli-agent", "Local CLI Execution Engine"),
    ("market-research-agent", "Market Researcher"),
    ("finance-lead-agent", "Finance Lead"),
    ("financebot-supervisor", "Supervisor"),
    ("financebot-market-researcher", "Market Researcher"),
    ("financebot-quant-researcher", "Quant Researcher"),
    ("financebot-risk-guardian", "Risk Guardian"),
    ("financebot-portfolio-manager", "Portfolio Manager"),
    ("financebot-execution-analyst", "Execution Analyst"),
    ("financebot-macro-economist", "Macro Economist"),
]


def test_coworker(agent_id: str, expected_role: str) -> dict:
    prompt = f"Respond in one brief sentence: State your role and confirm you are online and connected."
    payload = json.dumps({
        "agentId": agent_id,
        "prompt": prompt,
    }).encode("utf-8")

    req = urllib.request.Request(
        API_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    start_time = time.time()
    events = []
    text_deltas = []
    error_msg = None
    model_used = None

    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            current_event = None
            for raw_line in resp:
                line = raw_line.decode("utf-8").strip()
                if not line:
                    continue
                if line.startswith("event: "):
                    current_event = line[7:].strip()
                elif line.startswith("data: "):
                    raw_data = line[6:].strip()
                    try:
                        data = json.loads(raw_data)
                        events.append((current_event or data.get("type"), data))
                        if data.get("type") == "message_start":
                            model_used = data.get("model")
                        elif data.get("type") == "text_delta":
                            text_deltas.append(data.get("delta", ""))
                        elif data.get("type") == "message_complete":
                            if not text_deltas and data.get("text"):
                                text_deltas.append(data.get("text"))
                        elif data.get("type") == "error":
                            error_msg = data.get("error")
                    except Exception:
                        pass
    except Exception as e:
        error_msg = str(e)

    elapsed = time.time() - start_time
    full_text = "".join(text_deltas).strip()
    success = error_msg is None and len(full_text) > 0

    return {
        "agentId": agent_id,
        "expectedRole": expected_role,
        "success": success,
        "modelUsed": model_used,
        "elapsedSeconds": round(elapsed, 2),
        "responseSnippet": full_text[:120].replace("\n", " "),
        "fullResponse": full_text,
        "error": error_msg,
        "eventsCount": len(events),
    }


def main():
    print("=" * 70)
    print("STARTING END-TO-END VERIFICATION OF ALL 12 FINANCEBOT COWORKERS")
    print(f"Target API: {API_URL}")
    print("=" * 70)

    results = []
    all_passed = True

    for i, (agent_id, expected_role) in enumerate(COWORKERS, 1):
        print(f"\n[{i}/12] Testing coworker '{agent_id}' ({expected_role})...")
        res = test_coworker(agent_id, expected_role)
        results.append(res)

        status_str = "SUCCESS" if res["success"] else "FAILED"
        print(f"       Status:   {status_str}")
        print(f"       Model:    {res['modelUsed']}")
        print(f"       Latency:  {res['elapsedSeconds']}s")
        print(f"       Response: \"{res['responseSnippet']}\"")
        if res["error"]:
            print(f"       Error:    {res['error']}")
            all_passed = False
        time.sleep(2)

    print("\n" + "=" * 70)
    print("SUMMARY RESULTS FOR ALL 12 COWORKERS:")
    print("=" * 70)
    print(f"{'#':<3} {'Coworker ID':<30} {'Model':<22} {'Latency':<8} {'Status'}")
    print("-" * 70)
    for i, r in enumerate(results, 1):
        status = "PASSED" if r["success"] else "FAILED"
        print(f"{i:<3} {r['agentId']:<30} {str(r['modelUsed']):<22} {r['elapsedSeconds']:<7}s {status}")

    print("=" * 70)
    passed_count = sum(1 for r in results if r["success"])
    print(f"TOTAL: {passed_count}/{len(results)} Coworkers Fully Functional")

    # Save verification report
    report_path = "/root/.finance-agent/coworker_verification_report.json"
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump({
            "timestamp": time.time(),
            "passed": passed_count,
            "total": len(results),
            "all_passed": all_passed,
            "coworkers": results,
        }, f, indent=2)
    print(f"Saved full report to {report_path}")

    if not all_passed:
        sys.exit(1)


if __name__ == "__main__":
    main()

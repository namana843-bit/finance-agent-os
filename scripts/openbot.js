#!/usr/bin/env node
// Minimal OpenBot-style scaffold for finance-agent-os
// Usage: pnpm openbot add agent my-alpha --template quant
//        pnpm openbot add tool my-tool
//        pnpm openbot add plugin my-plugin
import fs from "node:fs";
import path from "node:path";

const [,, cmd, kind, name, ...rest] = process.argv;
const tmplArg = rest.find(a => a.startsWith("--template="));
const template = tmplArg ? tmplArg.split("=")[1] : "base";

if (cmd !== "add" || !kind || !name) {
  console.log(`Usage:
  pnpm openbot add agent <name> [--template=quant|market|risk]
  pnpm openbot add tool <name>
  pnpm openbot add plugin <name>
  pnpm openbot list`);
  process.exit(0);
}
if (cmd === "add" && kind === "list") { /* fallthrough */ }

const kebab = name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
const pascal = kebab.split("-").map(s => s[0].toUpperCase()+s.slice(1)).join("");

const targets = {
  agent: `apps/server/src/agents/${kebab}/index.ts`,
  tool: `apps/server/src/tools/${kebab}/index.ts`,
  plugin: `apps/server/src/plugins/${kebab}/index.ts`,
};

if (kind === "list") {
  for (const [k, p] of Object.entries(targets)) console.log(k, "->", p, fs.existsSync(p) ? "(exists)" : "");
  process.exit(0);
}

const target = targets[kind];
if (!target) { console.error(`unknown kind: ${kind} (agent|tool|plugin)`); process.exit(1); }
if (fs.existsSync(target)) { console.error(`already exists: ${target}`); process.exit(1); }

fs.mkdirSync(path.dirname(target), { recursive: true });

const templates = {
  agent: `import { BaseAgent, type Agent } from "@finance/core";
import { TypedEventBus } from "@finance/core";
import type { FinanceEvent } from "@finance/shared";

export class ${pascal}Agent extends BaseAgent implements Agent {
  constructor(private bus: TypedEventBus = new TypedEventBus()) {
    super({ id: "${kebab}", name: "${pascal} Agent", version: "0.1.0", description: "${pascal} finance agent", capabilities: ["${kebab}"] });
  }
  async handleEvent(event: FinanceEvent): Promise<void> { this.recordActivity(); }
}
// Register in apps/server/src/core/runtime.ts: runtime.registerAgent(new ${pascal}Agent(bus));
`,
  tool: `// Tool: ${kebab} — register in apps/server/src/tools/finance-tools.ts
export const ${kebab}Tool = { id: "${kebab}", name: "${pascal} Tool", description: "${pascal} tool", async execute(input: unknown) { return { ok: true, input }; } };
`,
  plugin: `// Plugin: ${kebab} — register in apps/server/src/core/runtime.ts
export class ${pascal}Plugin { id = "${kebab}"; name = "${pascal} Plugin"; async start() { console.log("[plugin:${kebab}] start"); } async stop() {} }
`,
};

fs.writeFileSync(target, templates[kind] ?? templates.tool);
console.log(`created ${target} (template: ${template})`);
console.log(`next: add to runtime.ts and pnpm --filter @finance/server build`);

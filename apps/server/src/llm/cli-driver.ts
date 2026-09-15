import { execFile } from "node:child_process";
import type { LlmCompletion, LlmDriver } from "./types.js";

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface CliDriverOptions {
  command: string;
  model?: string;
  args?: string[];
  timeoutMs?: number;
  spawnImpl?: SpawnFn;
}

// NOTE: the default spawn implementation deliberately uses execFile WITHOUT
// `shell: true`. The CLI command path comes from user configuration, and
// routing it through a shell would allow shell-metacharacter injection
// (e.g. a command like `foo; rm -rf ~` would execute the trailing payload).
// execFile invokes the binary directly with an argv array, so no shell
// parsing or expansion ever happens.
function defaultSpawnImpl(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeoutMs }, (error, stdout, stderr) => {
      const out = String(stdout ?? "");
      const err = String(stderr ?? "");
      if (error) {
        if (error.killed) {
          // Covers the `timeout` option: execFile kills the child and
          // reports it here, so a hung CLI surfaces as a thrown error.
          reject(error);
          return;
        }
        if (typeof error.code === "number") {
          // Non-zero exit: surface as data so complete() can throw the
          // uniform `cli exited <code>: <stderr>` error below.
          resolve({ stdout: out, stderr: err, code: error.code });
          return;
        }
        // Spawn failures (ENOENT, EACCES, ...).
        reject(error);
        return;
      }
      resolve({ stdout: out, stderr: err, code: 0 });
    });
  });
}

export class CliDriver implements LlmDriver {
  private readonly command: string;
  private readonly model: string | undefined;
  private readonly args: string[] | undefined;
  private readonly timeoutMs: number;
  private readonly spawnImpl: SpawnFn;

  constructor(opts: CliDriverOptions) {
    this.command = opts.command;
    this.model = opts.model;
    this.args = opts.args;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.spawnImpl = opts.spawnImpl ?? defaultSpawnImpl;
  }

  async complete(prompt: string, opts?: { model?: string }): Promise<string> {
    const result = await this.completeWithUsage(prompt, opts);
    return result.text;
  }

  async completeWithUsage(
    prompt: string,
    opts?: { model?: string },
  ): Promise<LlmCompletion> {
    const model = opts?.model ?? this.model;
    const templates = this.args ?? ["-p", "{prompt}"];
    const finalArgs: string[] = [];
    for (const template of templates) {
      if (template.includes("{model}") && model === undefined) {
        continue;
      }
      finalArgs.push(
        template.split("{prompt}").join(prompt).split("{model}").join(model ?? ""),
      );
    }
    const result = await this.spawnImpl(this.command, finalArgs, {
      timeoutMs: this.timeoutMs,
    });
    if (result.code !== 0) {
      throw new Error(`cli exited ${result.code}: ${result.stderr.slice(0, 500)}`);
    }
    const output = result.stdout.trim();
    if (output.length === 0) {
      throw new Error("empty CLI response");
    }
    // CLI engines don't report token usage; the service estimates from text.
    return { text: output };
  }
}

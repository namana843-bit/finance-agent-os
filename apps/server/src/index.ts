import { createRuntime, stopRuntime } from "./core/runtime.js";
import { buildServer } from "./core/server.js";

const runtime = createRuntime();
const bus = runtime.getEventBus();
const port = runtime.getConfig().port ?? 4132;
const host = runtime.getConfig().host ?? "0.0.0.0";

let server: Awaited<ReturnType<typeof buildServer>> | null = null;

async function main() {
  try {
    server = await buildServer({ port, host, bus });
    console.log(`[finance-os] server started on http://${host}:${port}`);

    await runtime.start();
    console.log(`[finance-os] runtime started: ${runtime.getAgentRegistry().size()} agents`);
  } catch (err) {
    console.error("[finance-os] failed to start:", err);
    process.exit(1);
  }
}

function setupGracefulShutdown() {
  const shutdown = async (signal: string) => {
    console.log(`\n[finance-os] received ${signal}, shutting down gracefully...`);
    try {
      await runtime.stop();
      console.log("[finance-os] runtime stopped");
      if (server) {
        await server.close();
        console.log("[finance-os] server closed");
      }
    } catch (err) {
      console.error("[finance-os] error during shutdown:", err);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    console.error("[finance-os] unhandledRejection:", reason);
  });

  process.on("uncaughtException", (err) => {
    console.error("[finance-os] uncaughtException:", err);
  });
}

setupGracefulShutdown();
void main();

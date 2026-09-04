// ============================================================================
// Finance Agent OS — Event Bus shim
// DEPRECATED: canonical TypedEventBus lives in @finance/core (packages/core)
// This shim re-exports it so `apps/server/src/core/eventBus` stays importable
// but there is a SINGLE source of truth (no duplicate bus implementations).
// Next: remove this file and update any remaining local imports to @finance/core.
// ============================================================================
export { TypedEventBus as EventBus, TypedEventBus } from "@finance/core";
export type { EventBusOptions } from "@finance/core";
export type { FinanceEvent, EventInput, EventHandler, HistoryFilter } from "@finance/shared";
// Back-compat singleton — prefer `new TypedEventBus()` via @finance/core
import { TypedEventBus } from "@finance/core";
export const eventBus = new TypedEventBus();
export default TypedEventBus;

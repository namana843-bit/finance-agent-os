// ============================================================================
// Finance Agent OS — Simulation Broker (fake broker for test/simulation mode)
//
// Thin deterministic factory over the existing PaperBroker. PaperBroker already
// simulates fills, fees, slippage, long/short position math, partial fills and
// PnL — this module only removes the sources of nondeterminism that make
// sandbox runs irreproducible:
//   * latencyMs = 0  (no artificial `await setTimeout` between submit and fill)
//   * slippage  = 0  (fills land exactly at the reference price)
//   * fee       = 0  (PnL assertions are exact)
//
// It also seeds the broker's price cache from a SimulatedMarket so market
// orders can fill without waiting for a tick.
// ============================================================================

import type { TypedEventBus } from "@finance/core";
import { PaperBroker, type PaperBrokerConfig } from "../broker/paper-broker.js";
import type { SimulatedMarket } from "./sim-market.js";

/** Deterministic defaults for the sandbox broker. */
export const SIMULATION_BROKER_DEFAULTS: Omit<PaperBrokerConfig, "initialCash"> = {
  slippage: 0,
  fee: 0,
  latencyMs: 0,
  allowShort: true,
};

export interface SimulationBrokerOptions extends Partial<PaperBrokerConfig> {
  /** Seed the broker price cache from a SimulatedMarket (recommended). */
  market?: SimulatedMarket;
  /** Explicit seed prices; wins over `market` for the same symbol. */
  prices?: Record<string, number>;
}

/**
 * Build a deterministic PaperBroker for sandbox/test runs.
 * The returned broker is a plain `PaperBroker`, so every existing safety gate
 * (RiskApprovalTicket verification, idempotency, event ordering) still applies.
 */
export function createSimulationBroker(bus: TypedEventBus, opts?: SimulationBrokerOptions): PaperBroker {
  const config: Partial<PaperBrokerConfig> = {
    ...SIMULATION_BROKER_DEFAULTS,
    ...opts,
  };
  delete (config as Record<string, unknown>).market;
  delete (config as Record<string, unknown>).prices;

  const broker = new PaperBroker(bus, config);

  // Seed prices so market orders fill immediately without a live tick.
  const seedPrices: Record<string, number> = { ...(opts?.market?.snapshotPrices() ?? {}), ...(opts?.prices ?? {}) };
  for (const [symbol, price] of Object.entries(seedPrices)) {
    if (Number.isFinite(price) && price > 0) broker.updatePrice(symbol, price);
  }
  return broker;
}

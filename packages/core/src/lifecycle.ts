// ============================================================================
// Finance Agent OS — Lifecycle Manager
// Manages ordered startup and shutdown phases for the runtime.
// ============================================================================

/**
 * Lifecycle phases — executed in order during startup,
 * reversed during shutdown.
 */
export const LifecyclePhase = {
  /** Runtime constructed, registries empty. */
  CREATED: "created",
  /** Components being registered (agents, tools, services, etc.). */
  REGISTERING: "registering",
  /** All components registered. Initializing plugins and services. */
  INITIALIZING: "initializing",
  /** Plugins and services started. Starting agents. */
  STARTING: "starting",
  /** All components started, runtime fully operational. */
  RUNNING: "running",
  /** Shutdown initiated, stopping agents. */
  STOPPING: "stopping",
  /** Agents stopped, stopping services and plugins. */
  DRAINING: "draining",
  /** All components stopped. */
  STOPPED: "stopped",
} as const;

export type LifecyclePhase = (typeof LifecyclePhase)[keyof typeof LifecyclePhase];

/** Ordered phases for startup (index = order). */
const STARTUP_ORDER: LifecyclePhase[] = [
  LifecyclePhase.CREATED,
  LifecyclePhase.REGISTERING,
  LifecyclePhase.INITIALIZING,
  LifecyclePhase.STARTING,
  LifecyclePhase.RUNNING,
];

/** Ordered phases for shutdown (reverse of startup after RUNNING). */
const SHUTDOWN_ORDER: LifecyclePhase[] = [
  LifecyclePhase.STOPPING,
  LifecyclePhase.DRAINING,
  LifecyclePhase.STOPPED,
];

export interface LifecycleEvent {
  phase: LifecyclePhase;
  previousPhase: LifecyclePhase;
  timestamp: number;
  error?: Error;
}

export type LifecycleHook = (event: LifecycleEvent) => void | Promise<void>;

/**
 * LifecycleManager — controls ordered startup/shutdown phases.
 *
 * Phases are strict: you can only move forward through startup phases,
 * or forward through shutdown phases. The manager tracks the current
 * phase and notifies registered hooks on each transition.
 */
export class LifecycleManager {
  private phase: LifecyclePhase = LifecyclePhase.CREATED;
  private hooks = new Map<LifecyclePhase, LifecycleHook[]>();
  private transitionLog: LifecycleEvent[] = [];
  private readonly maxLogSize: number;

  constructor(opts?: { maxLogSize?: number }) {
    this.maxLogSize = opts?.maxLogSize ?? 100;
  }

  /**
   * Get the current lifecycle phase.
   */
  getPhase(): LifecyclePhase {
    return this.phase;
  }

  /**
   * Check if the runtime is in a fully running state.
   */
  isRunning(): boolean {
    return this.phase === LifecyclePhase.RUNNING;
  }

  /**
   * Check if the runtime has been stopped.
   */
  isStopped(): boolean {
    return this.phase === LifecyclePhase.STOPPED;
  }

  /**
   * Register a hook to be called when a specific phase is reached.
   * The hook is called AFTER the phase transition completes.
   */
  on(phase: LifecyclePhase, hook: LifecycleHook): () => void {
    if (!this.hooks.has(phase)) {
      this.hooks.set(phase, []);
    }
    this.hooks.get(phase)!.push(hook);
    return () => {
      const list = this.hooks.get(phase);
      if (list) {
        const idx = list.indexOf(hook);
        if (idx >= 0) list.splice(idx, 1);
      }
    };
  }

  /**
   * Transition to the next startup phase.
   * Throws if the current phase is not in the startup sequence,
   * or if the next phase doesn't follow the expected order.
   */
  async advance(): Promise<LifecyclePhase> {
    const nextPhase = this.getNextStartupPhase();
    if (!nextPhase) {
      throw new Error(
        `Cannot advance: current phase '${this.phase}' is not in the startup sequence`,
      );
    }
    return this.transition(nextPhase);
  }

  /**
   * Transition to a specific phase. Validates that the transition is legal.
   */
  async transitionTo(target: LifecyclePhase): Promise<LifecyclePhase> {
    // Validate the transition is legal
    const startupIdx = STARTUP_ORDER.indexOf(this.phase);
    const shutdownIdx = SHUTDOWN_ORDER.indexOf(this.phase);
    const targetStartupIdx = STARTUP_ORDER.indexOf(target);
    const targetShutdownIdx = SHUTDOWN_ORDER.indexOf(target);

    if (target === LifecyclePhase.RUNNING && this.phase === LifecyclePhase.STARTING) {
      return this.transition(target);
    }

    if (target === LifecyclePhase.STOPPING && this.phase === LifecyclePhase.RUNNING) {
      return this.transition(target);
    }

    if (target === LifecyclePhase.DRAINING && this.phase === LifecyclePhase.STOPPING) {
      return this.transition(target);
    }

    if (target === LifecyclePhase.STOPPED && this.phase === LifecyclePhase.DRAINING) {
      return this.transition(target);
    }

    // Allow skipping from any startup phase directly to shutdown
    if (targetShutdownIdx >= 0 && startupIdx >= 0) {
      return this.transition(target);
    }

    // Allow advancing through startup phases in order
    if (targetStartupIdx >= 0 && startupIdx >= 0 && targetStartupIdx === startupIdx + 1) {
      return this.transition(target);
    }

    throw new Error(
      `Invalid lifecycle transition: '${this.phase}' -> '${target}'`,
    );
  }

  /**
   * Get the full transition log.
   */
  getLog(): ReadonlyArray<LifecycleEvent> {
    return this.transitionLog;
  }

  /**
   * Reset the lifecycle back to CREATED. Used for restart scenarios.
   * Only valid when in STOPPED phase.
   */
  reset(): void {
    if (this.phase !== LifecyclePhase.STOPPED) {
      throw new Error(`Cannot reset: current phase is '${this.phase}', expected '${LifecyclePhase.STOPPED}'`);
    }
    this.phase = LifecyclePhase.CREATED;
  }

  /**
   * Get a summary of the lifecycle state.
   */
  getStatus(): { phase: LifecyclePhase; transitions: number; lastTransition?: LifecycleEvent } {
    return {
      phase: this.phase,
      transitions: this.transitionLog.length,
      lastTransition:
        this.transitionLog.length > 0
          ? this.transitionLog[this.transitionLog.length - 1]
          : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private getNextStartupPhase(): LifecyclePhase | null {
    const idx = STARTUP_ORDER.indexOf(this.phase);
    if (idx < 0 || idx >= STARTUP_ORDER.length - 1) return null;
    return STARTUP_ORDER[idx + 1]!;
  }

  private async transition(target: LifecyclePhase): Promise<LifecyclePhase> {
    const previousPhase = this.phase;
    this.phase = target;

    const event: LifecycleEvent = {
      phase: target,
      previousPhase,
      timestamp: Date.now(),
    };

    this.transitionLog.push(event);
    if (this.transitionLog.length > this.maxLogSize) {
      this.transitionLog.splice(0, this.transitionLog.length - this.maxLogSize);
    }

    // Notify hooks for this phase
    const hooks = this.hooks.get(target);
    if (hooks) {
      for (const hook of hooks) {
        try {
          await hook(event);
        } catch (err) {
          console.error(`[lifecycle] hook error on phase '${target}':`, err);
        }
      }
    }

    return target;
  }
}

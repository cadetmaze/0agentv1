/**
 * Per-subagent timeout enforcer.
 *
 * Starts a timer that invokes a kill function when the deadline elapses.
 * The timer is unref'd so it does not keep the process alive.
 * cancel() is idempotent and safe to call multiple times.
 */
export class Watchdog {
  private readonly subagentId: string;
  private readonly timeoutMs: number;
  private readonly killFn: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(subagentId: string, timeoutMs: number, killFn: () => void) {
    this.subagentId = subagentId;
    this.timeoutMs = timeoutMs;
    this.killFn = killFn;
  }

  /**
   * Start the watchdog timer. If already started, this is a no-op.
   */
  start(): void {
    if (this.timer !== null) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.killFn();
    }, this.timeoutMs);

    // Allow the Node.js process to exit even if the timer is still pending.
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  /**
   * Cancel the watchdog timer. Idempotent — safe to call multiple times.
   */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

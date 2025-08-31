/**
 * Circuit breaker implementation to prevent cascade failures.
 * Monitors failure rates and stops requests when system is unhealthy.
 */

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeout: number;
  monitoringWindow: number;
  minimumCalls: number;
}

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private successes: number = 0;
  private lastFailureTime: number = 0;
  private calls: Array<{ timestamp: number; success: boolean }> = [];

  constructor(private config: CircuitBreakerConfig) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime < this.config.recoveryTimeout) {
        throw new Error('Circuit breaker is OPEN');
      }
      this.state = CircuitState.HALF_OPEN;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.successes++;
    this.recordCall(true);

    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.CLOSED;
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    this.recordCall(false);

    if (this.shouldOpenCircuit()) {
      this.state = CircuitState.OPEN;
    }
  }

  private recordCall(success: boolean): void {
    const now = Date.now();
    this.calls.push({ timestamp: now, success });

    // Remove old calls outside the monitoring window
    this.calls = this.calls.filter((call) => now - call.timestamp < this.config.monitoringWindow);
  }

  private shouldOpenCircuit(): boolean {
    if (this.calls.length < this.config.minimumCalls) {
      return false;
    }

    const recentCalls = this.calls.filter(
      (call) => Date.now() - call.timestamp < this.config.monitoringWindow
    );

    const failureRate = recentCalls.filter((call) => !call.success).length / recentCalls.length;
    return failureRate >= this.config.failureThreshold;
  }

  getState(): CircuitState {
    return this.state;
  }

  getStats() {
    const recentCalls = this.calls.filter(
      (call) => Date.now() - call.timestamp < this.config.monitoringWindow
    );

    return {
      state: this.state,
      totalCalls: recentCalls.length,
      failures: recentCalls.filter((call) => !call.success).length,
      successes: recentCalls.filter((call) => call.success).length,
      failureRate:
        recentCalls.length > 0
          ? recentCalls.filter((call) => !call.success).length / recentCalls.length
          : 0,
    };
  }
}

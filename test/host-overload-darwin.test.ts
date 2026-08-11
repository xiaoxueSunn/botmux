import { describe, expect, it } from 'vitest';
import {
  buildOverloadAlertCard,
  DEFAULT_OVERLOAD_THRESHOLDS,
  evaluateOverload,
  formatOverloadAlert,
  initialOverloadCardState,
  INITIAL_OVERLOAD_STATE,
  type HostReading,
  type OverloadThresholds,
} from '../src/core/host-overload-alert.js';

const GIB = 1024 ** 3;

function thresholds(): OverloadThresholds {
  return { cpuCount: 12, ...DEFAULT_OVERLOAD_THRESHOLDS };
}

function darwinReading(level: 'normal' | 'warning' | 'critical'): HostReading {
  return {
    load15: 3,
    memTotalBytes: 0,
    memFreeBytes: 0,
    memoryPressureLevel: level,
    swapUsedBytes: 6 * GIB,
    compressorBytesUsed: 10 * GIB,
  };
}

describe('Darwin kernel-pressure state machine', () => {
  it('debounces warning for ten seconds', () => {
    const first = evaluateOverload(INITIAL_OVERLOAD_STATE, darwinReading('warning'), thresholds(), 1_000);
    expect(first.action).toBeUndefined();
    expect(first.nextState.pressureWarningSince).toBe(1_000);

    const early = evaluateOverload(first.nextState, darwinReading('warning'), thresholds(), 10_999);
    expect(early.action).toBeUndefined();
    expect(early.nextState.overloaded).toBe(false);

    const entered = evaluateOverload(early.nextState, darwinReading('warning'), thresholds(), 11_000);
    expect(entered.action?.kind).toBe('entered');
    expect(entered.action?.reasons).toContain('memory_pressure');
  });

  it('resets the warning streak when pressure returns to normal', () => {
    const first = evaluateOverload(INITIAL_OVERLOAD_STATE, darwinReading('warning'), thresholds(), 1_000);
    const normal = evaluateOverload(first.nextState, darwinReading('normal'), thresholds(), 6_000);
    expect(normal.nextState.pressureWarningSince).toBeUndefined();
    expect(normal.nextState.overloaded).toBe(false);
  });

  it('enters critical immediately and bypasses the generic re-alert cooldown', () => {
    const recentlyRecovered = { overloaded: false, lastEnteredAlertAt: 9_500 };
    const result = evaluateOverload(recentlyRecovered, darwinReading('critical'), thresholds(), 10_000);
    expect(result.action?.kind).toBe('entered');
    expect(result.nextState.criticalAlerted).toBe(true);
  });

  it('emits one critical escalation during an existing warning or load episode', () => {
    const overloaded = { overloaded: true, lastEnteredAlertAt: 1_000, criticalAlerted: false };
    const escalated = evaluateOverload(overloaded, darwinReading('critical'), thresholds(), 20_000);
    expect(escalated.action?.kind).toBe('escalated');
    expect(escalated.action?.reasons).toContain('memory_pressure');

    const steady = evaluateOverload(escalated.nextState, darwinReading('critical'), thresholds(), 25_000);
    expect(steady.action).toBeUndefined();
  });

  it('does not recover until the kernel returns to normal', () => {
    const overloaded = { overloaded: true, lastEnteredAlertAt: 1_000, criticalAlerted: true };
    const warning = evaluateOverload(overloaded, darwinReading('warning'), thresholds(), 20_000);
    expect(warning.nextState.overloaded).toBe(true);

    const normal = evaluateOverload(warning.nextState, darwinReading('normal'), thresholds(), 25_000);
    expect(normal.nextState.overloaded).toBe(false);
    expect(normal.action?.kind).toBe('recovered');
  });

  it('does not treat high diagnostic swap usage as overload while pressure is normal', () => {
    const normal = evaluateOverload(INITIAL_OVERLOAD_STATE, darwinReading('normal'), thresholds(), 1_000);
    expect(normal.action).toBeUndefined();
    expect(normal.nextState.overloaded).toBe(false);
  });

  it('renders a sustained warning with the orange header', () => {
    const first = evaluateOverload(INITIAL_OVERLOAD_STATE, darwinReading('warning'), thresholds(), 1_000);
    const entered = evaluateOverload(first.nextState, darwinReading('warning'), thresholds(), 11_000);
    const state = initialOverloadCardState(entered.action!, { stopped: 0, idle: 0 }, 'nonce-warning');
    const card = JSON.parse(buildOverloadAlertCard(state));
    expect(card.header.template).toBe('orange');
    expect(JSON.stringify(card)).toContain('macOS 内存压力警告');
  });

  it('renders pressure and diagnostics without a fake memory percentage', () => {
    const result = evaluateOverload(
      INITIAL_OVERLOAD_STATE,
      darwinReading('critical'),
      thresholds(),
      1_000,
    );
    expect(result.action).toBeDefined();
    const text = formatOverloadAlert(result.action!);
    expect(text).toContain('macOS 内存压力危急');
    expect(text).toContain('Swap 已用 6.00 GB');
    expect(text).toContain('压缩内存 10.0 GB');
    expect(text).not.toContain('内存已用 0%');

    const state = initialOverloadCardState(result.action!, { stopped: 2, idle: 3 }, 'nonce-pressure');
    const card = buildOverloadAlertCard(state);
    expect(card).toContain('macOS 内存压力危急');
    expect(card).toContain('overload_clean_stopped');
    expect(card).toContain('overload_suspend_idle');
    expect(card).not.toContain('overload_close_app');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { DynamicBaselineEngine } from '../../src/detector/baseline/dynamic-baseline.js';
import { TimeWindowRingBuffer } from '../../src/detector/buffer/time-window-ring-buffer.js';
import { FlowEngine } from '../../src/detector/features/flow-engine.js';

describe('FlowEngine', () => {
  let baselineEngine: DynamicBaselineEngine;
  let flowEngine: FlowEngine;
  let ringBuffer: TimeWindowRingBuffer;
  const symbol = 'BTCUSDT';
  const now = 1_700_000_000_000;

  beforeEach(() => {
    baselineEngine = new DynamicBaselineEngine();
    flowEngine = new FlowEngine(baselineEngine);
    ringBuffer = new TimeWindowRingBuffer();

    // Establish normal baseline: 60s volume ~ $50,000, 50 trades/min, 50% buy pressure, CVD ~ 0 with realistic variance
    for (let i = 0; i < 60; i++) {
      const normalCvd = (Math.random() - 0.5) * 5_000;
      baselineEngine.recordSnapshot(symbol, 50_000 + (Math.random() - 0.5) * 10_000, normalCvd, 50, 0.5);
      baselineEngine.recordTrade(symbol, 500 + Math.random() * 500);
    }
  });

  it('evaluates normal flow state with low score and no bursts', () => {
    // Inject balanced normal trades across the last 60 seconds
    for (let sec = 59; sec >= 0; sec--) {
      ringBuffer.addTrade({
        symbol,
        tradeId: 100 + sec,
        price: 60_000,
        quantity: 0.015,
        quoteVolume: 900,
        timestamp: now - sec * 1000,
        isBuyerTaker: sec % 2 === 0, // Alternate buy and sell
      });
    }

    const flow = flowEngine.evaluateFlow(symbol, ringBuffer, now);

    expect(flow.symbol).toBe(symbol);
    expect(flow.aggressive.buyPressure['60s']).toBeCloseTo(0.5, 1);
    expect(flow.cvd.cvd['60s']).toBeCloseTo(0, 0);
    expect(flow.burst.isTradeBursting).toBe(false);
    expect(flow.volume.isVolumeAccelerating).toBe(false);
    expect(flow.flowScore).toBeLessThan(15);
  });

  it('detects aggressive buying burst, CVD acceleration, and high FLOW_SCORE', () => {
    // 1. Prior 30s to 15s ago: modest activity
    for (let sec = 30; sec > 15; sec--) {
      ringBuffer.addTrade({
        symbol,
        tradeId: 200 + sec,
        price: 60_000,
        quantity: 0.015,
        quoteVolume: 900,
        timestamp: now - sec * 1000,
        isBuyerTaker: true,
      });
    }

    // 2. In last 15s: Violent aggressive buy surge! (10 trades/sec, huge volume, CVD surge)
    for (let i = 0; i < 100; i++) {
      const ts = now - 10_000 + i * 100; // 10 trades per second
      ringBuffer.addTrade({
        symbol,
        tradeId: 1000 + i,
        price: 60_000 + (i * 2),
        quantity: 0.5,
        quoteVolume: 30_000, // $30k per trade -> whale buying!
        timestamp: ts,
        isBuyerTaker: true, // 100% aggressive taker buys
      });
    }

    const flow = flowEngine.evaluateFlow(symbol, ringBuffer, now);

    // Assert aggressive pressure
    expect(flow.aggressive.buyPressure['15s']).toBeGreaterThan(0.9);
    expect(flow.cvd.cvd['15s']).toBeGreaterThan(1_000_000);
    expect(flow.cvd.isCvdAccelerating).toBe(true);

    // Assert trade burst
    expect(flow.burst.tradesPerSecond).toBeGreaterThan(4);
    expect(flow.burst.isTradeBursting).toBe(true);

    // Assert large trades detected
    expect(flow.largeTrades.largeBuyCount_60s).toBeGreaterThan(5);
    expect(flow.largeTrades.largeBuyVolume_60s).toBeGreaterThan(1_000_000);

    // Assert FLOW_SCORE rises near maximum and strictly obeys 35 cap
    expect(flow.flowScore).toBeGreaterThanOrEqual(25);
    expect(flow.flowScore).toBeLessThanOrEqual(35);
  });

  it('detects CVD divergence when price is flat but aggressive CVD surges', () => {
    // Trades in last 60s at exact same price 60,000, but high buy taker volume
    for (let sec = 59; sec >= 0; sec--) {
      ringBuffer.addTrade({
        symbol,
        tradeId: 5000 + sec,
        price: 60_000, // Flat price (0% change)
        quantity: 0.5,
        quoteVolume: 30_000,
        timestamp: now - sec * 1000,
        isBuyerTaker: true,
      });
    }

    const flow = flowEngine.evaluateFlow(symbol, ringBuffer, now);
    expect(flow.cvd.cvdDivergence).toBe(true);
  });
});

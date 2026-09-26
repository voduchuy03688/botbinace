import { describe, it, expect } from 'vitest';
import {
  DynamicBaselineEngine,
  RollingWindowStats,
} from '../../src/detector/baseline/dynamic-baseline.js';

describe('RollingWindowStats', () => {
  it('calculates mean, std, median, MAD, and percentiles accurately', () => {
    const stats = new RollingWindowStats(100);
    // Add 1 to 10
    for (let i = 1; i <= 10; i++) {
      stats.add(i);
    }

    const metrics = stats.calculateMetrics();
    expect(metrics.count).toBe(10);
    expect(metrics.mean).toBe(5.5);
    expect(metrics.min).toBe(1);
    expect(metrics.max).toBe(10);
    expect(metrics.median).toBe(5.5);
    expect(metrics.p90).toBeGreaterThanOrEqual(9);
    expect(metrics.p99).toBeGreaterThan(9.5);
    expect(metrics.std).toBeGreaterThan(2.5);
  });

  it('calculates Z-scores correctly', () => {
    const stats = new RollingWindowStats(100);
    // Mean = 100, numbers symmetrically distributed around 100
    stats.add(90);
    stats.add(100);
    stats.add(110);

    const z100 = stats.calculateZScore(100);
    const z110 = stats.calculateZScore(110);
    const z90 = stats.calculateZScore(90);

    expect(Math.abs(z100)).toBeLessThan(1e-5);
    expect(z110).toBeGreaterThan(1);
    expect(z90).toBeLessThan(-1);
  });

  it('calculates percentile rank correctly', () => {
    const stats = new RollingWindowStats(100);
    for (let i = 1; i <= 100; i++) {
      stats.add(i);
    }
    expect(stats.calculatePercentileRank(50)).toBe(49);
    expect(stats.calculatePercentileRank(95)).toBe(94);
  });

  it('slides window when capacity reached', () => {
    const stats = new RollingWindowStats(10);
    for (let i = 1; i <= 15; i++) {
      stats.add(i);
    }
    expect(stats.length).toBe(10);
    const metrics = stats.calculateMetrics();
    expect(metrics.min).toBe(6);
    expect(metrics.max).toBe(15);
  });
});

describe('DynamicBaselineEngine', () => {
  it('tracks token specific trade size and calculates P95/P99 thresholds', () => {
    const engine = new DynamicBaselineEngine();
    // Simulate typical retail trades + a few whale trades (top 6%)
    for (let i = 0; i < 94; i++) {
      engine.recordTrade('BTCUSDT', 100 + Math.random() * 500); // 100 - 600 USDT
    }
    for (let i = 0; i < 6; i++) {
      engine.recordTrade('BTCUSDT', 25_000 + i * 5000); // Whale trades: 25k - 50k USDT
    }

    const thresholds = engine.getLargeTradeThresholds('BTCUSDT');
    expect(thresholds.p95).toBeGreaterThan(5000);
    expect(thresholds.p99).toBeGreaterThan(thresholds.p95);
  });

  it('normalizes volume and CVD with dynamic Z-scores per token', () => {
    const engine = new DynamicBaselineEngine();
    // Record baseline 60s snapshots (mean ~50,000 USDT)
    for (let i = 0; i < 50; i++) {
      engine.recordSnapshot('ETHUSDT', 50_000 + (Math.random() - 0.5) * 10_000, 0, 100, 0.5);
    }

    const normalZ = engine.calculateVolumeZ('ETHUSDT', 52_000);
    const surgeZ = engine.calculateVolumeZ('ETHUSDT', 250_000); // 5x volume spike

    expect(Math.abs(normalZ)).toBeLessThan(2.0);
    expect(surgeZ).toBeGreaterThan(10.0);
  });
});

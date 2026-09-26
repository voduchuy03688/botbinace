import { describe, it, expect, beforeEach } from 'vitest';
import { ScoringEngine } from '../../src/detector/scoring/scoring-engine.js';
import { FlowFeatureSnapshot } from '../../src/detector/types/feature.types.js';
import { LiquidityFeatureSnapshot } from '../../src/detector/types/liquidity.types.js';
import { StructureFeatureSnapshot } from '../../src/detector/types/structure.types.js';
import { DerivativesMarketSnapshot } from '../../src/detector/types/derivatives-market.types.js';
import { NormalizedDepthSnapshot } from '../../src/detector/types/market-event.types.js';

describe('ScoringEngine', () => {
  let scoringEngine: ScoringEngine;
  const symbol = 'BTCUSDT';
  const now = 1_700_000_000_000;

  beforeEach(() => {
    scoringEngine = new ScoringEngine();
  });

  const createMockDepth = (midPrice = 60_000, askQty = 50): NormalizedDepthSnapshot => ({
    symbol,
    timestamp: now,
    bids: [[midPrice - 5, 20]],
    asks: [
      [midPrice + 5, askQty * 0.2],
      [midPrice + 10, askQty * 0.8],
    ],
  });

  it('outputs NORMAL state and NONE signal for low score activity', () => {
    const mockFlow = {
      flowScore: 10,
      volume: { volume_Z_60s: 0.2 },
      cvd: { cvd_Z_60s: 0.1, cvdAcceleration_15s: 0 },
      aggressive: { buyPressure: { '15s': 0.5 } },
      burst: { tradesPerSecond: 2 },
    } as unknown as FlowFeatureSnapshot;

    const output = scoringEngine.evaluate(symbol, mockFlow, null, null, null, createMockDepth(), now);

    expect(output.symbol).toBe(symbol);
    expect(output.state).toBe('NORMAL');
    expect(output.signal).toBe('NONE');
    expect(output.execution).toBe('PASS');
    expect(output.totalScore).toBeLessThan(65);
  });

  it('transitions to READY and fires EXECUTE when all groups converge with micro-trigger', () => {
    const mockFlow = {
      flowScore: 30, // 30 / 35
      volume: { volume_Z_60s: 4.5 },
      cvd: { cvd_Z_60s: 3.8, cvdAcceleration_15s: 1500 },
      aggressive: { buyPressure: { '15s': 0.85 } },
      burst: { tradesPerSecond: 18 },
    } as unknown as FlowFeatureSnapshot;

    const mockLiquidity = {
      liquidityScore: 25, // 25 / 30
      depletion: { askDepletionRate: 0.65, isConsumedByMarketBuy: true, isAskDepleting: true },
      vacuum: { vacuumScore: 0.85, isVacuumPresent: true },
      spread: { currentSpreadPct: 0.02, spreadVolatility_30s: 0.01, isSpreadExcessive: false },
      orderBook: { overallImbalance_1pct: 0.35 },
    } as unknown as LiquidityFeatureSnapshot;

    const mockStructure = {
      structureScore: 17, // 17 / 20
      compression: { isCompressed: true },
      breakout: { isMicroBreakout: true, isChasingExcessivePump: false },
    } as unknown as StructureFeatureSnapshot;

    const mockDerivatives = {
      derivativeScore: 8, // 8 / 10
      marketScore: 4, // 4 / 5
      btcRegime: { isBtcCrashing: false },
      oi: { oiAcceleration: 1.5 },
      liquidation: { shortLiquidationAcceleration: 2.0 },
    } as unknown as DerivativesMarketSnapshot;

    // Simulate 3 CUSUM update ticks to build change-point momentum
    scoringEngine.evaluate(symbol, mockFlow, mockLiquidity, mockStructure, mockDerivatives, createMockDepth(), now - 2000);
    scoringEngine.evaluate(symbol, mockFlow, mockLiquidity, mockStructure, mockDerivatives, createMockDepth(), now - 1000);

    const output = scoringEngine.evaluate(
      symbol,
      mockFlow,
      mockLiquidity,
      mockStructure,
      mockDerivatives,
      createMockDepth(),
      now,
    );

    expect(output.totalScore).toBeGreaterThanOrEqual(84);
    expect(output.changePointScore).toBeGreaterThanOrEqual(0.6);
    expect(output.execution).toBe('PASS');
    expect(output.state).toBe('EXPANSION');
    expect(output.signal).toBe('EXECUTE');
    expect(output.leadTimeEstimate).toBeGreaterThan(5);
  });

  it('rejects execution when BTC is crashing', () => {
    const mockFlow = {
      flowScore: 30,
      volume: { volume_Z_60s: 4.0 },
      cvd: { cvd_Z_60s: 3.0, cvdAcceleration_15s: 1000 },
      aggressive: { buyPressure: { '15s': 0.8 } },
      burst: { tradesPerSecond: 10 },
    } as unknown as FlowFeatureSnapshot;

    const mockDerivatives = {
      derivativeScore: 5,
      marketScore: 0,
      btcRegime: { isBtcCrashing: true }, // BTC CRASH!
      oi: { oiAcceleration: 0 },
      liquidation: { shortLiquidationAcceleration: 0 },
    } as unknown as DerivativesMarketSnapshot;

    const output = scoringEngine.evaluate(symbol, mockFlow, null, null, mockDerivatives, createMockDepth(), now);

    expect(output.execution).toBe('REJECT');
    expect(output.rejectionReason).toContain('BTC is currently in a severe crash regime');
    expect(output.signal).not.toBe('EXECUTE');
  });

  it('rejects execution when excessive pump already occurred', () => {
    const mockFlow = {
      flowScore: 30,
      volume: { volume_Z_60s: 3.5 },
      cvd: { cvd_Z_60s: 3.0, cvdAcceleration_15s: 1000 },
      aggressive: { buyPressure: { '15s': 0.8 } },
      burst: { tradesPerSecond: 10 },
    } as unknown as FlowFeatureSnapshot;

    const mockStructure = {
      structureScore: 8,
      compression: { isCompressed: false },
      breakout: { isMicroBreakout: true, isChasingExcessivePump: true }, // Chasing!
    } as unknown as StructureFeatureSnapshot;

    const output = scoringEngine.evaluate(symbol, mockFlow, null, mockStructure, null, createMockDepth(), now);

    expect(output.execution).toBe('REJECT');
    expect(output.rejectionReason).toContain('Price has already pumped excessively');
    expect(output.signal).not.toBe('EXECUTE');
  });
});

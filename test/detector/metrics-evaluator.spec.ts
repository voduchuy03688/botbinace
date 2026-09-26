import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsEvaluator } from '../../src/detector/backtest/metrics-evaluator.js';
import { DetectorOutput } from '../../src/detector/types/detector-output.types.js';
import { NormalizedTrade } from '../../src/detector/types/market-event.types.js';

describe('MetricsEvaluator', () => {
  let evaluator: MetricsEvaluator;
  const t0 = 1_700_000_000_000;
  const entryPrice = 100.0;

  beforeEach(() => {
    evaluator = new MetricsEvaluator();
  });

  const mockDetectorOutput: DetectorOutput = {
    symbol: 'SOLUSDT',
    timestamp: t0,
    state: 'EXPANSION',
    flowScore: 32,
    liquidityScore: 26,
    structureScore: 18,
    derivativeScore: 8,
    marketScore: 4,
    totalScore: 88,
    changePointScore: 0.85,
    cvdAcceleration: 500,
    buyPressure: 0.82,
    tradeBurst: 15,
    volumeZ: 4.2,
    askDepletion: 0.7,
    liquidityVacuum: 0.8,
    oiAcceleration: 1.2,
    shortLiquidationAcceleration: 2.1,
    spread: 0.02,
    estimatedSlippage: 0.05,
    manipulationScore: 0.05,
    probability_1pct_30s: 0.88,
    probability_2pct_60s: 0.79,
    expectedMFE: 3.08,
    expectedMAE: 0.45,
    leadTimeEstimate: 12.5,
    execution: 'PASS',
    signal: 'EXECUTE',
  };

  it('evaluates winning signal with exact MFE, MAE, and lead time', () => {
    // Generate future trades:
    // 5s: dips slightly to 99.8 (-0.2%)
    // 12s: surges to 101.0 (+1.0% -> Lead time = 12s!)
    // 45s: peaks at 102.6 (+2.6%)
    const futureTrades: NormalizedTrade[] = [
      {
        symbol: 'SOLUSDT',
        tradeId: 1,
        price: 99.8,
        quantity: 1,
        quoteVolume: 99.8,
        timestamp: t0 + 5000,
        isBuyerTaker: false,
      },
      {
        symbol: 'SOLUSDT',
        tradeId: 2,
        price: 101.0,
        quantity: 1,
        quoteVolume: 101.0,
        timestamp: t0 + 12000, // 12 seconds elapsed
        isBuyerTaker: true,
      },
      {
        symbol: 'SOLUSDT',
        tradeId: 3,
        price: 102.6,
        quantity: 1,
        quoteVolume: 102.6,
        timestamp: t0 + 45000,
        isBuyerTaker: true,
      },
    ];

    const outcome = evaluator.evaluateSignalOutcome(
      mockDetectorOutput,
      entryPrice,
      futureTrades,
      1.5,
      -0.6,
    );

    expect(outcome.symbol).toBe('SOLUSDT');
    expect(outcome.entryPrice).toBe(100.0);
    expect(outcome.isWin).toBe(true);
    expect(outcome.mfe_60s).toBe(2.6);
    expect(outcome.mae_60s).toBe(-0.2);
    expect(outcome.leadTimeSeconds).toBe(12.0);
    expect(outcome.hit_1pct_30s).toBe(true);
    expect(outcome.hit_2pct_60s).toBe(true);
  });

  it('aggregates multi-trade backtest outcomes into summary metrics', () => {
    const outcome1 = evaluator.evaluateSignalOutcome(
      mockDetectorOutput,
      100.0,
      [
        { symbol: 'SOLUSDT', tradeId: 1, price: 102.0, quantity: 1, quoteVolume: 102, timestamp: t0 + 10000, isBuyerTaker: true },
      ],
      1.5,
      -0.6,
    );

    const outcome2 = evaluator.evaluateSignalOutcome(
      mockDetectorOutput,
      100.0,
      [
        { symbol: 'SOLUSDT', tradeId: 2, price: 99.2, quantity: 1, quoteVolume: 99.2, timestamp: t0 + 10000, isBuyerTaker: false },
      ],
      1.5,
      -0.6,
    );

    const summary = evaluator.calculateBacktestSummary([outcome1, outcome2]);

    expect(summary.totalSignals).toBe(2);
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(1);
    expect(summary.winRate).toBe(50);
    expect(summary.precision).toBe(0.5);
    expect(summary.averageLeadTimeSeconds).toBe(10.0);
  });
});

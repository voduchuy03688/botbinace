import { describe, it, expect } from 'vitest';
import { TimeWindowRingBuffer } from '../../src/detector/buffer/time-window-ring-buffer.js';

describe('TimeWindowRingBuffer', () => {
  it('correctly aggregates trades across multi-window durations', () => {
    const buffer = new TimeWindowRingBuffer();
    const now = 1_700_000_000_000;

    // Add trades spanning from 50s ago to 2s ago in chronological order
    // 50s ago: 1 large buy trade ($50,000)
    buffer.addTrade({
      symbol: 'SOLUSDT',
      tradeId: 1,
      price: 149.5,
      quantity: 334.45,
      quoteVolume: 50_000,
      timestamp: now - 50000,
      isBuyerTaker: true,
    });

    // 25s ago: 1 sell trade
    buffer.addTrade({
      symbol: 'SOLUSDT',
      tradeId: 2,
      price: 149.8,
      quantity: 15,
      quoteVolume: 2247,
      timestamp: now - 25000,
      isBuyerTaker: false,
    });

    // 3s ago: 1st aggressive buy trade
    buffer.addTrade({
      symbol: 'SOLUSDT',
      tradeId: 3,
      price: 150.0,
      quantity: 10,
      quoteVolume: 1500,
      timestamp: now - 3000,
      isBuyerTaker: true,
    });

    // 2s ago: 2nd aggressive buy trade
    buffer.addTrade({
      symbol: 'SOLUSDT',
      tradeId: 4,
      price: 150.2,
      quantity: 20,
      quoteVolume: 3004,
      timestamp: now - 2000,
      isBuyerTaker: true,
    });

    // 5s window aggregates
    const agg5s = buffer.getAggregatesForWindow(5000, 10_000, now);
    expect(agg5s.tradeCount).toBe(2);
    expect(agg5s.totalQuoteVolume).toBe(4504);
    expect(agg5s.buyQuoteVolume).toBe(4504);
    expect(agg5s.sellQuoteVolume).toBe(0);
    expect(agg5s.cvd).toBe(4504);
    expect(agg5s.buyPressure).toBe(1.0);
    expect(agg5s.openPrice).toBe(150.0);
    expect(agg5s.closePrice).toBe(150.2);
    expect(agg5s.highPrice).toBe(150.2);
    expect(agg5s.lowPrice).toBe(150.0);

    // 30s window aggregates (includes the 25s sell trade)
    const agg30s = buffer.getAggregatesForWindow(30000, 10_000, now);
    expect(agg30s.tradeCount).toBe(3);
    expect(agg30s.buyQuoteVolume).toBe(4504);
    expect(agg30s.sellQuoteVolume).toBe(2247);
    expect(agg30s.cvd).toBe(4504 - 2247);
    expect(agg30s.buyPressure).toBeCloseTo(4504 / (4504 + 2247), 3);

    // 60s window aggregates (includes the large $50,000 trade)
    const agg60s = buffer.getAggregatesForWindow(60000, 10_000, now);
    expect(agg60s.tradeCount).toBe(4);
    expect(agg60s.largeBuyCount).toBe(1);
    expect(agg60s.largeBuyVolume).toBe(50_000);
    expect(agg60s.largeSellCount).toBe(0);
  });

  it('prunes stale trades beyond max duration', () => {
    const buffer = new TimeWindowRingBuffer(60 * 1000); // 1 minute max retention
    const baseTime = 1_000_000;

    // Add trade at T=0
    buffer.addTrade({
      symbol: 'BTCUSDT',
      tradeId: 1,
      price: 60000,
      quantity: 1,
      quoteVolume: 60000,
      timestamp: baseTime,
      isBuyerTaker: true,
    });

    // Add 1000 trades to trigger prune interval at T=70,000 ms
    for (let i = 2; i <= 1005; i++) {
      buffer.addTrade({
        symbol: 'BTCUSDT',
        tradeId: i,
        price: 60000,
        quantity: 0.1,
        quoteVolume: 6000,
        timestamp: baseTime + 70_000 + i,
        isBuyerTaker: true,
      });
    }

    // Trade 1 at baseTime (70s ago) should have been pruned
    const trades = buffer.getTradesInWindow(120_000, baseTime + 72_000);
    expect(trades.find((t) => t.tradeId === 1)).toBeUndefined();
  });
});

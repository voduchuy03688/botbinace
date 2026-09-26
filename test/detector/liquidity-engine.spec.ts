import { describe, it, expect, beforeEach } from 'vitest';
import { DynamicBaselineEngine } from '../../src/detector/baseline/dynamic-baseline.js';
import { OrderBookHistoryBuffer } from '../../src/detector/buffer/orderbook-history-buffer.js';
import { TimeWindowRingBuffer } from '../../src/detector/buffer/time-window-ring-buffer.js';
import { LiquidityEngine } from '../../src/detector/features/liquidity-engine.js';
import { NormalizedDepthSnapshot } from '../../src/detector/types/market-event.types.js';

describe('LiquidityEngine', () => {
  let baselineEngine: DynamicBaselineEngine;
  let liquidityEngine: LiquidityEngine;
  let bookBuffer: OrderBookHistoryBuffer;
  let tradeBuffer: TimeWindowRingBuffer;
  const symbol = 'BTCUSDT';
  const now = 1_700_000_000_000;

  beforeEach(() => {
    baselineEngine = new DynamicBaselineEngine();
    liquidityEngine = new LiquidityEngine(baselineEngine);
    bookBuffer = new OrderBookHistoryBuffer();
    tradeBuffer = new TimeWindowRingBuffer();
  });

  const createDepthSnapshot = (
    timestamp: number,
    midPrice = 60_000,
    bidVol = 50, // in BTC
    askVol = 50,
  ): NormalizedDepthSnapshot => {
    return {
      symbol,
      timestamp,
      bids: [
        [midPrice - 5, bidVol * 0.1], // within 0.05%
        [midPrice - 20, bidVol * 0.2], // within 0.10%
        [midPrice - 100, bidVol * 0.3], // within 0.25%
        [midPrice - 250, bidVol * 0.4], // within 0.50%
      ],
      asks: [
        [midPrice + 5, askVol * 0.1],
        [midPrice + 20, askVol * 0.2],
        [midPrice + 100, askVol * 0.3],
        [midPrice + 250, askVol * 0.4],
      ],
    };
  };

  it('evaluates normal balanced orderbook with tight spread', () => {
    bookBuffer.addDepth(createDepthSnapshot(now - 10_000, 60_000, 50, 50));
    bookBuffer.addDepth(createDepthSnapshot(now, 60_000, 50, 50));

    const snap = liquidityEngine.evaluateLiquidity(symbol, bookBuffer, tradeBuffer, now);
    expect(snap).not.toBeNull();
    expect(snap!.orderBook.spreadPct).toBeLessThan(0.05);
    expect(snap!.depletion.isAskDepleting).toBe(false);
    expect(snap!.vacuum.isVacuumPresent).toBe(false);
    expect(snap!.spread.isSpreadStable).toBe(true);
    expect(snap!.liquidityScore).toBeLessThan(12);
  });

  it('confirms genuine ask depletion when consumed by market buys', () => {
    // 10s ago: thick ask book (100 BTC ~ $6,000,000)
    bookBuffer.addDepth(createDepthSnapshot(now - 10_000, 60_000, 50, 100));

    // Now: depleted ask book (20 BTC ~ $1,200,000) -> 80% depletion
    bookBuffer.addDepth(createDepthSnapshot(now, 60_000, 50, 20));

    // Market buy trades in last 15s eating the ask ($3,500,000 taker buy volume)
    for (let i = 0; i < 35; i++) {
      tradeBuffer.addTrade({
        symbol,
        tradeId: 100 + i,
        price: 60_000,
        quantity: 1.66,
        quoteVolume: 100_000,
        timestamp: now - 8_000 + i * 200,
        isBuyerTaker: true, // Aggressive buy
      });
    }

    const snap = liquidityEngine.evaluateLiquidity(symbol, bookBuffer, tradeBuffer, now);
    expect(snap).not.toBeNull();
    expect(snap!.depletion.askDepletionRate).toBeGreaterThan(0.7);
    expect(snap!.depletion.isConsumedByMarketBuy).toBe(true);
    expect(snap!.depletion.isAskDepleting).toBe(true);
    expect(snap!.liquidityScore).toBeGreaterThanOrEqual(15);
  });

  it('rejects ask depletion when ask is cancelled without market buy trades (spoof cancel)', () => {
    // 10s ago: thick ask wall (100 BTC)
    bookBuffer.addDepth(createDepthSnapshot(now - 10_000, 60_000, 50, 100));

    // Now: ask wall pulled (only 20 BTC left)
    bookBuffer.addDepth(createDepthSnapshot(now, 60_000, 50, 20));

    // BUT ZERO trades in tradeBuffer (or tiny retail trades)
    // Taker buy volume is $0!

    const snap = liquidityEngine.evaluateLiquidity(symbol, bookBuffer, tradeBuffer, now);
    expect(snap).not.toBeNull();
    expect(snap!.depletion.askDepletionRate).toBeGreaterThan(0.7);
    // CRITICAL Spec Section 13: Must NOT count as genuine bullish depletion!
    expect(snap!.depletion.isConsumedByMarketBuy).toBe(false);
    expect(snap!.depletion.isAskDepleting).toBe(false);
  });

  it('detects liquidity vacuum when ask liquidity above market is hollowed out', () => {
    // Asks are extremely thin: 0.1 BTC total, while bids are 50 BTC
    const thinAskSnapshot: NormalizedDepthSnapshot = {
      symbol,
      timestamp: now,
      bids: [[59_990, 20], [59_950, 30]],
      asks: [
        [60_010, 0.02], // $1,200 (super thin!)
        [60_030, 0.03], // $1,800
        [60_050, 0.05], // $3,000
      ],
    };
    bookBuffer.addDepth(thinAskSnapshot);

    // Taker buys present
    tradeBuffer.addTrade({
      symbol,
      tradeId: 999,
      price: 60_000,
      quantity: 1.0,
      quoteVolume: 60_000,
      timestamp: now - 2000,
      isBuyerTaker: true,
    });

    const snap = liquidityEngine.evaluateLiquidity(symbol, bookBuffer, tradeBuffer, now);
    expect(snap).not.toBeNull();
    expect(snap!.vacuum.vacuumScore).toBeGreaterThanOrEqual(0.6);
  });

  it('detects bid replenishment and demand absorption when heavy sells hit resilient bids', () => {
    // 10s ago: 50 BTC bids
    bookBuffer.addDepth(createDepthSnapshot(now - 10_000, 60_000, 50, 50));
    // Now: Bids still at 50 BTC (replenished!)
    bookBuffer.addDepth(createDepthSnapshot(now, 60_000, 50, 50));

    // Heavy market selling in trade buffer ($200,000 aggressive sell volume)
    for (let i = 0; i < 2; i++) {
      tradeBuffer.addTrade({
        symbol,
        tradeId: 800 + i,
        price: 59_995,
        quantity: 1.66,
        quoteVolume: 100_000,
        timestamp: now - 5_000 + i * 1000,
        isBuyerTaker: false, // Aggressive sell!
      });
    }

    const snap = liquidityEngine.evaluateLiquidity(symbol, bookBuffer, tradeBuffer, now);
    expect(snap).not.toBeNull();
    expect(snap!.replenishment.isDemandAbsorption).toBe(true);
  });

  it('detects excessive spread and limits LIQUIDITY_SCORE to cap of 30', () => {
    // Wide spread: Bid 59,800, Ask 60,200 -> spread 400 (0.66%)
    const wideSpreadSnapshot: NormalizedDepthSnapshot = {
      symbol,
      timestamp: now,
      bids: [[59_800, 10]],
      asks: [[60_200, 10]],
    };
    bookBuffer.addDepth(wideSpreadSnapshot);

    const snap = liquidityEngine.evaluateLiquidity(symbol, bookBuffer, tradeBuffer, now);
    expect(snap).not.toBeNull();
    expect(snap!.spread.isSpreadExcessive).toBe(true);
    expect(snap!.spread.isSpreadStable).toBe(false);
    expect(snap!.liquidityScore).toBeLessThanOrEqual(30);
  });
});

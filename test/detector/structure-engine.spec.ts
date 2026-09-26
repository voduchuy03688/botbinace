import { describe, it, expect, beforeEach } from 'vitest';
import { TimeWindowRingBuffer } from '../../src/detector/buffer/time-window-ring-buffer.js';
import { StructureEngine } from '../../src/detector/features/structure-engine.js';
import { FlowFeatureSnapshot } from '../../src/detector/types/feature.types.js';

describe('StructureEngine', () => {
  let structureEngine: StructureEngine;
  let tradeBuffer: TimeWindowRingBuffer;
  const symbol = 'BTCUSDT';
  const now = 1_700_000_000_000;

  beforeEach(() => {
    structureEngine = new StructureEngine();
    tradeBuffer = new TimeWindowRingBuffer();
  });

  it('detects volatility compression when price is coiling within tight 15m range', () => {
    // Generate trades over last 15 minutes between 60,000 and 60,600 (range 1.0%)
    for (let min = 15; min >= 0; min--) {
      tradeBuffer.addTrade({
        symbol,
        tradeId: 100 + min,
        price: 60_000 + (min % 3) * 200, // 60,000 to 60,400
        quantity: 1.0,
        quoteVolume: 60_000,
        timestamp: now - min * 60 * 1000,
        isBuyerTaker: true,
      });
    }

    const structure = structureEngine.evaluateStructure(symbol, tradeBuffer, undefined, undefined, now);
    expect(structure).not.toBeNull();
    expect(structure!.compression.isCompressed).toBe(true);
    expect(structure!.compression.rollingRangePct_15m).toBeLessThan(1.5);
    expect(structure!.breakout.isChasingExcessivePump).toBe(false);
  });

  it('detects micro breakout with early entry and flow confirmation', () => {
    const basePrice = 60_000;
    // 5m ago to 30s ago: trades up to 60,200 (micro high = 60,200)
    for (let sec = 300; sec >= 30; sec -= 10) {
      tradeBuffer.addTrade({
        symbol,
        tradeId: 200 + sec,
        price: basePrice + Math.sin(sec) * 150, // 59,850 to 60,150
        quantity: 0.5,
        quoteVolume: 30_000,
        timestamp: now - sec * 1000,
        isBuyerTaker: false,
      });
    }

    // Micro high set at 60,150.
    // In last 15s: price breaks out cleanly to 60,250 (+0.16% above micro high)
    for (let sec = 14; sec >= 0; sec -= 2) {
      tradeBuffer.addTrade({
        symbol,
        tradeId: 1000 + sec,
        price: 60_160 + (14 - sec) * 8, // climbs to 60,272
        quantity: 1.0,
        quoteVolume: 60_000,
        timestamp: now - sec * 1000,
        isBuyerTaker: true,
      });
    }

    // Mock confirmed flow snapshot
    const mockFlow = {
      aggressive: { buyPressure: { '15s': 0.85 } },
      cvd: { isCvdAccelerating: true },
    } as unknown as FlowFeatureSnapshot;

    const structure = structureEngine.evaluateStructure(symbol, tradeBuffer, undefined, mockFlow, now);
    expect(structure).not.toBeNull();
    expect(structure!.breakout.isMicroBreakout).toBe(true);
    expect(structure!.breakout.breakoutDistancePct).toBeGreaterThan(0);
    expect(structure!.breakout.breakoutDistancePct).toBeLessThan(1.5);
    expect(structure!.structureScore).toBeGreaterThanOrEqual(14);
    expect(structure!.structureScore).toBeLessThanOrEqual(20);
  });

  it('penalizes score and rejects when price has already pumped excessively (anti-chasing guard)', () => {
    // 15m ago: price was 60,000.
    tradeBuffer.addTrade({
      symbol,
      tradeId: 1,
      price: 60_000,
      quantity: 1,
      quoteVolume: 60_000,
      timestamp: now - 15 * 60 * 1000,
      isBuyerTaker: true,
    });

    // 5m ago: 60,500
    tradeBuffer.addTrade({
      symbol,
      tradeId: 2,
      price: 60_500,
      quantity: 1,
      quoteVolume: 60_500,
      timestamp: now - 5 * 60 * 1000,
      isBuyerTaker: true,
    });

    // Now: price surged to 63,500 (+5.8% pump!)
    tradeBuffer.addTrade({
      symbol,
      tradeId: 3,
      price: 63_500,
      quantity: 1,
      quoteVolume: 63_500,
      timestamp: now - 1000,
      isBuyerTaker: true,
    });

    const structure = structureEngine.evaluateStructure(symbol, tradeBuffer, undefined, undefined, now);
    expect(structure).not.toBeNull();
    expect(structure!.breakout.isChasingExcessivePump).toBe(true);
    // Score penalized
    expect(structure!.structureScore).toBeLessThanOrEqual(10);
  });
});

import {
  MicroBreakoutFeatures,
  MultiTimeframeAlignmentFeatures,
  PriceActionFeatures,
  StructureFeatureSnapshot,
  VolatilityCompressionFeatures,
} from '../types/structure.types.js';
import {
  TIME_WINDOW_MS,
  TimeWindowKey,
} from '../types/market-event.types.js';
import { TimeWindowRingBuffer } from '../buffer/time-window-ring-buffer.js';
import { FlowFeatureSnapshot } from '../types/feature.types.js';
import { OrderBookHistoryBuffer } from '../buffer/orderbook-history-buffer.js';

export class StructureEngine {
  evaluateStructure(
    symbol: string,
    tradeBuffer: TimeWindowRingBuffer,
    bookBuffer?: OrderBookHistoryBuffer,
    flowSnapshot?: FlowFeatureSnapshot,
    now = Date.now(),
  ): StructureFeatureSnapshot | null {
    if (tradeBuffer.length === 0) return null;

    const currentPrice = tradeBuffer.getLatestPrice();
    if (currentPrice <= 0) return null;

    // 1. Fetch Window Aggregates
    const agg5s = tradeBuffer.getAggregatesForWindow(TIME_WINDOW_MS['5s'], 5000, now);
    const agg10s = tradeBuffer.getAggregatesForWindow(TIME_WINDOW_MS['10s'], 5000, now);
    const agg15s = tradeBuffer.getAggregatesForWindow(TIME_WINDOW_MS['15s'], 5000, now);
    const agg30s = tradeBuffer.getAggregatesForWindow(TIME_WINDOW_MS['30s'], 5000, now);
    const agg60s = tradeBuffer.getAggregatesForWindow(TIME_WINDOW_MS['60s'], 5000, now);
    const agg3m = tradeBuffer.getAggregatesForWindow(TIME_WINDOW_MS['3m'], 5000, now);
    const agg5m = tradeBuffer.getAggregatesForWindow(TIME_WINDOW_MS['5m'], 5000, now);
    const agg15m = tradeBuffer.getAggregatesForWindow(TIME_WINDOW_MS['15m'], 5000, now);
    const agg1h = tradeBuffer.getAggregatesForWindow(TIME_WINDOW_MS['1h'], 5000, now);

    // Calculate returns across windows
    const calculateReturn = (open: number, close: number): number => {
      return open > 0 ? ((close - open) / open) * 100 : 0;
    };

    const returns: Record<TimeWindowKey, number> = {
      '5s': calculateReturn(agg5s.openPrice, agg5s.closePrice),
      '10s': calculateReturn(agg10s.openPrice, agg10s.closePrice),
      '15s': calculateReturn(agg15s.openPrice, agg15s.closePrice),
      '30s': calculateReturn(agg30s.openPrice, agg30s.closePrice),
      '60s': calculateReturn(agg60s.openPrice, agg60s.closePrice),
      '3m': calculateReturn(agg3m.openPrice, agg3m.closePrice),
      '5m': calculateReturn(agg5m.openPrice, agg5m.closePrice),
      '15m': calculateReturn(agg15m.openPrice, agg15m.closePrice),
      '1h': calculateReturn(agg1h.openPrice, agg1h.closePrice),
    };

    // Price velocity & acceleration
    const prevAgg10s = tradeBuffer.getAggregatesForWindow(
      10_000,
      5000,
      now - 10_000,
    );
    const prevReturn10s = calculateReturn(
      prevAgg10s.openPrice,
      prevAgg10s.closePrice,
    );

    const priceVelocity_10s = returns['10s'] / 10;
    const prevPriceVelocity_10s = prevReturn10s / 10;
    const priceAcceleration_10s = priceVelocity_10s - prevPriceVelocity_10s;

    // Micro High/Low (from 5m window prior to current 15s to detect true breakout)
    const prior5mAgg = tradeBuffer.getAggregatesForWindow(
      285_000,
      5000,
      now - 15_000,
    );
    const microHigh_5m =
      prior5mAgg.tradeCount > 0 ? prior5mAgg.highPrice : agg5m.highPrice;
    const microLow_5m = agg5m.lowPrice;

    const localResistance = Math.max(microHigh_5m, agg15m.highPrice);
    const localSupport = agg15m.lowPrice;

    const distanceToResistancePct =
      localResistance > 0
        ? Math.max(0, ((localResistance - currentPrice) / currentPrice) * 100)
        : 0;
    const distanceToSupportPct =
      localSupport > 0
        ? Math.max(0, ((currentPrice - localSupport) / localSupport) * 100)
        : 0;

    const higherHigh =
      agg60s.highPrice >= agg5m.highPrice * 0.9995 && returns['60s'] > 0;
    const higherLow = agg60s.lowPrice >= agg5m.lowPrice;

    const priceAction: PriceActionFeatures = {
      returns,
      priceVelocity_10s,
      priceAcceleration_10s,
      microHigh_5m,
      microLow_5m,
      localResistance,
      localSupport,
      distanceToResistancePct,
      distanceToSupportPct,
      higherHigh,
      higherLow,
    };

    // 2. Volatility Compression
    const range15m = agg15m.highPrice - agg15m.lowPrice;
    const rollingRangePct_15m =
      agg15m.lowPrice > 0 ? (range15m / agg15m.lowPrice) * 100 : 0;

    const range1h = agg1h.highPrice - agg1h.lowPrice;
    const rollingRangePct_1h =
      agg1h.lowPrice > 0 ? (range1h / agg1h.lowPrice) * 100 : 0;

    const compressionRatio =
      rollingRangePct_1h > 0 ? rollingRangePct_15m / rollingRangePct_1h : 1.0;

    // Spec Section 18: Volatility compression is a core setup condition (range <= 2.8%)
    const isCompressed =
      rollingRangePct_15m <= 2.8 && rollingRangePct_15m > 0;

    const compression: VolatilityCompressionFeatures = {
      rollingRangePct_15m,
      realizedVolatility_15m: rollingRangePct_15m / 3.87, // Approximation of 15m vol
      isCompressed,
      compressionRatio,
    };

    // 3. Micro Breakout & Anti-Chasing Guard (Spec Section 20 & 53)
    const breakoutDistancePct =
      microHigh_5m > 0
        ? ((currentPrice - microHigh_5m) / microHigh_5m) * 100
        : 0;

    // Must break micro high with positive return and volume/flow confirmation
    const isFlowConfirmed = flowSnapshot
      ? flowSnapshot.aggressive.buyPressure['15s'] >= 0.65 ||
        flowSnapshot.cvd.isCvdAccelerating
      : true;

    const isMicroBreakout =
      currentPrice >= microHigh_5m &&
      breakoutDistancePct >= 0 &&
      breakoutDistancePct <= 1.8 && // Early entry (not chased!)
      isFlowConfirmed;

    // Anti-Chasing Guard: If price has already pumped > 3.0% from 5m/15m low, REJECT chasing!
    const distanceFromLow15mPct =
      agg15m.lowPrice > 0
        ? ((currentPrice - agg15m.lowPrice) / agg15m.lowPrice) * 100
        : 0;
    const isChasingExcessivePump =
      returns['5m'] >= 3.0 || distanceFromLow15mPct >= 4.5;

    const breakout: MicroBreakoutFeatures = {
      isMicroBreakout,
      breakoutDistancePct,
      isChasingExcessivePump,
    };

    // 4. Multi-Timeframe Alignment
    const trend_15m =
      returns['15m'] >= 0.3
        ? 'BULLISH'
        : returns['15m'] <= -1.0
          ? 'BEARISH'
          : 'NEUTRAL';
    const trend_1h =
      returns['1h'] >= 0.5
        ? 'BULLISH'
        : returns['1h'] <= -3.0
          ? 'BEARISH'
          : 'NEUTRAL';
    const isAligned = trend_15m !== 'BEARISH' && trend_1h !== 'BEARISH';

    const alignment: MultiTimeframeAlignmentFeatures = {
      trend_15m,
      trend_1h,
      isAligned,
    };

    // =========================================================================
    // SPEC SECTION 31 — STRUCTURE SCORE (0 - 20 POINTS MAX)
    // - Compression:          25% (max 5.0 pts)
    // - Resistance Distance:  20% (max 4.0 pts)
    // - Price Acceleration:   20% (max 4.0 pts)
    // - Micro Breakout:       20% (max 4.0 pts)
    // - Multi-TF Alignment:   15% (max 3.0 pts)
    // =========================================================================
    let score = 0;

    // 1. Compression (Max 5.0)
    if (isCompressed && rollingRangePct_15m <= 1.8) score += 5.0;
    else if (isCompressed) score += 3.5;
    else if (rollingRangePct_15m <= 3.8) score += 2.0;

    // 2. Resistance Distance (Max 4.0) - closest to coil boundary without being far
    if (distanceToResistancePct <= 0.8) score += 4.0;
    else if (distanceToResistancePct <= 1.8) score += 2.5;
    else if (distanceToResistancePct <= 3.0) score += 1.0;

    // 3. Price Acceleration (Max 4.0)
    if (priceVelocity_10s > 0 && priceAcceleration_10s > 0) score += 4.0;
    else if (priceVelocity_10s > 0) score += 2.5;

    // 4. Micro Breakout (Max 4.0)
    if (isMicroBreakout) score += 4.0;

    // 5. Multi-TF Alignment (Max 3.0)
    if (isAligned && (trend_15m === 'BULLISH' || trend_1h === 'BULLISH'))
      score += 3.0;
    else if (isAligned) score += 2.0;

    // Severe penalty if chasing after price already pumped > 3%
    if (isChasingExcessivePump) {
      score = Math.max(0, score - 10.0);
    }

    const structureScore = Math.min(
      20,
      Math.max(0, Math.round(score * 10) / 10),
    );

    return {
      symbol,
      timestamp: now,
      priceAction,
      compression,
      breakout,
      alignment,
      structureScore,
    };
  }
}

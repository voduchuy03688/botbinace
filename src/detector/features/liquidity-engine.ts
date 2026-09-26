import {
  AskDepletionFeatures,
  BidReplenishmentFeatures,
  LiquidityFeatureSnapshot,
  LiquidityVacuumFeatures,
  OrderBookFeatures,
  SpreadFeatures,
} from '../types/liquidity.types.js';
import { OrderBookHistoryBuffer } from '../buffer/orderbook-history-buffer.js';
import { TimeWindowRingBuffer } from '../buffer/time-window-ring-buffer.js';
import { DynamicBaselineEngine } from '../baseline/dynamic-baseline.js';

export class LiquidityEngine {
  constructor(private readonly baselineEngine: DynamicBaselineEngine) {}

  evaluateLiquidity(
    symbol: string,
    bookBuffer: OrderBookHistoryBuffer,
    tradeBuffer?: TimeWindowRingBuffer,
    now = Date.now(),
  ): LiquidityFeatureSnapshot | null {
    const latest = bookBuffer.getLatest();
    if (!latest) return null;

    // 1. Order Book Features
    const orderBook: OrderBookFeatures = {
      midPrice: latest.midPrice,
      bestBid: latest.bestBid,
      bestAsk: latest.bestAsk,
      spread: latest.spread,
      spreadPct: latest.spreadPct,
      depthByLevel: latest.depthByLevel,
      totalBidDepth_1pct: latest.totalBidDepth_1pct,
      totalAskDepth_1pct: latest.totalAskDepth_1pct,
      overallImbalance_1pct:
        latest.depthByLevel['1.00%']?.imbalance ?? 0,
    };

    // 2. Ask Depletion (Compare current 0.5% ask depth vs 10s and 20s ago)
    const snap10sAgo = bookBuffer.getSnapshotAgo(10_000, now);
    const snap20sAgo = bookBuffer.getSnapshotAgo(20_000, now);

    const currAskDepth = latest.depthByLevel['0.50%']?.askDepthUsdt ?? 0;
    const prevAskDepth =
      snap10sAgo?.depthByLevel['0.50%']?.askDepthUsdt ?? currAskDepth;
    const prevPrevAskDepth =
      snap20sAgo?.depthByLevel['0.50%']?.askDepthUsdt ?? prevAskDepth;

    const askDepthChange = prevAskDepth - currAskDepth;
    const askDepletionRate =
      prevAskDepth > 0 ? (prevAskDepth - currAskDepth) / prevAskDepth : 0;

    const prevDepletionRate =
      prevPrevAskDepth > 0
        ? (prevPrevAskDepth - prevAskDepth) / prevPrevAskDepth
        : 0;
    const askDepletionAcceleration = askDepletionRate - prevDepletionRate;

    // CRITICAL: Spec Section 13
    // Distinguish ask consumed by market buy vs ask cancelled
    let isConsumedByMarketBuy = false;
    let buyQuoteVol15s = 0;
    let sellQuoteVol15s = 0;

    if (tradeBuffer) {
      const agg15s = tradeBuffer.getAggregatesForWindow(15_000, 5000, now);
      buyQuoteVol15s = agg15s.buyQuoteVolume;
      sellQuoteVol15s = agg15s.sellQuoteVolume;

      // If ask depth decreased and there was taker buy volume eating it
      if (askDepthChange > 0) {
        // At least 35% of the depleted depth was accounted for by taker buys
        isConsumedByMarketBuy = buyQuoteVol15s >= askDepthChange * 0.35;
      }
    }

    const isAskDepleting =
      askDepletionRate >= 0.20 && isConsumedByMarketBuy;

    const depletion: AskDepletionFeatures = {
      currentAskDepth_05pct: currAskDepth,
      previousAskDepth_05pct: prevAskDepth,
      askDepletionRate,
      askDepletionAcceleration,
      isConsumedByMarketBuy,
      isAskDepleting,
    };

    // 3. Liquidity Vacuum (Spec Section 14)
    // Check if ask liquidity at thin levels (0.05%, 0.10%, 0.25%, 0.50%) is hollowed out
    const depth005 = latest.depthByLevel['0.05%']?.askDepthUsdt ?? 0;
    const depth010 = latest.depthByLevel['0.10%']?.askDepthUsdt ?? 0;
    const depth025 = latest.depthByLevel['0.25%']?.askDepthUsdt ?? 0;
    const depth050 = currAskDepth;

    // Compare with bid depth and historical norms
    const bid050 = latest.depthByLevel['0.50%']?.bidDepthUsdt ?? 0;
    const askToBidRatio = bid050 > 0 ? depth050 / bid050 : 1.0;

    let levelsBelowThinThreshold = 0;
    // Arbitrary micro-thresholds for thin book
    if (depth005 < 5_000) levelsBelowThinThreshold++;
    if (depth010 < 15_000) levelsBelowThinThreshold++;
    if (depth025 < 40_000) levelsBelowThinThreshold++;
    if (depth050 < 80_000) levelsBelowThinThreshold++;

    let vacuumScore = 0;
    if (askToBidRatio < 0.3) vacuumScore += 0.5;
    else if (askToBidRatio < 0.5) vacuumScore += 0.3;

    if (levelsBelowThinThreshold >= 3) vacuumScore += 0.5;
    else if (levelsBelowThinThreshold >= 2) vacuumScore += 0.3;

    vacuumScore = Math.min(1.0, vacuumScore);
    const isVacuumPresent = vacuumScore >= 0.6 && isConsumedByMarketBuy;

    const vacuum: LiquidityVacuumFeatures = {
      vacuumScore,
      isVacuumPresent,
      askLiquidityThinness_05pct: askToBidRatio,
      levelsBelowThinThreshold,
    };

    // 4. Bid Replenishment & Absorption (Spec Section 15 & 16)
    // Demand Absorption: aggressive selling hits bid, but bid depth stays strong or refills
    const currBidDepth = latest.depthByLevel['0.50%']?.bidDepthUsdt ?? 0;
    const prevBidDepth =
      snap10sAgo?.depthByLevel['0.50%']?.bidDepthUsdt ?? currBidDepth;

    const isDemandAbsorption =
      sellQuoteVol15s >= 50_000 && currBidDepth >= prevBidDepth * 0.95;

    // Supply Absorption: aggressive buying surges, but price doesn't budge due to massive ask wall
    const isSupplyAbsorption =
      buyQuoteVol15s >= 100_000 &&
      (latest.depthByLevel['0.50%']?.imbalance ?? 0) < -0.3;

    const replenishmentCount_30s = isDemandAbsorption ? 2 : 0;
    const replenishment: BidReplenishmentFeatures = {
      replenishmentCount_30s,
      replenishedVolume_30s: isDemandAbsorption ? sellQuoteVol15s : 0,
      isDemandAbsorption,
      isSupplyAbsorption,
    };

    // 5. Spread Features (Spec Section 17)
    const spreadVolatility = bookBuffer.getSpreadVolatility(30_000, now);
    const isSpreadExcessive = latest.spreadPct > 0.12; // Spread > 0.12% is excessive on crypto futures
    const isSpreadStable =
      !isSpreadExcessive && spreadVolatility < 0.03;

    const spread: SpreadFeatures = {
      currentSpreadPct: latest.spreadPct,
      spreadVolatility_30s: spreadVolatility,
      isSpreadStable,
      isSpreadExcessive,
    };

    // =========================================================================
    // SPEC SECTION 30 — LIQUIDITY SCORE (0 - 30 POINTS MAX)
    // - Ask Depletion:      30% (max 9.0 pts)
    // - Liquidity Vacuum:   25% (max 7.5 pts)
    // - Bid Replenishment:  20% (max 6.0 pts)
    // - Orderbook Imbalance:15% (max 4.5 pts)
    // - Spread Stability:   10% (max 3.0 pts)
    // =========================================================================
    let score = 0;

    // 1. Ask Depletion (Max 9.0) - requires market buy confirmation!
    if (isConsumedByMarketBuy) {
      if (askDepletionRate >= 0.5) score += 9.0;
      else if (askDepletionRate >= 0.3) score += 7.0;
      else if (askDepletionRate >= 0.15) score += 4.5;
    }

    // 2. Liquidity Vacuum (Max 7.5)
    if (vacuumScore >= 0.8) score += 7.5;
    else if (vacuumScore >= 0.5) score += 5.0;
    else if (vacuumScore >= 0.3) score += 2.5;

    // 3. Bid Replenishment (Max 6.0)
    if (isDemandAbsorption) score += 6.0;

    // 4. Order Book Imbalance (Max 4.5)
    const imb = orderBook.overallImbalance_1pct;
    if (imb >= 0.35) score += 4.5;
    else if (imb >= 0.20) score += 3.0;
    else if (imb >= 0.10) score += 1.5;

    // 5. Spread Stability (Max 3.0)
    if (isSpreadStable && latest.spreadPct <= 0.05) score += 3.0;
    else if (isSpreadStable) score += 2.0;

    // Group cap: strictly max 30 points
    const liquidityScore = Math.min(
      30,
      Math.max(0, Math.round(score * 10) / 10),
    );

    return {
      symbol,
      timestamp: now,
      orderBook,
      depletion,
      vacuum,
      replenishment,
      spread,
      liquidityScore,
    };
  }
}

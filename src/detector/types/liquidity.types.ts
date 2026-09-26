/**
 * Liquidity and Order Book types according to Spec Sections 12-17 & 30
 */

export type DepthLevelPercent = 0.05 | 0.1 | 0.25 | 0.5 | 1.0 | 2.0;

export const DEPTH_LEVELS: DepthLevelPercent[] = [0.05, 0.1, 0.25, 0.5, 1.0, 2.0];

export interface DepthAtLevel {
  bidDepthUsdt: number;
  askDepthUsdt: number;
  imbalance: number; // (bid - ask) / (bid + ask), range -1.0 to +1.0
  depthRatio: number; // bid / max(ask, 1)
}

/**
 * Feature Group G: Order Book Depth
 */
export interface OrderBookFeatures {
  midPrice: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  spreadPct: number;
  depthByLevel: Record<string, DepthAtLevel>; // keyed by "0.05%", "0.10%", etc.
  totalBidDepth_1pct: number;
  totalAskDepth_1pct: number;
  overallImbalance_1pct: number;
}

/**
 * Feature Group H: Ask Liquidity Depletion (CORE)
 */
export interface AskDepletionFeatures {
  currentAskDepth_05pct: number;
  previousAskDepth_05pct: number;
  askDepletionRate: number; // (prev - curr) / prev
  askDepletionAcceleration: number;
  isConsumedByMarketBuy: boolean; // Confirms ask was eaten by taker buys, not cancelled
  isAskDepleting: boolean;
}

/**
 * Feature Group I: Liquidity Vacuum
 */
export interface LiquidityVacuumFeatures {
  vacuumScore: number; // 0.0 - 1.0 (1.0 = thin air above, high sweep potential)
  isVacuumPresent: boolean;
  askLiquidityThinness_05pct: number; // ratio of current ask depth vs average token ask depth
  levelsBelowThinThreshold: number;
}

/**
 * Feature Group J & K: Bid Replenishment & Absorption
 */
export interface BidReplenishmentFeatures {
  replenishmentCount_30s: number;
  replenishedVolume_30s: number;
  isDemandAbsorption: boolean; // Aggressive sell absorbed by immediate bid refill without price drop
  isSupplyAbsorption: boolean; // Aggressive buy absorbed by ask wall without price rise
}

/**
 * Feature Group L: Spread & Stability
 */
export interface SpreadFeatures {
  currentSpreadPct: number;
  spreadVolatility_30s: number;
  isSpreadStable: boolean;
  isSpreadExcessive: boolean; // Over reject threshold (e.g. > 0.15% on liquid futures)
}

/**
 * Combined Liquidity Snapshot covering Groups G, H, I, J, K, L
 * Spec Section 30: LIQUIDITY_SCORE (0 - 30 points)
 */
export interface LiquidityFeatureSnapshot {
  symbol: string;
  timestamp: number;
  orderBook: OrderBookFeatures;
  depletion: AskDepletionFeatures;
  vacuum: LiquidityVacuumFeatures;
  replenishment: BidReplenishmentFeatures;
  spread: SpreadFeatures;
  liquidityScore: number; // 0 - 30 points max
}

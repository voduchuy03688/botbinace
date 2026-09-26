import { TimeWindowKey } from './market-event.types.js';

/**
 * Price Structure & Micro-Breakout types according to Spec Sections 6, 18, 19, 20 & 31
 */

export interface PriceActionFeatures {
  returns: Record<TimeWindowKey, number>; // Price return (%) across windows
  priceVelocity_10s: number; // % change per second
  priceAcceleration_10s: number; // Acceleration of price change
  microHigh_5m: number;
  microLow_5m: number;
  localResistance: number;
  localSupport: number;
  distanceToResistancePct: number; // ((resistance - price) / price) * 100
  distanceToSupportPct: number; // ((price - support) / price) * 100
  higherHigh: boolean;
  higherLow: boolean;
}

export interface VolatilityCompressionFeatures {
  rollingRangePct_15m: number; // (high - low) / low * 100 in 15m window
  realizedVolatility_15m: number;
  isCompressed: boolean; // Range compressed <= 2.5% indicating energy coil
  compressionRatio: number; // Current 15m range / 1h range
}

export interface MicroBreakoutFeatures {
  isMicroBreakout: boolean; // current price > microHigh_5m with volume/flow confirmation
  breakoutDistancePct: number; // How far above micro high (e.g. +0.1% to +0.8%, not chased at +5%)
  isChasingExcessivePump: boolean; // True if price already pumped > 3.0% from base (REJECT entry!)
}

export interface MultiTimeframeAlignmentFeatures {
  trend_15m: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
  trend_1h: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
  isAligned: boolean;
}

export interface StructureFeatureSnapshot {
  symbol: string;
  timestamp: number;
  priceAction: PriceActionFeatures;
  compression: VolatilityCompressionFeatures;
  breakout: MicroBreakoutFeatures;
  alignment: MultiTimeframeAlignmentFeatures;
  structureScore: number; // 0 - 20 points max
}

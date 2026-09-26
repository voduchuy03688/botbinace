import { TimeWindowKey } from './market-event.types.js';

/**
 * Window-specific volume metrics
 */
export interface WindowVolumeMetrics {
  totalVolume: number; // Quote volume (USDT)
  baseVolume: number; // Base asset volume (coins)
  tradeCount: number;
}

/**
 * Feature Group B: Volume Features
 */
export interface VolumeFeatures {
  volumes: Record<TimeWindowKey, number>; // Quote volumes across 5s, 10s, 15s, 30s, 60s, 3m, 5m, 15m, 1h
  rvol_60s: number; // Relative volume vs baseline
  volume_Z_60s: number; // Z-score of 60s volume against rolling baseline
  volume_velocity_10s: number; // Rate of volume growth in 10s window vs prev 10s (%)
  volume_acceleration_10s: number; // Volume velocity acceleration
  isVolumeAccelerating: boolean; // Confirms pattern: baseline -> +20% -> +50% -> +120%...
}

/**
 * Feature Group C: Aggressive Buy/Sell Pressure
 */
export interface AggressivePressureFeatures {
  aggressiveBuyVolume: Record<TimeWindowKey, number>;
  aggressiveSellVolume: Record<TimeWindowKey, number>;
  buyPressure: Record<TimeWindowKey, number>; // buy / (buy + sell), range 0.0 - 1.0
  buyPressureChange_10s: number; // Change in buy pressure in last 10s vs prev 10s
  buyPressureVelocity_10s: number; // Velocity of buy pressure change
  buyPressureAcceleration_10s: number; // Acceleration of buy pressure
  buyPressure_Z_60s: number; // Z-score of buy pressure vs historical rolling baseline
  buySellRatio_60s: number; // buyVolume / max(sellVolume, 1)
}

/**
 * Feature Group D: Cumulative Volume Delta (CVD)
 */
export interface CvdFeatures {
  cvd: Record<TimeWindowKey, number>; // buyVolume - sellVolume in window (USDT)
  cvdSlope_15s: number; // Slope per second across 15s
  cvdSlope_60s: number; // Slope per second across 60s
  cvdAcceleration_15s: number; // Rate of change of slope
  cvd_Z_60s: number; // Z-score of CVD against token baseline
  cvdPercentile_60s: number; // Percentile rank of current CVD (0 - 100)
  cvdAccelerationSequence: number[]; // e.g. [20, 50, 100, 250, 600]
  isCvdAccelerating: boolean;
  cvdDivergence: boolean; // Price flat/down while CVD surging
}

/**
 * Feature Group E: Trade Frequency & Burst
 */
export interface TradeBurstFeatures {
  tradesPerSecond: number; // Current instant trades/sec
  trades_5s: number;
  trades_10s: number;
  trades_30s: number;
  trades_60s: number;
  tradeFrequency_Z_60s: number; // Z-score of trade frequency
  tradeFrequencyPercentile_60s: number; // Percentile rank of trade frequency
  tradeFrequencyVelocity_10s: number;
  tradeFrequencyAcceleration_10s: number;
  isTradeBursting: boolean; // Trades/sec > baseline + 2.5 * std
}

/**
 * Feature Group F: Large Trades (Whales)
 */
export interface LargeTradeFeatures {
  thresholdP95Quote: number; // Dynamic coin-specific P95 trade size threshold (USDT)
  thresholdP99Quote: number; // Dynamic coin-specific P99 trade size threshold (USDT)
  largeBuyCount_60s: number;
  largeSellCount_60s: number;
  largeBuyVolume_60s: number;
  largeSellVolume_60s: number;
  largeBuyFrequency_60s: number; // Large buy trades per minute
  largeBuyAcceleration_15s: number;
  largeBuySellRatio_60s: number; // largeBuyVol / max(largeSellVol, 1)
}

/**
 * Combined Order Flow Feature Snapshot
 * Covering Groups B, C, D, E, F as required by Spec Section 29 (FLOW_SCORE 0 - 35)
 */
export interface FlowFeatureSnapshot {
  symbol: string;
  timestamp: number;
  volume: VolumeFeatures;
  aggressive: AggressivePressureFeatures;
  cvd: CvdFeatures;
  burst: TradeBurstFeatures;
  largeTrades: LargeTradeFeatures;
  flowScore: number; // 0 - 35 points capped
}

import {
  AggressivePressureFeatures,
  CvdFeatures,
  FlowFeatureSnapshot,
  LargeTradeFeatures,
  TradeBurstFeatures,
  VolumeFeatures,
} from '../types/feature.types.js';
import { TimeWindowKey } from '../types/market-event.types.js';
import {
  TimeWindowRingBuffer,
  WindowTradeAggregates,
} from '../buffer/time-window-ring-buffer.js';
import { DynamicBaselineEngine } from '../baseline/dynamic-baseline.js';

export class FlowEngine {
  constructor(private readonly baselineEngine: DynamicBaselineEngine) {}

  /**
   * Evaluates all order flow features from the sliding ring buffer for a given symbol.
   */
  evaluateFlow(
    symbol: string,
    buffer: TimeWindowRingBuffer,
    now = Date.now(),
  ): FlowFeatureSnapshot {
    const thresholds = this.baselineEngine.getLargeTradeThresholds(symbol);

    // 1. Fetch current window aggregates
    const agg5s = buffer.getAggregatesForWindow(5_000, thresholds.p95, now);
    const agg10s = buffer.getAggregatesForWindow(10_000, thresholds.p95, now);
    const agg15s = buffer.getAggregatesForWindow(15_000, thresholds.p95, now);
    const agg30s = buffer.getAggregatesForWindow(30_000, thresholds.p95, now);
    const agg60s = buffer.getAggregatesForWindow(60_000, thresholds.p95, now);
    const agg3m = buffer.getAggregatesForWindow(180_000, thresholds.p95, now);
    const agg5m = buffer.getAggregatesForWindow(300_000, thresholds.p95, now);
    const agg15m = buffer.getAggregatesForWindow(900_000, thresholds.p95, now);
    const agg1h = buffer.getAggregatesForWindow(3_600_000, thresholds.p95, now);

    // 2. Fetch shifted previous windows for acceleration calculations
    // Previous 10s window (from now - 20s to now - 10s)
    const prevAgg10s = this.getShiftedAggregates(buffer, 10_000, 10_000, thresholds.p95, now);
    // Previous 15s window (from now - 30s to now - 15s)
    const prevAgg15s = this.getShiftedAggregates(buffer, 15_000, 15_000, thresholds.p95, now);

    // =========================================================================
    // FEATURE GROUP B — VOLUME
    // =========================================================================
    const volumes: Record<TimeWindowKey, number> = {
      '5s': agg5s.totalQuoteVolume,
      '10s': agg10s.totalQuoteVolume,
      '15s': agg15s.totalQuoteVolume,
      '30s': agg30s.totalQuoteVolume,
      '60s': agg60s.totalQuoteVolume,
      '3m': agg3m.totalQuoteVolume,
      '5m': agg5m.totalQuoteVolume,
      '15m': agg15m.totalQuoteVolume,
      '1h': agg1h.totalQuoteVolume,
    };

    const baseline = this.baselineEngine.getBaseline(symbol);
    const baselineMean60s = baseline.volume60sDistribution.mean;
    const rvol_60s =
      baselineMean60s > 0 ? agg60s.totalQuoteVolume / baselineMean60s : 1.0;
    const volume_Z_60s = this.baselineEngine.calculateVolumeZ(
      symbol,
      agg60s.totalQuoteVolume,
    );

    // Volume velocity in 10s window vs previous 10s: (v_curr - v_prev) / max(v_prev, 1)
    const prevVol10s = Math.max(prevAgg10s.totalQuoteVolume, 1);
    const volume_velocity_10s =
      (agg10s.totalQuoteVolume - prevAgg10s.totalQuoteVolume) / prevVol10s;

    // Previous previous 10s (from now - 30s to now - 20s)
    const prevPrevAgg10s = this.getShiftedAggregates(buffer, 10_000, 20_000, thresholds.p95, now);
    const prevPrevVol10s = Math.max(prevPrevAgg10s.totalQuoteVolume, 1);
    const prevVolumeVelocity10s =
      (prevAgg10s.totalQuoteVolume - prevPrevAgg10s.totalQuoteVolume) / prevPrevVol10s;
    const volume_acceleration_10s = volume_velocity_10s - prevVolumeVelocity10s;

    // Volume accelerating pattern check: baseline -> +20% -> +50% -> +120%...
    const isVolumeAccelerating =
      volume_velocity_10s > 0.5 && volume_acceleration_10s > 0;

    const volumeFeatures: VolumeFeatures = {
      volumes,
      rvol_60s,
      volume_Z_60s,
      volume_velocity_10s,
      volume_acceleration_10s,
      isVolumeAccelerating,
    };

    // =========================================================================
    // FEATURE GROUP C — AGGRESSIVE BUY/SELL PRESSURE
    // =========================================================================
    const aggressiveBuyVolume: Record<TimeWindowKey, number> = {
      '5s': agg5s.buyQuoteVolume,
      '10s': agg10s.buyQuoteVolume,
      '15s': agg15s.buyQuoteVolume,
      '30s': agg30s.buyQuoteVolume,
      '60s': agg60s.buyQuoteVolume,
      '3m': agg3m.buyQuoteVolume,
      '5m': agg5m.buyQuoteVolume,
      '15m': agg15m.buyQuoteVolume,
      '1h': agg1h.buyQuoteVolume,
    };

    const aggressiveSellVolume: Record<TimeWindowKey, number> = {
      '5s': agg5s.sellQuoteVolume,
      '10s': agg10s.sellQuoteVolume,
      '15s': agg15s.sellQuoteVolume,
      '30s': agg30s.sellQuoteVolume,
      '60s': agg60s.sellQuoteVolume,
      '3m': agg3m.sellQuoteVolume,
      '5m': agg5m.sellQuoteVolume,
      '15m': agg15m.sellQuoteVolume,
      '1h': agg1h.sellQuoteVolume,
    };

    const buyPressure: Record<TimeWindowKey, number> = {
      '5s': agg5s.buyPressure,
      '10s': agg10s.buyPressure,
      '15s': agg15s.buyPressure,
      '30s': agg30s.buyPressure,
      '60s': agg60s.buyPressure,
      '3m': agg3m.buyPressure,
      '5m': agg5m.buyPressure,
      '15m': agg15m.buyPressure,
      '1h': agg1h.buyPressure,
    };

    const buyPressureChange_10s = agg10s.buyPressure - prevAgg10s.buyPressure;
    const buyPressureVelocity_10s = buyPressureChange_10s / 10;
    const prevBuyPressureChange10s =
      prevAgg10s.buyPressure - prevPrevAgg10s.buyPressure;
    const buyPressureAcceleration_10s =
      buyPressureChange_10s - prevBuyPressureChange10s;
    const buyPressure_Z_60s = this.baselineEngine.calculateBuyPressureZ(
      symbol,
      agg60s.buyPressure,
    );
    const buySellRatio_60s =
      agg60s.buyQuoteVolume / Math.max(agg60s.sellQuoteVolume, 1);

    const aggressiveFeatures: AggressivePressureFeatures = {
      aggressiveBuyVolume,
      aggressiveSellVolume,
      buyPressure,
      buyPressureChange_10s,
      buyPressureVelocity_10s,
      buyPressureAcceleration_10s,
      buyPressure_Z_60s,
      buySellRatio_60s,
    };

    // =========================================================================
    // FEATURE GROUP D — CVD (CUMULATIVE VOLUME DELTA)
    // =========================================================================
    const cvd: Record<TimeWindowKey, number> = {
      '5s': agg5s.cvd,
      '10s': agg10s.cvd,
      '15s': agg15s.cvd,
      '30s': agg30s.cvd,
      '60s': agg60s.cvd,
      '3m': agg3m.cvd,
      '5m': agg5m.cvd,
      '15m': agg15m.cvd,
      '1h': agg1h.cvd,
    };

    const cvdSlope_15s = agg15s.cvd / 15;
    const cvdSlope_60s = agg60s.cvd / 60;
    const prevCvdSlope15s = prevAgg15s.cvd / 15;
    const cvdAcceleration_15s = cvdSlope_15s - prevCvdSlope15s;

    const cvd_Z_60s = this.baselineEngine.calculateCvdZ(symbol, agg60s.cvd);
    const cvdPercentile_60s = this.baselineEngine.calculateCvdPercentile(
      symbol,
      agg60s.cvd,
    );

    // Multi-step acceleration progression sequence (+20, +50, +100, +250, +600)
    // Computed over last 5 distinct 5-second sub-intervals
    const cvdAccelerationSequence: number[] = [];
    for (let i = 4; i >= 0; i--) {
      const sub = this.getShiftedAggregates(buffer, 5_000, i * 5_000, thresholds.p95, now);
      cvdAccelerationSequence.push(Math.round(sub.cvd));
    }

    let isCvdAccelerating = cvdSlope_15s > 0 && cvdAcceleration_15s > 0;
    // Check if sequence is strictly monotonically increasing or positive acceleration
    if (cvdAccelerationSequence.length >= 3) {
      const last = cvdAccelerationSequence[cvdAccelerationSequence.length - 1];
      const prev = cvdAccelerationSequence[cvdAccelerationSequence.length - 2];
      const first = cvdAccelerationSequence[0];
      if (last > prev && prev > first && last > 0) {
        isCvdAccelerating = true;
      }
    }

    // CVD Divergence: Price return in 60s is <= +0.1% while CVD is strongly positive
    const priceChange60sPct =
      agg60s.openPrice > 0
        ? ((agg60s.closePrice - agg60s.openPrice) / agg60s.openPrice) * 100
        : 0;
    const cvdDivergence = priceChange60sPct <= 0.15 && cvd_Z_60s >= 2.0;

    const cvdFeatures: CvdFeatures = {
      cvd,
      cvdSlope_15s,
      cvdSlope_60s,
      cvdAcceleration_15s,
      cvd_Z_60s,
      cvdPercentile_60s,
      cvdAccelerationSequence,
      isCvdAccelerating,
      cvdDivergence,
    };

    // =========================================================================
    // FEATURE GROUP E — TRADE BURST
    // =========================================================================
    const tradesPerSecond = agg5s.tradeCount / 5;
    const trades_5s = agg5s.tradeCount;
    const trades_10s = agg10s.tradeCount;
    const trades_30s = agg30s.tradeCount;
    const trades_60s = agg60s.tradeCount;

    const tradeFrequency_Z_60s = this.baselineEngine.calculateTradeFrequencyZ(
      symbol,
      trades_60s,
    );
    const tradeFrequencyPercentile_60s =
      this.baselineEngine.calculateTradeFrequencyPercentile(symbol, trades_60s);

    const prevTradeFreq10s = prevAgg10s.tradeCount / 10;
    const currTradeFreq10s = agg10s.tradeCount / 10;
    const tradeFrequencyVelocity_10s = currTradeFreq10s - prevTradeFreq10s;

    const prevPrevTradeFreq10s = prevPrevAgg10s.tradeCount / 10;
    const prevTradeFreqVelocity10s = prevTradeFreq10s - prevPrevTradeFreq10s;
    const tradeFrequencyAcceleration_10s =
      tradeFrequencyVelocity_10s - prevTradeFreqVelocity10s;

    const isTradeBursting =
      tradeFrequency_Z_60s >= 2.5 ||
      (tradesPerSecond >= 10 && tradeFrequencyAcceleration_10s > 0);

    const burstFeatures: TradeBurstFeatures = {
      tradesPerSecond,
      trades_5s,
      trades_10s,
      trades_30s,
      trades_60s,
      tradeFrequency_Z_60s,
      tradeFrequencyPercentile_60s,
      tradeFrequencyVelocity_10s,
      tradeFrequencyAcceleration_10s,
      isTradeBursting,
    };

    // =========================================================================
    // FEATURE GROUP F — LARGE TRADES
    // =========================================================================
    const largeTradeFeatures: LargeTradeFeatures = {
      thresholdP95Quote: thresholds.p95,
      thresholdP99Quote: thresholds.p99,
      largeBuyCount_60s: agg60s.largeBuyCount,
      largeSellCount_60s: agg60s.largeSellCount,
      largeBuyVolume_60s: agg60s.largeBuyVolume,
      largeSellVolume_60s: agg60s.largeSellVolume,
      largeBuyFrequency_60s: agg60s.largeBuyCount,
      largeBuyAcceleration_15s: agg15s.largeBuyCount - prevAgg15s.largeBuyCount,
      largeBuySellRatio_60s:
        agg60s.largeBuyVolume / Math.max(agg60s.largeSellVolume, 1),
    };

    // =========================================================================
    // SPEC SECTION 29 — FLOW SCORE CALCULATION (0 - 35 POINTS MAX)
    // - Aggressive Buy Acceleration: 25% (max 8.75)
    // - CVD Acceleration:            25% (max 8.75)
    // - Trade Burst:                 15% (max 5.25)
    // - Volume Acceleration:         15% (max 5.25)
    // - Large Aggressive Buy:        20% (max 7.00)
    // =========================================================================
    let score = 0;

    // 1. Aggressive Buy Acceleration (Weight: 25% = 8.75 max)
    if (agg15s.buyPressure >= 0.8) score += 8.75;
    else if (agg15s.buyPressure >= 0.7) score += 6.5;
    else if (agg15s.buyPressure >= 0.6) score += 4.0;
    if (buyPressureAcceleration_10s > 0.05) score = Math.min(8.75, score + 2.0);

    // 2. CVD Acceleration (Weight: 25% = 8.75 max)
    if (cvd_Z_60s >= 3.0 && isCvdAccelerating) score += 8.75;
    else if (cvd_Z_60s >= 2.0) score += 6.5;
    else if (cvd_Z_60s >= 1.0 && cvdSlope_15s > 0) score += 4.0;

    // 3. Trade Burst (Weight: 15% = 5.25 max)
    if (tradeFrequency_Z_60s >= 3.0 || tradesPerSecond >= 15) score += 5.25;
    else if (tradeFrequency_Z_60s >= 2.0 || tradesPerSecond >= 8) score += 3.75;
    else if (tradeFrequency_Z_60s >= 1.0) score += 2.0;

    // 4. Volume Acceleration (Weight: 15% = 5.25 max)
    if (volume_Z_60s >= 3.0 && isVolumeAccelerating) score += 5.25;
    else if (volume_Z_60s >= 2.0) score += 3.75;
    else if (volume_Z_60s >= 1.0) score += 2.0;

    // 5. Large Aggressive Buy (Weight: 20% = 7.00 max)
    if (
      largeTradeFeatures.largeBuyCount_60s >= 3 &&
      largeTradeFeatures.largeBuySellRatio_60s >= 3.0
    ) {
      score += 7.0;
    } else if (
      largeTradeFeatures.largeBuyCount_60s >= 1 &&
      largeTradeFeatures.largeBuySellRatio_60s >= 1.5
    ) {
      score += 4.5;
    }

    // Spec Section 29: FLOW group is strictly capped at 35
    const flowScore = Math.min(35, Math.max(0, Math.round(score * 10) / 10));

    return {
      symbol,
      timestamp: now,
      volume: volumeFeatures,
      aggressive: aggressiveFeatures,
      cvd: cvdFeatures,
      burst: burstFeatures,
      largeTrades: largeTradeFeatures,
      flowScore,
    };
  }

  /**
   * Helper to query a non-contiguous window shifted backwards by offsetMs.
   */
  private getShiftedAggregates(
    buffer: TimeWindowRingBuffer,
    durationMs: number,
    offsetMs: number,
    largeTradeThreshold: number,
    now: number,
  ): WindowTradeAggregates {
    return buffer.getAggregatesForWindow(
      durationMs,
      largeTradeThreshold,
      now - offsetMs,
    );
  }
}

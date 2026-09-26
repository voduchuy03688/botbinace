import {
  BtcRegimeFeatures,
  DerivativesMarketSnapshot,
  FundingFeatures,
  LiquidationFeatures,
  OpenInterestFeatures,
  RelativeStrengthFeatures,
} from '../types/derivatives-market.types.js';
import { TimeWindowRingBuffer } from '../buffer/time-window-ring-buffer.js';

export class DerivativesMarketEngine {
  evaluateDerivativesAndMarket(
    symbol: string,
    tokenBuffer: TimeWindowRingBuffer,
    btcBuffer?: TimeWindowRingBuffer,
    openInterest = 0,
    fundingRate = 0.0001,
    now = Date.now(),
  ): DerivativesMarketSnapshot {
    // 1. BTC Regime Evaluation
    let btcReturn_5s = 0;
    let btcReturn_60s = 0;
    let btcReturn_5m = 0;
    let btcVolatility_15m = 0;
    let isBtcCrashing = false;
    let btcRegime: 'BULLISH' | 'NEUTRAL' | 'CRASH' = 'NEUTRAL';

    if (btcBuffer && btcBuffer.length > 0) {
      const agg5s = btcBuffer.getAggregatesForWindow(5_000, 10_000, now);
      const agg60s = btcBuffer.getAggregatesForWindow(60_000, 10_000, now);
      const agg5m = btcBuffer.getAggregatesForWindow(300_000, 10_000, now);

      btcReturn_5s =
        agg5s.openPrice > 0
          ? ((agg5s.closePrice - agg5s.openPrice) / agg5s.openPrice) * 100
          : 0;
      btcReturn_60s =
        agg60s.openPrice > 0
          ? ((agg60s.closePrice - agg60s.openPrice) / agg60s.openPrice) * 100
          : 0;
      btcReturn_5m =
        agg5m.openPrice > 0
          ? ((agg5m.closePrice - agg5m.openPrice) / agg5m.openPrice) * 100
          : 0;

      // Spec Section 25 & 37: BTC crash regime filter
      if (btcReturn_5m <= -1.8 || btcReturn_60s <= -0.9) {
        isBtcCrashing = true;
        btcRegime = 'CRASH';
      } else if (btcReturn_5m >= 0.5 && btcReturn_60s >= 0.2) {
        btcRegime = 'BULLISH';
      }
    }

    const btcRegimeFeatures: BtcRegimeFeatures = {
      btcReturn_5s,
      btcReturn_60s,
      btcReturn_5m,
      btcVolatility_15m,
      isBtcCrashing,
      btcRegime,
    };

    // 2. Relative Strength
    const tokenAgg60s = tokenBuffer.getAggregatesForWindow(60_000, 5000, now);
    const tokenReturn_60s =
      tokenAgg60s.openPrice > 0
        ? ((tokenAgg60s.closePrice - tokenAgg60s.openPrice) /
            tokenAgg60s.openPrice) *
          100
        : 0;
    const relativeStrength_60s = tokenReturn_60s - btcReturn_60s;
    const isOutperformingBtc = relativeStrength_60s > 0.4;

    const relativeStrength: RelativeStrengthFeatures = {
      tokenReturn_60s,
      btcReturn_60s,
      relativeStrength_60s,
      isOutperformingBtc,
    };

    // 3. Open Interest (OI) & Derivatives features
    const oiFeatures: OpenInterestFeatures = {
      openInterest,
      oiChange_5sPct: 0.1,
      oiChange_60sPct: 0.5,
      oiChange_5mPct: 1.2,
      oiAcceleration: 0.05,
      oi_Z_60s: 1.2,
    };

    const liquidationFeatures: LiquidationFeatures = {
      shortLiquidationVolume_60s: 0,
      longLiquidationVolume_60s: 0,
      shortLiquidationAcceleration: 0,
      isShortSqueezeUnderway: false,
    };

    const fundingFeatures: FundingFeatures = {
      fundingRate,
      isContextBullish: fundingRate <= 0.0003, // Low or neutral funding
    };

    // =========================================================================
    // SPEC SECTION 32 — DERIVATIVE SCORE (0 - 10 MAX)
    // - OI Acceleration:       35% (max 3.5 pts)
    // - Short Liquidation:     30% (max 3.0 pts)
    // - OI/Price Relationship: 25% (max 2.5 pts)
    // - Funding:               10% (max 1.0 pt)
    // =========================================================================
    let dScore = 2.0; // Baseline points for neutral spot/derivatives
    if (oiFeatures.oiChange_60sPct >= 0.8) dScore += 3.5;
    else if (oiFeatures.oiChange_60sPct >= 0.3) dScore += 2.0;

    if (liquidationFeatures.isShortSqueezeUnderway) dScore += 3.0;

    if (fundingFeatures.isContextBullish) dScore += 1.0;

    const derivativeScore = Math.min(10, Math.round(dScore * 10) / 10);

    // =========================================================================
    // SPEC SECTION 33 — MARKET SCORE (0 - 5 MAX)
    // - BTC Regime:          max 2.5 pts
    // - Relative Strength:   max 2.5 pts
    // =========================================================================
    let mScore = 0;
    if (btcRegime === 'BULLISH') mScore += 2.5;
    else if (btcRegime === 'NEUTRAL') mScore += 1.5;
    else if (btcRegime === 'CRASH') mScore = 0;

    if (isOutperformingBtc && relativeStrength_60s >= 1.0) mScore += 2.5;
    else if (isOutperformingBtc) mScore += 1.5;

    const marketScore = Math.min(5, Math.round(mScore * 10) / 10);

    return {
      symbol,
      timestamp: now,
      oi: oiFeatures,
      liquidation: liquidationFeatures,
      funding: fundingFeatures,
      btcRegime: btcRegimeFeatures,
      relativeStrength,
      derivativeScore,
      marketScore,
    };
  }
}

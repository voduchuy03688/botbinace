/**
 * Derivatives and Market Regime types according to Spec Sections 21, 22, 23, 25, 26, 32, 33
 */

export interface OpenInterestFeatures {
  openInterest: number;
  oiChange_5sPct: number;
  oiChange_60sPct: number;
  oiChange_5mPct: number;
  oiAcceleration: number;
  oi_Z_60s: number;
}

export interface LiquidationFeatures {
  shortLiquidationVolume_60s: number;
  longLiquidationVolume_60s: number;
  shortLiquidationAcceleration: number;
  isShortSqueezeUnderway: boolean;
}

export interface FundingFeatures {
  fundingRate: number; // e.g. 0.0001 = 0.01%
  isContextBullish: boolean;
}

export interface BtcRegimeFeatures {
  btcReturn_5s: number;
  btcReturn_60s: number;
  btcReturn_5m: number;
  btcVolatility_15m: number;
  isBtcCrashing: boolean; // Return 5m < -1.5% or 1m < -0.8%
  btcRegime: 'BULLISH' | 'NEUTRAL' | 'CRASH';
}

export interface RelativeStrengthFeatures {
  tokenReturn_60s: number;
  btcReturn_60s: number;
  relativeStrength_60s: number; // tokenReturn - btcReturn
  isOutperformingBtc: boolean;
}

export interface DerivativesMarketSnapshot {
  symbol: string;
  timestamp: number;
  oi: OpenInterestFeatures;
  liquidation: LiquidationFeatures;
  funding: FundingFeatures;
  btcRegime: BtcRegimeFeatures;
  relativeStrength: RelativeStrengthFeatures;
  derivativeScore: number; // 0 - 10 max
  marketScore: number; // 0 - 5 max
}

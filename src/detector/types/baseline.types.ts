/**
 * Dynamic Coin-Specific Baseline & Normalization Types
 * Spec Section 5: Coin-Specific Baseline
 */

export interface RollingDistributionMetrics {
  count: number;
  mean: number;
  std: number;
  median: number;
  mad: number; // Median Absolute Deviation for outlier-resistant Z-scores
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p97: number;
  p99: number;
  min: number;
  max: number;
}

export interface SymbolBaselineState {
  symbol: string;
  lastUpdated: number;
  tradeSizeDistribution: RollingDistributionMetrics;
  volume60sDistribution: RollingDistributionMetrics;
  cvd60sDistribution: RollingDistributionMetrics;
  tradeFreq60sDistribution: RollingDistributionMetrics;
  buyPressure60sDistribution: RollingDistributionMetrics;
}

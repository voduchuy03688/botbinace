import {
  RollingDistributionMetrics,
  SymbolBaselineState,
} from '../types/baseline.types.js';

export class RollingWindowStats {
  private values: number[] = [];
  private readonly maxCapacity: number;
  private sum = 0;
  private sumSq = 0;

  constructor(maxCapacity = 360) {
    this.maxCapacity = Math.max(10, maxCapacity);
  }

  add(val: number): void {
    if (!Number.isFinite(val)) return;

    if (this.values.length >= this.maxCapacity) {
      const removed = this.values.shift()!;
      this.sum -= removed;
      this.sumSq -= removed * removed;
    }

    this.values.push(val);
    this.sum += val;
    this.sumSq += val * val;
  }

  get length(): number {
    return this.values.length;
  }

  getValues(): number[] {
    return [...this.values];
  }

  calculateMetrics(): RollingDistributionMetrics {
    const n = this.values.length;
    if (n === 0) {
      return {
        count: 0,
        mean: 0,
        std: 0,
        median: 0,
        mad: 0,
        p50: 0,
        p75: 0,
        p90: 0,
        p95: 0,
        p97: 0,
        p99: 0,
        min: 0,
        max: 0,
      };
    }

    const mean = this.sum / n;
    const variance = Math.max(0, this.sumSq / n - mean * mean);
    const std = Math.sqrt(variance);

    const sorted = [...this.values].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];

    const getPercentile = (p: number): number => {
      if (sorted.length === 1) return sorted[0];
      // Nearest rank method (standard for financial large-trade percentile separation)
      const rank = Math.max(1, Math.min(sorted.length, Math.ceil((p / 100) * sorted.length)));
      return sorted[rank - 1];
    };

    const mid = Math.floor(n / 2);
    const median = n % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

    // Calculate Median Absolute Deviation (MAD)
    const absoluteDeviations = sorted
      .map((x) => Math.abs(x - median))
      .sort((a, b) => a - b);
    const midIdx = Math.floor(absoluteDeviations.length / 2);
    const mad =
      absoluteDeviations.length % 2 !== 0
        ? absoluteDeviations[midIdx]
        : (absoluteDeviations[midIdx - 1] + absoluteDeviations[midIdx]) / 2;

    return {
      count: n,
      mean,
      std,
      median,
      mad,
      p50: median,
      p75: getPercentile(75),
      p90: getPercentile(90),
      p95: getPercentile(95),
      p97: getPercentile(97),
      p99: getPercentile(99),
      min,
      max,
    };
  }

  calculateZScore(val: number, epsilon = 1e-6): number {
    const n = this.values.length;
    if (n < 3) return 0;
    const mean = this.sum / n;
    const variance = Math.max(0, this.sumSq / n - mean * mean);
    const std = Math.sqrt(variance);
    if (std < epsilon) return 0;
    return (val - mean) / std;
  }

  calculateRobustZScore(val: number, epsilon = 1e-6): number {
    const metrics = this.calculateMetrics();
    if (metrics.count < 3 || metrics.mad < epsilon) {
      return this.calculateZScore(val, epsilon);
    }
    return (0.6745 * (val - metrics.median)) / metrics.mad;
  }

  calculatePercentileRank(val: number): number {
    if (this.values.length === 0) return 50;
    let countBelow = 0;
    for (const v of this.values) {
      if (v < val) countBelow++;
    }
    return Math.round((countBelow / this.values.length) * 100);
  }
}

export class DynamicBaselineEngine {
  private readonly symbolStates: Map<
    string,
    {
      tradeSizeStats: RollingWindowStats;
      volume60sStats: RollingWindowStats;
      cvd60sStats: RollingWindowStats;
      tradeFreq60sStats: RollingWindowStats;
      buyPressure60sStats: RollingWindowStats;
      lastUpdated: number;
    }
  > = new Map();

  private getOrCreate(symbol: string) {
    let state = this.symbolStates.get(symbol);
    if (!state) {
      state = {
        tradeSizeStats: new RollingWindowStats(2000), // Last 2000 trades for accurate P95/P99
        volume60sStats: new RollingWindowStats(180), // 3 hours of 1-minute volume snapshots
        cvd60sStats: new RollingWindowStats(180),
        tradeFreq60sStats: new RollingWindowStats(180),
        buyPressure60sStats: new RollingWindowStats(180),
        lastUpdated: Date.now(),
      };
      this.symbolStates.set(symbol, state);
    }
    return state;
  }

  recordTrade(symbol: string, quoteQty: number): void {
    if (quoteQty <= 0) return;
    const state = this.getOrCreate(symbol);
    state.tradeSizeStats.add(quoteQty);
    state.lastUpdated = Date.now();
  }

  recordSnapshot(
    symbol: string,
    volume60s: number,
    cvd60s: number,
    tradeFreq60s: number,
    buyPressure60s: number,
  ): void {
    const state = this.getOrCreate(symbol);
    state.volume60sStats.add(volume60s);
    state.cvd60sStats.add(cvd60s);
    state.tradeFreq60sStats.add(tradeFreq60s);
    state.buyPressure60sStats.add(buyPressure60s);
    state.lastUpdated = Date.now();
  }

  getBaseline(symbol: string): SymbolBaselineState {
    const state = this.getOrCreate(symbol);
    return {
      symbol,
      lastUpdated: state.lastUpdated,
      tradeSizeDistribution: state.tradeSizeStats.calculateMetrics(),
      volume60sDistribution: state.volume60sStats.calculateMetrics(),
      cvd60sDistribution: state.cvd60sStats.calculateMetrics(),
      tradeFreq60sDistribution: state.tradeFreq60sStats.calculateMetrics(),
      buyPressure60sDistribution:
        state.buyPressure60sStats.calculateMetrics(),
    };
  }

  calculateVolumeZ(symbol: string, volume60s: number): number {
    const state = this.getOrCreate(symbol);
    return state.volume60sStats.calculateZScore(volume60s);
  }

  calculateCvdZ(symbol: string, cvd60s: number): number {
    const state = this.getOrCreate(symbol);
    return state.cvd60sStats.calculateZScore(cvd60s);
  }

  calculateCvdPercentile(symbol: string, cvd60s: number): number {
    const state = this.getOrCreate(symbol);
    return state.cvd60sStats.calculatePercentileRank(cvd60s);
  }

  calculateTradeFrequencyZ(symbol: string, tradeFreq60s: number): number {
    const state = this.getOrCreate(symbol);
    return state.tradeFreq60sStats.calculateZScore(tradeFreq60s);
  }

  calculateTradeFrequencyPercentile(
    symbol: string,
    tradeFreq60s: number,
  ): number {
    const state = this.getOrCreate(symbol);
    return state.tradeFreq60sStats.calculatePercentileRank(tradeFreq60s);
  }

  calculateBuyPressureZ(symbol: string, buyPressure60s: number): number {
    const state = this.getOrCreate(symbol);
    return state.buyPressure60sStats.calculateZScore(buyPressure60s);
  }

  getLargeTradeThresholds(symbol: string): { p95: number; p99: number } {
    const state = this.getOrCreate(symbol);
    const metrics = state.tradeSizeStats.calculateMetrics();
    // Default fallback thresholds for small initial history
    const fallbackP95 = 5_000;
    const fallbackP99 = 15_000;
    return {
      p95: metrics.count >= 30 ? Math.max(metrics.p95, 1000) : fallbackP95,
      p99: metrics.count >= 30 ? Math.max(metrics.p99, 2000) : fallbackP99,
    };
  }
}

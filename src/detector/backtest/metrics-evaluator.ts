import { NormalizedTrade } from '../types/market-event.types.js';
import { DetectorOutput } from '../types/detector-output.types.js';

export interface SignalOutcome {
  symbol: string;
  signalTime: number;
  entryPrice: number;
  signalLevel: string;
  totalScore: number;

  // Maximum Excursions
  mfe_30s: number; // Max % gain in 30s
  mae_30s: number; // Max % drawdown in 30s
  mfe_60s: number;
  mae_60s: number;
  mfe_120s: number;
  mae_120s: number;
  mfe_300s: number;
  mae_300s: number;

  // Multi-horizon targets hit
  hit_05pct_30s: boolean;
  hit_1pct_30s: boolean;
  hit_15pct_60s: boolean;
  hit_2pct_60s: boolean;
  hit_3pct_120s: boolean;
  hit_5pct_30s: boolean;

  // Lead Time (seconds before price touched +1.0%)
  leadTimeSeconds: number | null;

  isWin: boolean; // MFE >= targetWinMfe (e.g. 1.5%) before MAE <= stopLossMae (e.g. -0.6%)
}

export interface BacktestSummaryMetrics {
  totalSignals: number;
  wins: number;
  losses: number;
  winRate: number; // %
  precision: number; // wins / totalSignals
  averageMfe_60s: number;
  averageMae_60s: number;
  averageLeadTimeSeconds: number;
  medianLeadTimeSeconds: number;
}

export class MetricsEvaluator {
  /**
   * Evaluates the outcome of a signal against future ticks/trades.
   */
  evaluateSignalOutcome(
    detectorOutput: DetectorOutput,
    entryPrice: number,
    futureTrades: NormalizedTrade[],
    targetWinMfe = 1.5,
    stopLossMae = -0.6,
  ): SignalOutcome {
    const t0 = detectorOutput.timestamp;
    const symbol = detectorOutput.symbol;

    let mfe_30s = 0, mae_30s = 0;
    let mfe_60s = 0, mae_60s = 0;
    let mfe_120s = 0, mae_120s = 0;
    let mfe_300s = 0, mae_300s = 0;

    let hit_05pct_30s = false;
    let hit_1pct_30s = false;
    let hit_15pct_60s = false;
    let hit_2pct_60s = false;
    let hit_3pct_120s = false;
    let hit_5pct_30s = false;

    let leadTimeSeconds: number | null = null;
    let isWin = false;
    let stoppedOut = false;

    for (const trade of futureTrades) {
      if (trade.timestamp < t0) continue;
      const elapsedSec = (trade.timestamp - t0) / 1000;
      if (elapsedSec > 300) break; // Evaluate up to 300s (5m)

      const pnlPct = ((trade.price - entryPrice) / entryPrice) * 100;

      // Update 30s window
      if (elapsedSec <= 30) {
        if (pnlPct > mfe_30s) mfe_30s = pnlPct;
        if (pnlPct < mae_30s) mae_30s = pnlPct;
        if (pnlPct >= 0.5) hit_05pct_30s = true;
        if (pnlPct >= 1.0) hit_1pct_30s = true;
        if (pnlPct >= 5.0) hit_5pct_30s = true;
      }

      // Update 60s window
      if (elapsedSec <= 60) {
        if (pnlPct > mfe_60s) mfe_60s = pnlPct;
        if (pnlPct < mae_60s) mae_60s = pnlPct;
        if (pnlPct >= 1.5) hit_15pct_60s = true;
        if (pnlPct >= 2.0) hit_2pct_60s = true;
      }

      // Update 120s window
      if (elapsedSec <= 120) {
        if (pnlPct > mfe_120s) mfe_120s = pnlPct;
        if (pnlPct < mae_120s) mae_120s = pnlPct;
        if (pnlPct >= 3.0) hit_3pct_120s = true;
      }

      // Update 300s window
      if (pnlPct > mfe_300s) mfe_300s = pnlPct;
      if (pnlPct < mae_300s) mae_300s = pnlPct;

      // Check Lead Time (first moment price touches +1.0%)
      if (pnlPct >= 1.0 && leadTimeSeconds === null) {
        leadTimeSeconds = Math.round(elapsedSec * 10) / 10;
      }

      // Win evaluation: Did we reach target win before hitting stop loss?
      if (!isWin && !stoppedOut) {
        if (pnlPct <= stopLossMae) {
          stoppedOut = true;
        } else if (pnlPct >= targetWinMfe) {
          isWin = true;
        }
      }
    }

    return {
      symbol,
      signalTime: t0,
      entryPrice,
      signalLevel: detectorOutput.signal,
      totalScore: detectorOutput.totalScore,
      mfe_30s: Math.round(mfe_30s * 100) / 100,
      mae_30s: Math.round(mae_30s * 100) / 100,
      mfe_60s: Math.round(mfe_60s * 100) / 100,
      mae_60s: Math.round(mae_60s * 100) / 100,
      mfe_120s: Math.round(mfe_120s * 100) / 100,
      mae_120s: Math.round(mae_120s * 100) / 100,
      mfe_300s: Math.round(mfe_300s * 100) / 100,
      mae_300s: Math.round(mae_300s * 100) / 100,
      hit_05pct_30s,
      hit_1pct_30s,
      hit_15pct_60s,
      hit_2pct_60s,
      hit_3pct_120s,
      hit_5pct_30s,
      leadTimeSeconds,
      isWin,
    };
  }

  /**
   * Aggregates multiple outcomes into overall backtest summary statistics.
   */
  calculateBacktestSummary(outcomes: SignalOutcome[]): BacktestSummaryMetrics {
    if (outcomes.length === 0) {
      return {
        totalSignals: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        precision: 0,
        averageMfe_60s: 0,
        averageMae_60s: 0,
        averageLeadTimeSeconds: 0,
        medianLeadTimeSeconds: 0,
      };
    }

    const totalSignals = outcomes.length;
    let wins = 0;
    let sumMfe60s = 0;
    let sumMae60s = 0;
    const leadTimes: number[] = [];

    for (const o of outcomes) {
      if (o.isWin) wins++;
      sumMfe60s += o.mfe_60s;
      sumMae60s += o.mae_60s;
      if (o.leadTimeSeconds !== null) {
        leadTimes.push(o.leadTimeSeconds);
      }
    }

    const precision = wins / totalSignals;
    const winRate = Math.round(precision * 1000) / 10;
    const averageMfe_60s = Math.round((sumMfe60s / totalSignals) * 100) / 100;
    const averageMae_60s = Math.round((sumMae60s / totalSignals) * 100) / 100;

    const averageLeadTimeSeconds =
      leadTimes.length > 0
        ? Math.round((leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length) * 10) / 10
        : 0;

    leadTimes.sort((a, b) => a - b);
    const medianLeadTimeSeconds =
      leadTimes.length > 0
        ? leadTimes[Math.floor(leadTimes.length / 2)]
        : 0;

    return {
      totalSignals,
      wins,
      losses: totalSignals - wins,
      winRate,
      precision: Math.round(precision * 100) / 100,
      averageMfe_60s,
      averageMae_60s,
      averageLeadTimeSeconds,
      medianLeadTimeSeconds,
    };
  }
}

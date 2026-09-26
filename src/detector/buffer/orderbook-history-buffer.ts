import {
  NormalizedDepthSnapshot,
} from '../types/market-event.types.js';
import {
  DEPTH_LEVELS,
  DepthAtLevel,
} from '../types/liquidity.types.js';

export interface EvaluatedDepthSnapshot {
  timestamp: number;
  midPrice: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  spreadPct: number;
  depthByLevel: Record<string, DepthAtLevel>;
  totalBidDepth_1pct: number;
  totalAskDepth_1pct: number;
}

export class OrderBookHistoryBuffer {
  private snapshots: EvaluatedDepthSnapshot[] = [];
  private readonly maxDurationMs: number;
  private readonly maxCapacity: number;

  constructor(maxDurationMs = 65 * 1000, maxCapacity = 500) {
    this.maxDurationMs = maxDurationMs;
    this.maxCapacity = maxCapacity;
  }

  addDepth(rawSnapshot: NormalizedDepthSnapshot): EvaluatedDepthSnapshot | null {
    if (rawSnapshot.bids.length === 0 || rawSnapshot.asks.length === 0) {
      return null;
    }

    const bestBid = rawSnapshot.bids[0][0];
    const bestAsk = rawSnapshot.asks[0][0];
    if (bestBid <= 0 || bestAsk <= 0 || bestAsk < bestBid) {
      return null;
    }

    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadPct = midPrice > 0 ? (spread / midPrice) * 100 : 0;

    // Calculate depth at each percentage level
    const depthByLevel: Record<string, DepthAtLevel> = {};
    let totalBidDepth_1pct = 0;
    let totalAskDepth_1pct = 0;

    for (const level of DEPTH_LEVELS) {
      const levelFactor = level / 100;
      const minBidPrice = midPrice * (1 - levelFactor);
      const maxAskPrice = midPrice * (1 + levelFactor);

      let bidDepthUsdt = 0;
      for (const [p, q] of rawSnapshot.bids) {
        if (p >= minBidPrice) {
          bidDepthUsdt += p * q;
        } else {
          break; // Bids are sorted descending
        }
      }

      let askDepthUsdt = 0;
      for (const [p, q] of rawSnapshot.asks) {
        if (p <= maxAskPrice) {
          askDepthUsdt += p * q;
        } else {
          break; // Asks are sorted ascending
        }
      }

      const totalDepth = bidDepthUsdt + askDepthUsdt;
      const imbalance =
        totalDepth > 0 ? (bidDepthUsdt - askDepthUsdt) / totalDepth : 0;
      const depthRatio = bidDepthUsdt / Math.max(askDepthUsdt, 1);

      const key = `${level.toFixed(2)}%`;
      depthByLevel[key] = {
        bidDepthUsdt,
        askDepthUsdt,
        imbalance,
        depthRatio,
      };

      if (level === 1.0) {
        totalBidDepth_1pct = bidDepthUsdt;
        totalAskDepth_1pct = askDepthUsdt;
      }
    }

    const evaluated: EvaluatedDepthSnapshot = {
      timestamp: rawSnapshot.timestamp,
      midPrice,
      bestBid,
      bestAsk,
      spread,
      spreadPct,
      depthByLevel,
      totalBidDepth_1pct,
      totalAskDepth_1pct,
    };

    this.snapshots.push(evaluated);

    // Prune stale snapshots
    const cutoff = rawSnapshot.timestamp - this.maxDurationMs;
    if (this.snapshots.length > this.maxCapacity || this.snapshots.length % 50 === 0) {
      let firstKeep = 0;
      while (
        firstKeep < this.snapshots.length &&
        this.snapshots[firstKeep].timestamp < cutoff
      ) {
        firstKeep++;
      }
      if (firstKeep > 0) {
        this.snapshots = this.snapshots.slice(firstKeep);
      }
    }

    return evaluated;
  }

  getLatest(): EvaluatedDepthSnapshot | null {
    if (this.snapshots.length === 0) return null;
    return this.snapshots[this.snapshots.length - 1];
  }

  /**
   * Retrieves the closest snapshot recorded around (now - offsetMs).
   */
  getSnapshotAgo(offsetMs: number, now = Date.now()): EvaluatedDepthSnapshot | null {
    if (this.snapshots.length === 0) return null;
    const targetTime = now - offsetMs;

    let closest = this.snapshots[0];
    let minDiff = Math.abs(closest.timestamp - targetTime);

    for (let i = 1; i < this.snapshots.length; i++) {
      const snap = this.snapshots[i];
      const diff = Math.abs(snap.timestamp - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        closest = snap;
      }
    }

    // Only return if within acceptable temporal tolerance (<= offsetMs / 2 or 5s)
    if (minDiff > Math.max(5000, offsetMs * 0.75)) {
      return null;
    }

    return closest;
  }

  /**
   * Calculates spread volatility (standard deviation of spreadPct) over the last durationMs.
   */
  getSpreadVolatility(durationMs = 30_000, now = Date.now()): number {
    const cutoff = now - durationMs;
    const recent = this.snapshots.filter((s) => s.timestamp >= cutoff);
    if (recent.length < 3) return 0;

    let sum = 0;
    let sumSq = 0;
    for (const s of recent) {
      sum += s.spreadPct;
      sumSq += s.spreadPct * s.spreadPct;
    }
    const n = recent.length;
    const mean = sum / n;
    const variance = Math.max(0, sumSq / n - mean * mean);
    return Math.sqrt(variance);
  }

  get length(): number {
    return this.snapshots.length;
  }
}

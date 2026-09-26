import {
  NormalizedTrade,
  TIME_WINDOW_MS,
  TimeWindowKey,
} from '../types/market-event.types.js';

export interface WindowTradeAggregates {
  durationMs: number;
  tradeCount: number;
  totalQuoteVolume: number;
  totalBaseVolume: number;
  buyQuoteVolume: number;
  sellQuoteVolume: number;
  cvd: number; // buyQuoteVolume - sellQuoteVolume
  buyPressure: number; // buyQuoteVolume / totalQuoteVolume (0 - 1)
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  vwap: number;
  largeBuyCount: number;
  largeBuyVolume: number;
  largeSellCount: number;
  largeSellVolume: number;
}

export class TimeWindowRingBuffer {
  private trades: NormalizedTrade[] = [];
  private readonly maxDurationMs: number;
  private readonly maxTradeCapacity: number;

  constructor(maxDurationMs = 65 * 60 * 1000, maxTradeCapacity = 100_000) {
    this.maxDurationMs = maxDurationMs;
    this.maxTradeCapacity = maxTradeCapacity;
  }

  addTrade(trade: NormalizedTrade): void {
    const len = this.trades.length;
    if (len === 0 || trade.timestamp >= this.trades[len - 1].timestamp) {
      this.trades.push(trade);
    } else {
      // Find insertion index via binary search
      let low = 0;
      let high = len - 1;
      let insertIdx = len;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (this.trades[mid].timestamp > trade.timestamp) {
          insertIdx = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }
      this.trades.splice(insertIdx, 0, trade);
    }

    // Occasional cleanup of stale trades (every 1000 trades or when capacity breached)
    if (
      this.trades.length > this.maxTradeCapacity ||
      this.trades.length % 1000 === 0
    ) {
      this.pruneStale(trade.timestamp);
    }
  }

  get length(): number {
    return this.trades.length;
  }

  private pruneStale(currentTimestamp: number): void {
    const cutoff = currentTimestamp - this.maxDurationMs;
    // Fast binary search to find first index >= cutoff
    let low = 0;
    let high = this.trades.length - 1;
    let firstKeepIndex = this.trades.length;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.trades[mid].timestamp >= cutoff) {
        firstKeepIndex = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    if (firstKeepIndex > 0) {
      this.trades = this.trades.slice(firstKeepIndex);
    }

    // Also enforce maxTradeCapacity cap if needed
    if (this.trades.length > this.maxTradeCapacity) {
      this.trades = this.trades.slice(
        this.trades.length - this.maxTradeCapacity,
      );
    }
  }

  /**
   * Retrieves trades within the interval [now - durationMs, now]
   */
  getTradesInWindow(durationMs: number, now = Date.now()): NormalizedTrade[] {
    const cutoff = now - durationMs;
    const len = this.trades.length;
    if (len === 0) return [];

    let low = 0;
    let high = len - 1;
    let startIndex = len;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.trades[mid].timestamp >= cutoff) {
        startIndex = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    if (startIndex >= len) return [];

    // Find endIndex: last index where timestamp <= now
    low = startIndex;
    high = len - 1;
    let endIndex = startIndex - 1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.trades[mid].timestamp <= now) {
        endIndex = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (endIndex < startIndex) return [];
    return this.trades.slice(startIndex, endIndex + 1);
  }

  /**
   * Computes aggregated order flow and price metrics for a given duration.
   */
  getAggregatesForWindow(
    durationMs: number,
    largeTradeThreshold = 10_000,
    now = Date.now(),
  ): WindowTradeAggregates {
    const trades = this.getTradesInWindow(durationMs, now);
    const count = trades.length;

    if (count === 0) {
      const fallbackPrice =
        this.trades.length > 0
          ? this.trades[this.trades.length - 1].price
          : 0;
      return {
        durationMs,
        tradeCount: 0,
        totalQuoteVolume: 0,
        totalBaseVolume: 0,
        buyQuoteVolume: 0,
        sellQuoteVolume: 0,
        cvd: 0,
        buyPressure: 0.5,
        openPrice: fallbackPrice,
        highPrice: fallbackPrice,
        lowPrice: fallbackPrice,
        closePrice: fallbackPrice,
        vwap: fallbackPrice,
        largeBuyCount: 0,
        largeBuyVolume: 0,
        largeSellCount: 0,
        largeSellVolume: 0,
      };
    }

    let totalQuoteVolume = 0;
    let totalBaseVolume = 0;
    let buyQuoteVolume = 0;
    let sellQuoteVolume = 0;
    let highPrice = -Infinity;
    let lowPrice = Infinity;
    let largeBuyCount = 0;
    let largeBuyVolume = 0;
    let largeSellCount = 0;
    let largeSellVolume = 0;

    const openPrice = trades[0].price;
    const closePrice = trades[count - 1].price;

    for (let i = 0; i < count; i++) {
      const t = trades[i];
      const p = t.price;
      const q = t.quantity;
      const quote = t.quoteVolume;

      totalQuoteVolume += quote;
      totalBaseVolume += q;

      if (p > highPrice) highPrice = p;
      if (p < lowPrice) lowPrice = p;

      if (t.isBuyerTaker) {
        buyQuoteVolume += quote;
        if (quote >= largeTradeThreshold) {
          largeBuyCount++;
          largeBuyVolume += quote;
        }
      } else {
        sellQuoteVolume += quote;
        if (quote >= largeTradeThreshold) {
          largeSellCount++;
          largeSellVolume += quote;
        }
      }
    }

    const cvd = buyQuoteVolume - sellQuoteVolume;
    const buyPressure =
      totalQuoteVolume > 0 ? buyQuoteVolume / totalQuoteVolume : 0.5;
    const vwap =
      totalBaseVolume > 0 ? totalQuoteVolume / totalBaseVolume : closePrice;

    return {
      durationMs,
      tradeCount: count,
      totalQuoteVolume,
      totalBaseVolume,
      buyQuoteVolume,
      sellQuoteVolume,
      cvd,
      buyPressure,
      openPrice,
      highPrice,
      lowPrice,
      closePrice,
      vwap,
      largeBuyCount,
      largeBuyVolume,
      largeSellCount,
      largeSellVolume,
    };
  }

  /**
   * Computes aggregates for all standard time windows defined in the spec.
   */
  getAllWindowAggregates(
    largeTradeThreshold = 10_000,
    now = Date.now(),
  ): Record<TimeWindowKey, WindowTradeAggregates> {
    return {
      '5s': this.getAggregatesForWindow(TIME_WINDOW_MS['5s'], largeTradeThreshold, now),
      '10s': this.getAggregatesForWindow(TIME_WINDOW_MS['10s'], largeTradeThreshold, now),
      '15s': this.getAggregatesForWindow(TIME_WINDOW_MS['15s'], largeTradeThreshold, now),
      '30s': this.getAggregatesForWindow(TIME_WINDOW_MS['30s'], largeTradeThreshold, now),
      '60s': this.getAggregatesForWindow(TIME_WINDOW_MS['60s'], largeTradeThreshold, now),
      '3m': this.getAggregatesForWindow(TIME_WINDOW_MS['3m'], largeTradeThreshold, now),
      '5m': this.getAggregatesForWindow(TIME_WINDOW_MS['5m'], largeTradeThreshold, now),
      '15m': this.getAggregatesForWindow(TIME_WINDOW_MS['15m'], largeTradeThreshold, now),
      '1h': this.getAggregatesForWindow(TIME_WINDOW_MS['1h'], largeTradeThreshold, now),
    };
  }

  getLatestPrice(): number {
    return this.trades.length > 0 ? this.trades[this.trades.length - 1].price : 0;
  }
}

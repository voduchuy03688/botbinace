import { Logger } from '@nestjs/common';
import WebSocket from 'ws';
import {
  NormalizedBookTicker,
  NormalizedDepthSnapshot,
  NormalizedTrade,
  RawAggTradeMessage,
  RawBookTickerMessage,
  RawDepthUpdateMessage,
} from '../types/market-event.types.js';

export interface BinanceWsConfig {
  baseUrl?: string;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  heartbeatIntervalMs?: number;
  staleTimeoutMs?: number;
}

export type TradeHandler = (trade: NormalizedTrade) => void;
export type BookTickerHandler = (ticker: NormalizedBookTicker) => void;
export type DepthHandler = (depth: NormalizedDepthSnapshot) => void;
export type LagHandler = (symbol: string, lagMs: number) => void;

export class BinanceWsManager {
  private readonly logger = new Logger(BinanceWsManager.name);
  private ws: WebSocket | null = null;
  private isIntentionalClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastMessageTimestamp = 0;

  private readonly baseUrl: string;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly staleTimeoutMs: number;

  private streams: Set<string> = new Set();
  private onTradeListeners: TradeHandler[] = [];
  private onBookTickerListeners: BookTickerHandler[] = [];
  private onDepthListeners: DepthHandler[] = [];
  private onLagListeners: LagHandler[] = [];

  constructor(config?: BinanceWsConfig) {
    this.baseUrl = config?.baseUrl || 'wss://fstream.binance.com/stream';
    this.reconnectBaseDelayMs = config?.reconnectBaseDelayMs || 1000;
    this.reconnectMaxDelayMs = config?.reconnectMaxDelayMs || 15_000;
    this.heartbeatIntervalMs = config?.heartbeatIntervalMs || 25_000;
    this.staleTimeoutMs = config?.staleTimeoutMs || 15_000;
  }

  onTrade(listener: TradeHandler): void {
    this.onTradeListeners.push(listener);
  }

  onBookTicker(listener: BookTickerHandler): void {
    this.onBookTickerListeners.push(listener);
  }

  onDepth(listener: DepthHandler): void {
    this.onDepthListeners.push(listener);
  }

  onLag(listener: LagHandler): void {
    this.onLagListeners.push(listener);
  }

  /**
   * Subscribes to standard streams for a symbol: aggTrade, bookTicker, depth20@100ms
   */
  subscribeSymbol(symbol: string): void {
    const s = symbol.toLowerCase();
    this.streams.add(`${s}@aggTrade`);
    this.streams.add(`${s}@bookTicker`);
    this.streams.add(`${s}@depth20@100ms`);

    if (this.isConnected()) {
      this.sendSubscription([
        `${s}@aggTrade`,
        `${s}@bookTicker`,
        `${s}@depth20@100ms`,
      ]);
    }
  }

  subscribeSymbols(symbols: string[]): void {
    for (const sym of symbols) {
      const s = sym.toLowerCase();
      this.streams.add(`${s}@aggTrade`);
      this.streams.add(`${s}@bookTicker`);
      this.streams.add(`${s}@depth20@100ms`);
    }

    if (this.isConnected()) {
      const allStreams = Array.from(this.streams);
      this.sendSubscription(allStreams);
    }
  }

  connect(): void {
    this.isIntentionalClose = false;
    this.clearTimers();

    if (this.streams.size === 0) {
      this.logger.warn('No streams registered yet before connect.');
      return;
    }

    const streamParam = Array.from(this.streams).join('/');
    const url = `${this.baseUrl}?streams=${streamParam}`;

    this.logger.log(`Connecting to Binance WebSocket with ${this.streams.size} streams...`);
    try {
      this.ws = new WebSocket(url);
      this.setupSocketEvents();
    } catch (err: any) {
      this.logger.error(`WebSocket creation error: ${err.message}`);
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.isIntentionalClose = true;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (err: any) {
        this.logger.warn(`Error closing WebSocket: ${err.message}`);
      }
      this.ws = null;
    }
    this.logger.log('Binance WebSocket disconnected.');
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private setupSocketEvents(): void {
    if (!this.ws) return;

    this.ws.on('open', () => {
      this.logger.log('Binance WebSocket connection established successfully.');
      this.reconnectAttempts = 0;
      this.lastMessageTimestamp = Date.now();
      this.startHeartbeat();
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      this.lastMessageTimestamp = Date.now();
      try {
        const text = data.toString();
        const parsed = JSON.parse(text);
        this.handleStreamMessage(parsed);
      } catch (err: any) {
        this.logger.error(`Failed to parse WebSocket message: ${err.message}`);
      }
    });

    this.ws.on('ping', () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.pong();
      }
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error(`WebSocket socket error: ${err.message}`);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.logger.warn(
        `WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`,
      );
      if (!this.isIntentionalClose) {
        this.scheduleReconnect();
      }
    });
  }

  private handleStreamMessage(payload: any): void {
    // Combined stream format: { stream: 'btcusdt@aggTrade', data: { ... } }
    const data = payload.data || payload;
    if (!data || !data.e) {
      // Check for bookTicker without 'e' property
      if (data && data.s && data.b && data.a && data.u) {
        this.processBookTicker(data as RawBookTickerMessage);
      }
      return;
    }

    const now = Date.now();

    // Check for message lag
    if (data.E) {
      const lagMs = now - data.E;
      if (lagMs > 2000 && data.s) {
        for (const listener of this.onLagListeners) {
          listener(data.s, lagMs);
        }
      }
    }

    if (data.e === 'aggTrade') {
      this.processAggTrade(data as RawAggTradeMessage);
    } else if (data.e === 'depthUpdate') {
      this.processDepthUpdate(data as RawDepthUpdateMessage);
    } else if (data.e === 'bookTicker') {
      this.processBookTicker(data as RawBookTickerMessage);
    }
  }

  private processAggTrade(raw: RawAggTradeMessage): void {
    const price = parseFloat(raw.p);
    const quantity = parseFloat(raw.q);
    const quoteVolume = price * quantity;

    const trade: NormalizedTrade = {
      symbol: raw.s,
      tradeId: raw.a,
      price,
      quantity,
      quoteVolume,
      timestamp: raw.T || raw.E,
      // If m is true, buyer is maker -> aggressor is seller (taker sell).
      // If m is false, buyer is taker -> aggressor is buyer (taker buy).
      isBuyerTaker: !raw.m,
    };

    for (const listener of this.onTradeListeners) {
      listener(trade);
    }
  }

  private processBookTicker(raw: RawBookTickerMessage): void {
    const bestBid = parseFloat(raw.b);
    const bestBidQty = parseFloat(raw.B);
    const bestAsk = parseFloat(raw.a);
    const bestAskQty = parseFloat(raw.A);
    const spread = bestAsk - bestBid;
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadPct = midPrice > 0 ? (spread / midPrice) * 100 : 0;

    const ticker: NormalizedBookTicker = {
      symbol: raw.s,
      bestBid,
      bestBidQty,
      bestAsk,
      bestAskQty,
      spread,
      spreadPct,
      midPrice,
      timestamp: raw.T || raw.E || Date.now(),
    };

    for (const listener of this.onBookTickerListeners) {
      listener(ticker);
    }
  }

  private processDepthUpdate(raw: RawDepthUpdateMessage): void {
    const bids: [number, number][] = (raw.b || [])
      .map(([p, q]) => [parseFloat(p), parseFloat(q)] as [number, number])
      .sort((a, b) => b[0] - a[0]); // Descending

    const asks: [number, number][] = (raw.a || [])
      .map(([p, q]) => [parseFloat(p), parseFloat(q)] as [number, number])
      .sort((a, b) => a[0] - b[0]); // Ascending

    const snapshot: NormalizedDepthSnapshot = {
      symbol: raw.s,
      bids,
      asks,
      timestamp: raw.T || raw.E || Date.now(),
    };

    for (const listener of this.onDepthListeners) {
      listener(snapshot);
    }
  }

  private sendSubscription(streamList: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = {
      method: 'SUBSCRIBE',
      params: streamList,
      id: Date.now(),
    };
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err: any) {
      this.logger.error(`Error sending subscription: ${err.message}`);
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      const now = Date.now();
      // Check for silent connection freeze (stale socket)
      if (now - this.lastMessageTimestamp > this.staleTimeoutMs) {
        this.logger.warn(
          `WebSocket connection appears stale (no message for ${now - this.lastMessageTimestamp}ms). Reconnecting...`,
        );
        try {
          this.ws.terminate();
        } catch {
          // ignore
        }
        return;
      }

      try {
        this.ws.ping();
      } catch (err: any) {
        this.logger.error(`Error sending ping: ${err.message}`);
      }
    }, this.heartbeatIntervalMs);
  }

  private scheduleReconnect(): void {
    if (this.isIntentionalClose) return;

    this.clearTimers();
    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectBaseDelayMs * Math.pow(1.5, this.reconnectAttempts) +
        Math.random() * 500,
      this.reconnectMaxDelayMs,
    );

    this.logger.log(
      `Scheduling WebSocket reconnect in ${Math.round(delay)}ms (attempt #${this.reconnectAttempts})...`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

/**
 * Market event types for Binance Realtime Streams (Futures & Spot)
 * According to Binance Early Expansion Detector Specification.
 */

export interface RawAggTradeMessage {
  e: 'aggTrade';
  E: number; // Event time
  s: string; // Symbol (e.g. BTCUSDT)
  a: number; // Aggregate trade ID
  p: string; // Price
  q: string; // Quantity
  f: number; // First trade ID
  l: number; // Last trade ID
  T: number; // Trade time
  m: boolean; // Was the buyer the maker? (true = sell aggressor, false = buy aggressor)
}

export interface NormalizedTrade {
  symbol: string;
  tradeId: number;
  price: number;
  quantity: number;
  quoteVolume: number;
  timestamp: number;
  isBuyerTaker: boolean; // true = Aggressive Buy, false = Aggressive Sell
}

export interface RawDepthUpdateMessage {
  e: 'depthUpdate';
  E: number; // Event time
  T: number; // Transaction time
  s: string; // Symbol
  U?: number; // First update ID in event
  u: number; // Final update ID in event
  pu?: number; // Final update ID in last event
  b: [string, string][]; // Bids: [price, qty][]
  a: [string, string][]; // Asks: [price, qty][]
}

export interface RawBookTickerMessage {
  e?: 'bookTicker';
  u: number; // Update ID
  s: string; // Symbol
  b: string; // Best bid price
  B: string; // Best bid qty
  a: string; // Best ask price
  A: string; // Best ask qty
  T: number; // Transaction time
  E: number; // Event time
}

export interface NormalizedBookTicker {
  symbol: string;
  bestBid: number;
  bestBidQty: number;
  bestAsk: number;
  bestAskQty: number;
  spread: number;
  spreadPct: number;
  midPrice: number;
  timestamp: number;
}

export interface NormalizedDepthSnapshot {
  symbol: string;
  bids: [number, number][]; // [price, qty] sorted descending
  asks: [number, number][]; // [price, qty] sorted ascending
  timestamp: number;
}

export type TimeWindowKey =
  | '5s'
  | '10s'
  | '15s'
  | '30s'
  | '60s'
  | '3m'
  | '5m'
  | '15m'
  | '1h';

export const TIME_WINDOW_MS: Record<TimeWindowKey, number> = {
  '5s': 5 * 1000,
  '10s': 10 * 1000,
  '15s': 15 * 1000,
  '30s': 30 * 1000,
  '60s': 60 * 1000,
  '3m': 3 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
};

export const TIME_WINDOWS_LIST: TimeWindowKey[] = [
  '5s',
  '10s',
  '15s',
  '30s',
  '60s',
  '3m',
  '5m',
  '15m',
  '1h',
];

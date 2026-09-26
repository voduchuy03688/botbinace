import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { BinanceWsManager } from '../../src/detector/websocket/binance-ws-manager.js';
import {
  NormalizedBookTicker,
  NormalizedDepthSnapshot,
  NormalizedTrade,
} from '../../src/detector/types/market-event.types.js';

describe('BinanceWsManager', () => {
  let wss: WebSocketServer;
  let port: number;
  let clientWs: WebSocket | null = null;

  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => {
      wss.on('listening', () => {
        const addr = wss.address();
        if (typeof addr === 'object' && addr !== null) {
          port = addr.port;
        }
        resolve();
      });
    });

    wss.on('connection', (ws) => {
      clientWs = ws;
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  });

  it('connects, subscribes, and parses normalized aggTrade events', async () => {
    const manager = new BinanceWsManager({
      baseUrl: `ws://127.0.0.1:${port}`,
    });

    manager.subscribeSymbol('BTCUSDT');

    const receivedTrades: NormalizedTrade[] = [];
    manager.onTrade((t) => receivedTrades.push(t));

    manager.connect();

    // Wait for connection to establish
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    // Send mock Binance aggTrade stream payload
    const mockAggTrade = {
      stream: 'btcusdt@aggTrade',
      data: {
        e: 'aggTrade',
        E: 1_700_000_000_100,
        s: 'BTCUSDT',
        a: 1234567,
        p: '65432.10',
        q: '1.500',
        f: 100,
        l: 102,
        T: 1_700_000_000_050,
        m: false, // buyer was taker -> aggressive buy!
      },
    };

    clientWs!.send(JSON.stringify(mockAggTrade));

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (receivedTrades.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    expect(receivedTrades.length).toBe(1);
    const trade = receivedTrades[0];
    expect(trade.symbol).toBe('BTCUSDT');
    expect(trade.price).toBe(65432.1);
    expect(trade.quantity).toBe(1.5);
    expect(trade.quoteVolume).toBeCloseTo(65432.1 * 1.5, 2);
    expect(trade.isBuyerTaker).toBe(true);

    manager.disconnect();
  });

  it('normalizes bookTicker and computes spread and midPrice accurately', async () => {
    const manager = new BinanceWsManager({
      baseUrl: `ws://127.0.0.1:${port}`,
    });

    manager.subscribeSymbol('ETHUSDT');

    const receivedTickers: NormalizedBookTicker[] = [];
    manager.onBookTicker((t) => receivedTickers.push(t));

    manager.connect();

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    const mockTicker = {
      stream: 'ethusdt@bookTicker',
      data: {
        e: 'bookTicker',
        u: 998877,
        s: 'ETHUSDT',
        b: '3450.00',
        B: '10.5',
        a: '3450.50',
        A: '8.2',
        T: 1_700_000_000_000,
        E: 1_700_000_000_010,
      },
    };

    clientWs!.send(JSON.stringify(mockTicker));

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (receivedTickers.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    expect(receivedTickers.length).toBe(1);
    const ticker = receivedTickers[0];
    expect(ticker.bestBid).toBe(3450.0);
    expect(ticker.bestAsk).toBe(3450.5);
    expect(ticker.spread).toBeCloseTo(0.5, 3);
    expect(ticker.midPrice).toBeCloseTo(3450.25, 3);

    manager.disconnect();
  });

  it('normalizes depthUpdate and sorts bids descending and asks ascending', async () => {
    const manager = new BinanceWsManager({
      baseUrl: `ws://127.0.0.1:${port}`,
    });

    manager.subscribeSymbol('SOLUSDT');

    const receivedDepths: NormalizedDepthSnapshot[] = [];
    manager.onDepth((d) => receivedDepths.push(d));

    manager.connect();

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    const mockDepth = {
      stream: 'solusdt@depth20@100ms',
      data: {
        e: 'depthUpdate',
        E: 1_700_000_000_000,
        T: 1_700_000_000_000,
        s: 'SOLUSDT',
        b: [
          ['140.0', '10'],
          ['141.0', '5'], // Out of order bids
          ['139.5', '20'],
        ],
        a: [
          ['142.0', '8'],
          ['141.5', '12'], // Out of order asks
          ['143.0', '15'],
        ],
      },
    };

    clientWs!.send(JSON.stringify(mockDepth));

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (receivedDepths.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    expect(receivedDepths.length).toBe(1);
    const depth = receivedDepths[0];
    // Bids must be sorted descending: 141.0, 140.0, 139.5
    expect(depth.bids[0][0]).toBe(141.0);
    expect(depth.bids[1][0]).toBe(140.0);
    expect(depth.bids[2][0]).toBe(139.5);

    // Asks must be sorted ascending: 141.5, 142.0, 143.0
    expect(depth.asks[0][0]).toBe(141.5);
    expect(depth.asks[1][0]).toBe(142.0);
    expect(depth.asks[2][0]).toBe(143.0);

    manager.disconnect();
  });
});

import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BinanceWsManager } from './websocket/binance-ws-manager.js';
import { TimeWindowRingBuffer } from './buffer/time-window-ring-buffer.js';
import { DynamicBaselineEngine } from './baseline/dynamic-baseline.js';
import { FlowEngine } from './features/flow-engine.js';
import { FlowFeatureSnapshot } from './types/feature.types.js';
import {
  NormalizedBookTicker,
  NormalizedDepthSnapshot,
  NormalizedTrade,
} from './types/market-event.types.js';
import { BinanceService } from '../binance/binance.service.js';
import { TelegramService } from '../telegram/telegram.service.js';
import { LiquidityEngine } from './features/liquidity-engine.js';
import { OrderBookHistoryBuffer } from './buffer/orderbook-history-buffer.js';
import { LiquidityFeatureSnapshot } from './types/liquidity.types.js';

import { StructureEngine } from './features/structure-engine.js';
import { StructureFeatureSnapshot } from './types/structure.types.js';

import { DerivativesMarketEngine } from './features/derivatives-market-engine.js';
import { ScoringEngine } from './scoring/scoring-engine.js';
import { DetectorOutput } from './types/detector-output.types.js';

@Injectable()
export class DetectorService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(DetectorService.name);

  private readonly ringBuffers: Map<string, TimeWindowRingBuffer> = new Map();
  private readonly orderBookBuffers: Map<string, OrderBookHistoryBuffer> =
    new Map();
  private readonly latestBookTickers: Map<string, NormalizedBookTicker> =
    new Map();
  private readonly latestDepths: Map<string, NormalizedDepthSnapshot> =
    new Map();

  private readonly symbolCooldowns: Map<string, number> = new Map();
  private lastGlobalAlertTime = 0;
  private isScanning = false;
  private isRunning = false;

  constructor(
    private readonly wsManager: BinanceWsManager,
    private readonly baselineEngine: DynamicBaselineEngine,
    private readonly flowEngine: FlowEngine,
    private readonly liquidityEngine: LiquidityEngine,
    private readonly structureEngine: StructureEngine,
    private readonly derivativesEngine: DerivativesMarketEngine,
    private readonly scoringEngine: ScoringEngine,
    private readonly binanceService: BinanceService,
    private readonly telegramService: TelegramService,
  ) {
    this.setupListeners();
  }

  async onApplicationBootstrap() {
    this.logger.log('Starting Binance Early Expansion Detector Engine...');
    this.isRunning = true;
    await this.initializeStreams();
  }

  onApplicationShutdown() {
    this.logger.log('Shutting down Binance Early Expansion Detector Engine...');
    this.isRunning = false;
    this.wsManager.disconnect();
  }

  private setupListeners(): void {
    // 1. Process AggTrades
    this.wsManager.onTrade((trade: NormalizedTrade) => {
      let buffer = this.ringBuffers.get(trade.symbol);
      if (!buffer) {
        buffer = new TimeWindowRingBuffer();
        this.ringBuffers.set(trade.symbol, buffer);
      }

      buffer.addTrade(trade);
      this.baselineEngine.recordTrade(trade.symbol, trade.quoteVolume);
    });

    // 2. Process BookTickers
    this.wsManager.onBookTicker((ticker: NormalizedBookTicker) => {
      this.latestBookTickers.set(ticker.symbol, ticker);
    });

    // 3. Process Depth Snapshots
    this.wsManager.onDepth((depth: NormalizedDepthSnapshot) => {
      this.latestDepths.set(depth.symbol, depth);

      let bookBuffer = this.orderBookBuffers.get(depth.symbol);
      if (!bookBuffer) {
        bookBuffer = new OrderBookHistoryBuffer();
        this.orderBookBuffers.set(depth.symbol, bookBuffer);
      }
      bookBuffer.addDepth(depth);
    });

    // 4. Handle Lag / Stale stream
    this.wsManager.onLag((symbol: string, lagMs: number) => {
      this.logger.warn(`High stream lag detected on ${symbol}: ${lagMs}ms`);
    });
  }

  /**
   * Initializes streams for top active futures symbols.
   */
  async initializeStreams(): Promise<void> {
    try {
      // Get active high liquidity symbols
      const symbols = await this.binanceService.getActiveSymbolsByVolume();
      const topPool = symbols.slice(0, 40); // Top 40 high volume tokens to monitor in real-time

      // Always include BTCUSDT for market regime evaluation
      if (!topPool.includes('BTCUSDT')) {
        topPool.unshift('BTCUSDT');
      }

      this.logger.log(
        `Registering ${topPool.length} active symbols to Binance Realtime WebSocket streams...`,
      );

      this.wsManager.subscribeSymbols(topPool);
      this.wsManager.connect();
    } catch (err: any) {
      this.logger.error(`Failed to initialize streams: ${err.message}`);
    }
  }

  getRingBuffer(symbol: string): TimeWindowRingBuffer | undefined {
    return this.ringBuffers.get(symbol);
  }

  getOrderBookBuffer(symbol: string): OrderBookHistoryBuffer | undefined {
    return this.orderBookBuffers.get(symbol);
  }

  getLatestBookTicker(symbol: string): NormalizedBookTicker | undefined {
    return this.latestBookTickers.get(symbol);
  }

  getLatestDepth(symbol: string): NormalizedDepthSnapshot | undefined {
    return this.latestDepths.get(symbol);
  }

  getBaselineEngine(): DynamicBaselineEngine {
    return this.baselineEngine;
  }

  /**
   * Evaluates current Order Flow features and FLOW_SCORE for a specific symbol.
   */
  evaluateFlow(symbol: string, now = Date.now()): FlowFeatureSnapshot | null {
    const buffer = this.ringBuffers.get(symbol);
    if (!buffer || buffer.length === 0) {
      return null;
    }
    return this.flowEngine.evaluateFlow(symbol, buffer, now);
  }

  /**
   * Evaluates current Order Book Liquidity features and LIQUIDITY_SCORE for a specific symbol.
   */
  evaluateLiquidity(
    symbol: string,
    now = Date.now(),
  ): LiquidityFeatureSnapshot | null {
    const bookBuffer = this.orderBookBuffers.get(symbol);
    if (!bookBuffer || bookBuffer.length === 0) {
      return null;
    }
    const tradeBuffer = this.ringBuffers.get(symbol);
    return this.liquidityEngine.evaluateLiquidity(
      symbol,
      bookBuffer,
      tradeBuffer,
      now,
    );
  }

  /**
   * Evaluates current Price Structure features and STRUCTURE_SCORE for a specific symbol.
   */
  evaluateStructure(
    symbol: string,
    now = Date.now(),
  ): StructureFeatureSnapshot | null {
    const tradeBuffer = this.ringBuffers.get(symbol);
    if (!tradeBuffer || tradeBuffer.length === 0) {
      return null;
    }
    const bookBuffer = this.orderBookBuffers.get(symbol);
    const flowSnapshot = this.evaluateFlow(symbol, now) || undefined;
    return this.structureEngine.evaluateStructure(
      symbol,
      tradeBuffer,
      bookBuffer,
      flowSnapshot,
      now,
    );
  }

  /**
   * Evaluates order flow for all monitored tokens.
   */
  evaluateAllFlows(now = Date.now()): FlowFeatureSnapshot[] {
    const snapshots: FlowFeatureSnapshot[] = [];
    for (const symbol of this.ringBuffers.keys()) {
      const snap = this.evaluateFlow(symbol, now);
      if (snap) snapshots.push(snap);
    }
    return snapshots.sort((a, b) => b.flowScore - a.flowScore);
  }

  /**
   * Evaluates all feature groups and returns the comprehensive DetectorOutput matching Spec Section 50.
   */
  evaluateSymbol(symbol: string, now = Date.now()): DetectorOutput | null {
    const flow = this.evaluateFlow(symbol, now);
    if (!flow) return null;

    const liquidity = this.evaluateLiquidity(symbol, now);
    const structure = this.evaluateStructure(symbol, now);

    const tokenBuffer = this.ringBuffers.get(symbol)!;
    const btcBuffer = this.ringBuffers.get('BTCUSDT');
    const derivatives = this.derivativesEngine.evaluateDerivativesAndMarket(
      symbol,
      tokenBuffer,
      btcBuffer,
      0,
      0.0001,
      now,
    );

    const depthSnapshot = this.latestDepths.get(symbol) || null;

    return this.scoringEngine.evaluate(
      symbol,
      flow,
      liquidity,
      structure,
      derivatives,
      depthSnapshot,
      now,
    );
  }

  /**
   * Scans all monitored tokens and returns ranked signals (EXECUTE -> READY -> WATCH).
   */
  scanAll(now = Date.now()): DetectorOutput[] {
    const outputs: DetectorOutput[] = [];
    for (const symbol of this.ringBuffers.keys()) {
      const out = this.evaluateSymbol(symbol, now);
      if (out) outputs.push(out);
    }

    // Rank by priority: EXECUTE > READY > WATCH > NONE, then by totalScore descending
    const priorityWeight: Record<string, number> = {
      EXECUTE: 4,
      READY: 3,
      WATCH: 2,
      NONE: 1,
    };

    return outputs.sort((a, b) => {
      const pDiff = (priorityWeight[b.signal] || 0) - (priorityWeight[a.signal] || 0);
      if (pDiff !== 0) return pDiff;
      return b.totalScore - a.totalScore;
    });
  }

  /**
   * Realtime scan loop running every 3 seconds across live WebSocket microstructure streams.
   * Automatically broadcasts verified Early Expansion (EXECUTE) signals to Telegram.
   */
  @Cron('*/3 * * * * *')
  async handleRealtimeExpansionScan(): Promise<void> {
    if (!this.isRunning || this.isScanning) return;
    this.isScanning = true;

    try {
      const rankedSignals = this.scanAll();
      const now = Date.now();

      for (const output of rankedSignals) {
        if (output.signal !== 'EXECUTE') continue;

        const lastAlert = this.symbolCooldowns.get(output.symbol) || 0;
        if (now - lastAlert < 10 * 60 * 1000) continue; // 10 minutes cooldown per token
        if (now - this.lastGlobalAlertTime < 3000) continue; // 3 seconds global cooldown

        const tradeBuffer = this.ringBuffers.get(output.symbol);
        const currentPrice = tradeBuffer ? tradeBuffer.getLatestPrice() : 0;
        if (currentPrice <= 0) continue;

        this.symbolCooldowns.set(output.symbol, now);
        this.lastGlobalAlertTime = now;

        this.logger.log(
          `⚡ [CHÂN SÓNG PHÁT HIỆN: ${output.symbol}] Score: ${output.totalScore}/100 | Giá: ${currentPrice} | CVD Accel: +${Math.round(output.cvdAcceleration)}`,
        );

        await this.telegramService.sendEarlyExpansionAlert(output, currentPrice);
      }
    } catch (err: any) {
      this.logger.error(`Error in realtime expansion scan: ${err.message}`);
    } finally {
      this.isScanning = false;
    }
  }
}

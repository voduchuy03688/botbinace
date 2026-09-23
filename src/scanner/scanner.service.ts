import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { BinanceService, KlineData } from '../binance/binance.service.js';
import { TelegramService, SpikeAlertPayload } from '../telegram/telegram.service.js';

@Injectable()
export class ScannerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScannerService.name);

  private symbols: string[] = [];
  private cooldowns: Map<string, number> = new Map();

  private spikeThresholdPct: number;
  private volumeMultiplierThreshold: number;
  private cooldownMs: number;
  private isScanning = false;

  constructor(
    private readonly binanceService: BinanceService,
    private readonly telegramService: TelegramService,
    private readonly configService: ConfigService,
  ) {
    this.spikeThresholdPct = parseFloat(
      this.configService.get<string>('SPIKE_THRESHOLD_PCT', '5.0'),
    );
    this.volumeMultiplierThreshold = parseFloat(
      this.configService.get<string>('VOLUME_SPIKE_MULTIPLIER', '5.0'),
    );
    const cooldownMinutes = parseFloat(
      this.configService.get<string>('COOLDOWN_MINUTES', '3'),
    );
    this.cooldownMs = cooldownMinutes * 60 * 1000;
  }

  async onApplicationBootstrap() {
    this.logger.log('Initializing Binance Market Scanner Service...');
    await this.refreshSymbols();
    this.logger.log(`Scanner initialized with threshold: Spike >= ${this.spikeThresholdPct}%, Vol Spike >= ${this.volumeMultiplierThreshold}x`);
  }

  @Cron('0 */30 * * * *')
  async refreshSymbols() {
    this.symbols = await this.binanceService.getUsdtFuturesSymbols();
  }

  @Cron('*/15 * * * * *') // Run every 15 seconds continuously
  async handleScanTick() {
    if (this.isScanning) {
      return;
    }
    if (this.symbols.length === 0) {
      await this.refreshSymbols();
      if (this.symbols.length === 0) return;
    }

    this.isScanning = true;
    try {
      const batchSize = 15; // Process in small concurrent batches to respect Binance rate limits
      for (let i = 0; i < this.symbols.length; i += batchSize) {
        const batch = this.symbols.slice(i, i + batchSize);
        await Promise.all(batch.map((sym) => this.scanSymbol(sym)));
      }
    } catch (err: any) {
      this.logger.error(`Error during market scan tick: ${err.message}`);
    } finally {
      this.isScanning = false;
    }
  }

  private async scanSymbol(symbol: string) {
    const now = Date.now();
    const lastAlertTime = this.cooldowns.get(symbol) || 0;
    if (now - lastAlertTime < this.cooldownMs) {
      return; // Symbol is in cooldown
    }

    const klines = await this.binanceService.getKlines(symbol, '1m', 21);
    if (!klines || klines.length < 5) return;

    // Latest 1m candle (current active or just closed)
    const currentCandle = klines[klines.length - 1];
    
    // Check 1: Price Spike (High - Open) / Open >= threshold or (Close - Open) / Open >= threshold
    const openPrice = currentCandle.open;
    const highPrice = currentCandle.high;
    const currentPrice = currentCandle.close;

    if (openPrice <= 0) return;

    const maxJumpPct = ((highPrice - openPrice) / openPrice) * 100;
    const closeJumpPct = ((currentPrice - openPrice) / openPrice) * 100;
    const spikePct = Math.max(maxJumpPct, closeJumpPct);

    // Calculate Volume baseline (MA of previous 20 candles)
    const historicalKlines = klines.slice(0, -1);
    const avgVolume =
      historicalKlines.reduce((acc, k) => acc + k.quoteVolume, 0) / historicalKlines.length;
    
    const currentVol = currentCandle.quoteVolume;
    const volumeMultiplier = avgVolume > 0 ? currentVol / avgVolume : 0;
    const takerBuyRatio =
      currentVol > 0 ? currentCandle.takerBuyQuoteVolume / currentVol : 0;

    let alertTriggered = false;
    let alertType: 'PRICE_PUMP' | 'VOLUME_SPIKE' = 'PRICE_PUMP';

    if (spikePct >= this.spikeThresholdPct) {
      alertTriggered = true;
      alertType = 'PRICE_PUMP';
    } else if (
      volumeMultiplier >= this.volumeMultiplierThreshold &&
      takerBuyRatio >= 0.55 &&
      currentVol >= 20000 // Minimum 20k USDT 1m volume to filter out low-liquidity noise
    ) {
      alertTriggered = true;
      alertType = 'VOLUME_SPIKE';
    }

    if (alertTriggered) {
      this.cooldowns.set(symbol, now);
      const payload: SpikeAlertPayload = {
        symbol,
        type: alertType,
        priceChangePct: spikePct,
        openPrice,
        highPrice,
        currentPrice,
        volume1m: Math.round(currentVol),
        avgVolume: Math.round(avgVolume),
        volumeMultiplier,
        takerBuyRatio,
      };

      this.logger.warn(
        `🚨 [ALERT DETECTED] ${symbol} -> Type: ${alertType}, Jump: +${spikePct.toFixed(2)}%, Vol Multiplier: ${volumeMultiplier.toFixed(1)}x`,
      );

      await this.telegramService.sendSpikeAlert(payload);
    }
  }
}

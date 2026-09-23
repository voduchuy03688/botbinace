import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { BinanceService } from '../binance/binance.service.js';
import { TelegramService, SpikeAlertPayload } from '../telegram/telegram.service.js';

interface AlertState {
  lastAlertTime: number;
  lastAlertPrice: number;
  alertCount: number;
}

@Injectable()
export class ScannerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScannerService.name);

  private symbols: string[] = [];
  private alertStates: Map<string, AlertState> = new Map();

  private spikeThresholdPct: number;
  private volumeMultiplierThreshold: number;
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
      this.configService.get<string>('VOLUME_SPIKE_MULTIPLIER', '3.5'),
    );
  }

  async onApplicationBootstrap() {
    this.logger.log('Initializing Binance Early Wave Scanner Service...');
    await this.refreshSymbols();
    this.logger.log(`Scanner initialized for Breakout Detection (Spike >= ${this.spikeThresholdPct}%, Vol Surge >= ${this.volumeMultiplierThreshold}x)`);
  }

  @Cron('0 */30 * * * *')
  async refreshSymbols() {
    this.symbols = await this.binanceService.getUsdtFuturesSymbols();
  }

  @Cron('*/12 * * * * *') // Scan every 12 seconds
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
      const batchSize = 20;
      for (let i = 0; i < this.symbols.length; i += batchSize) {
        const batch = this.symbols.slice(i, i + batchSize);
        await Promise.all(batch.map((sym) => this.scanSymbol(sym)));
      }
    } catch (err: any) {
      this.logger.error(`Error during scanner tick: ${err.message}`);
    } finally {
      this.isScanning = false;
    }
  }

  private async scanSymbol(symbol: string) {
    const klines = await this.binanceService.getKlines(symbol, '1m', 60);
    if (!klines || klines.length < 30) return;

    const currentCandle = klines[klines.length - 1];
    const openPrice = currentCandle.open;
    const highPrice = currentCandle.high;
    const currentPrice = currentCandle.close;

    if (openPrice <= 0) return;

    // 1. Current 1m Candle Pump %
    const maxJumpPct = ((highPrice - openPrice) / openPrice) * 100;
    const closeJumpPct = ((currentPrice - openPrice) / openPrice) * 100;
    const current1mSpikePct = Math.max(maxJumpPct, closeJumpPct);

    // 2. Baseline Volatility (Average 1m candle amplitude over previous 30 candles)
    const prev30Klines = klines.slice(-31, -1);
    const avgCandleRangePct =
      prev30Klines.reduce((sum, k) => {
        const range = k.open > 0 ? ((k.high - k.low) / k.open) * 100 : 0;
        return sum + range;
      }, 0) / prev30Klines.length;

    // Relative Volatility Surge Ratio (e.g. 3.5x normal smooth movements)
    const volatilitySurgeRatio = avgCandleRangePct > 0 ? current1mSpikePct / avgCandleRangePct : 1;

    // 3. Volume Surge & Taker Buy Ratio
    const avgVolume =
      prev30Klines.reduce((acc, k) => acc + k.quoteVolume, 0) / prev30Klines.length;
    const currentVol = currentCandle.quoteVolume;
    const volumeMultiplier = avgVolume > 0 ? currentVol / avgVolume : 0;
    const takerBuyRatio =
      currentVol > 0 ? currentCandle.takerBuyQuoteVolume / currentVol : 0;

    // 4. 1-Hour Trend Context (60 candles ago)
    const kline1hAgo = klines[0];
    const change1hPct =
      kline1hAgo && kline1hAgo.close > 0
        ? ((currentPrice - kline1hAgo.close) / kline1hAgo.close) * 100
        : undefined;

    // 5. Detection Criteria: Breakout ("Đầu Con Sóng") vs Wave Continuation
    const now = Date.now();
    const state = this.alertStates.get(symbol);

    let isBreakout = false;
    let isWaveContinuation = false;

    // Early Wave Breakout Condition:
    // - Current 1m spike >= 4.5% (or configured threshold)
    // - Volatility surge ratio >= 2.2x (was quiet before, suddenly exploded)
    // - Volume multiplier >= 3.0x with taker buy ratio >= 55%
    // - Minimum 1m volume >= 25,000 USDT to avoid micro-cap illiquid noise
    if (
      current1mSpikePct >= (this.spikeThresholdPct - 0.5) &&
      volatilitySurgeRatio >= 2.2 &&
      volumeMultiplier >= 3.0 &&
      takerBuyRatio >= 0.55 &&
      currentVol >= 25000
    ) {
      if (!state || (now - state.lastAlertTime > 5 * 60 * 1000)) {
        isBreakout = true;
      } else if (
        state &&
        (now - state.lastAlertTime >= 50 * 1000) && // Allow new alert every ~1 minute if wave keeps expanding
        currentPrice > state.lastAlertPrice * 1.025 // Price gained another 2.5%+ since last alert
      ) {
        isWaveContinuation = true;
      }
    }

    if (isBreakout || isWaveContinuation) {
      const alertType: 'EARLY_WAVE_BREAKOUT' | 'CONTINUOUS_PUMP' = isBreakout
        ? 'EARLY_WAVE_BREAKOUT'
        : 'CONTINUOUS_PUMP';

      this.alertStates.set(symbol, {
        lastAlertTime: now,
        lastAlertPrice: currentPrice,
        alertCount: (state?.alertCount || 0) + 1,
      });

      const payload: SpikeAlertPayload = {
        symbol,
        type: alertType,
        priceChangePct: current1mSpikePct,
        openPrice,
        highPrice,
        currentPrice,
        volume1m: Math.round(currentVol),
        avgVolume: Math.round(avgVolume),
        volumeMultiplier,
        volatilitySurgeRatio,
        change1hPct,
        takerBuyRatio,
      };

      this.logger.warn(
        `🌊 [EARLY WAVE DETECTED] ${symbol} -> Type: ${alertType}, 1m Jump: +${current1mSpikePct.toFixed(2)}%, Volatility Surge: ${volatilitySurgeRatio.toFixed(1)}x, 1h Change: ${change1hPct?.toFixed(2)}%`,
      );

      await this.telegramService.sendSpikeAlert(payload);
    }
  }
}

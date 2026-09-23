import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { BinanceService } from '../binance/binance.service.js';
import { TelegramService, SpikeAlertPayload } from '../telegram/telegram.service.js';

interface AlertState {
  lastAlertTime: number;
  lastAlertPrice: number;
  lastDirection: 'PUMP' | 'DUMP';
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
      this.configService.get<string>('SPIKE_THRESHOLD_PCT', '4.5'),
    );
    this.volumeMultiplierThreshold = parseFloat(
      this.configService.get<string>('VOLUME_SPIKE_MULTIPLIER', '3.0'),
    );
  }

  async onApplicationBootstrap() {
    this.logger.log('Initializing Binance Predictive Dual-Direction Scanner...');
    await this.refreshSymbols();
    this.logger.log(`Scanner active for PUMP/DUMP Wave Forecast (Threshold >= ${this.spikeThresholdPct}%, Vol >= ${this.volumeMultiplierThreshold}x)`);
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
      this.logger.error(`Error during scan tick: ${err.message}`);
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
    const lowPrice = currentCandle.low;
    const currentPrice = currentCandle.close;

    if (openPrice <= 0) return;

    // 1. Calculate 1m Change %
    const maxPumpPct = ((highPrice - openPrice) / openPrice) * 100;
    const closePumpPct = ((currentPrice - openPrice) / openPrice) * 100;

    const maxDumpPct = ((openPrice - lowPrice) / openPrice) * 100;
    const closeDumpPct = ((openPrice - currentPrice) / openPrice) * 100;

    const pumpSpikePct = Math.max(maxPumpPct, closePumpPct);
    const dumpSpikePct = Math.max(maxDumpPct, closeDumpPct);

    // Determine candidate direction
    const isPumpCandidate = pumpSpikePct >= dumpSpikePct;
    const direction: 'PUMP' | 'DUMP' = isPumpCandidate ? 'PUMP' : 'DUMP';
    const activeSpikePct = isPumpCandidate ? pumpSpikePct : dumpSpikePct;

    // 2. Baseline Volatility (30 candles)
    const prev30Klines = klines.slice(-31, -1);
    const avgCandleRangePct =
      prev30Klines.reduce((sum, k) => {
        const range = k.open > 0 ? ((k.high - k.low) / k.open) * 100 : 0;
        return sum + range;
      }, 0) / prev30Klines.length;

    const volatilitySurgeRatio = avgCandleRangePct > 0 ? activeSpikePct / avgCandleRangePct : 1;

    // 3. Volume & Taker Pressure
    const avgVolume =
      prev30Klines.reduce((acc, k) => acc + k.quoteVolume, 0) / prev30Klines.length;
    const currentVol = currentCandle.quoteVolume;
    const volumeMultiplier = avgVolume > 0 ? currentVol / avgVolume : 0;
    const takerBuyRatio =
      currentVol > 0 ? currentCandle.takerBuyQuoteVolume / currentVol : 0;
    const takerSellRatio = 1 - takerBuyRatio;

    // 4. 1h Trend Context
    const kline1hAgo = klines[0];
    const change1hPct =
      kline1hAgo && kline1hAgo.close > 0
        ? ((currentPrice - kline1hAgo.close) / kline1hAgo.close) * 100
        : undefined;

    // 5. Calculate Forecast Score (0 - 100)
    const takerDominance = isPumpCandidate ? takerBuyRatio : takerSellRatio;

    let score = 0;

    // Volume Surge component (up to 35 pts)
    score += Math.min(35, (volumeMultiplier / 5.0) * 35);

    // Volatility Expansion component (up to 30 pts)
    score += Math.min(30, (volatilitySurgeRatio / 4.0) * 30);

    // Taker Pressure component (up to 25 pts)
    score += Math.min(25, (takerDominance / 0.8) * 25);

    // 1h Trend Confluence (up to 10 pts)
    if (change1hPct !== undefined) {
      if (isPumpCandidate && change1hPct > 0) {
        score += Math.min(10, (change1hPct / 10.0) * 10);
      } else if (!isPumpCandidate && change1hPct < 0) {
        score += Math.min(10, (Math.abs(change1hPct) / 10.0) * 10);
      }
    }

    const forecastScore = Math.min(100, Math.round(score));

    let forecastLabel = '⚡ PHÁ VỠ TIỀM NĂNG';
    if (forecastScore >= 85) {
      forecastLabel = isPumpCandidate
        ? '🔥 ĐẦU SÓNG TĂNG CỰC MẠNH (ENTRY CAO)'
        : '🔥 ĐẦU SÓNG XẢ/GIẢM CỰC MẠNH (ENTRY CAO)';
    } else if (forecastScore < 70) {
      forecastLabel = '⚠️ BIẾN ĐỘNG NẮN GIẬT';
    }

    // 6. Signal Conditions
    const now = Date.now();
    const state = this.alertStates.get(symbol);

    let isTriggered = false;
    let alertType: 'EARLY_WAVE_BREAKOUT' | 'CONTINUOUS_WAVE' = 'EARLY_WAVE_BREAKOUT';

    // Must satisfy:
    // - Spike >= threshold (4.5%)
    // - Volatility surge ratio >= 2.0x (quiet token exploding)
    // - Volume multiplier >= 2.5x with taker dominance >= 52%
    // - Min volume >= 25,000 USDT
    if (
      activeSpikePct >= this.spikeThresholdPct &&
      volatilitySurgeRatio >= 2.0 &&
      volumeMultiplier >= 2.5 &&
      takerDominance >= 0.52 &&
      currentVol >= 25000
    ) {
      if (!state || (now - state.lastAlertTime > 5 * 60 * 1000)) {
        isTriggered = true;
        alertType = 'EARLY_WAVE_BREAKOUT';
      } else if (
        state &&
        (now - state.lastAlertTime >= 45 * 1000) &&
        ((isPumpCandidate && currentPrice > state.lastAlertPrice * 1.02) ||
          (!isPumpCandidate && currentPrice < state.lastAlertPrice * 0.98))
      ) {
        isTriggered = true;
        alertType = 'CONTINUOUS_WAVE';
      }
    }

    if (isTriggered) {
      this.alertStates.set(symbol, {
        lastAlertTime: now,
        lastAlertPrice: currentPrice,
        lastDirection: direction,
        alertCount: (state?.alertCount || 0) + 1,
      });

      const payload: SpikeAlertPayload = {
        symbol,
        direction,
        type: alertType,
        priceChangePct: activeSpikePct,
        openPrice,
        highPrice,
        lowPrice,
        currentPrice,
        volume1m: Math.round(currentVol),
        avgVolume: Math.round(avgVolume),
        volumeMultiplier,
        volatilitySurgeRatio,
        forecastScore,
        forecastLabel,
        change1hPct,
        takerBuyRatio,
      };

      this.logger.warn(
        `🚨 [ALERT] ${symbol} (${direction}) -> Score: ${forecastScore}/100, Jump: ${direction === 'PUMP' ? '+' : '-'}${activeSpikePct.toFixed(2)}%, Vol Surge: ${volatilitySurgeRatio.toFixed(1)}x`,
      );

      await this.telegramService.sendSpikeAlert(payload);
    }
  }
}

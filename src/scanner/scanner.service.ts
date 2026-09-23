import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { BinanceService } from '../binance/binance.service.js';
import { TelegramService, CashflowAlertPayload } from '../telegram/telegram.service.js';

interface ActivePositionTrack {
  symbol: string;
  entryPrice: number;
  entryTime: number;
  highestPrice: number;
  lowestPrice: number;
  direction: 'BUY' | 'SELL';
  alertCount: number;
  lastExitAlertTime?: number;
}

@Injectable()
export class ScannerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScannerService.name);

  private symbols: string[] = [];
  private activePositions: Map<string, ActivePositionTrack> = new Map();
  private entryCooldowns: Map<string, number> = new Map();

  private isScanning = false;

  constructor(
    private readonly binanceService: BinanceService,
    private readonly telegramService: TelegramService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log('Initializing Binance Pre-Breakout & Cashflow Entry/Exit Scanner...');
    await this.refreshSymbols();
    this.logger.log('Scanner active for Early Wave Entries (+1.8%) & Cashflow Exit Alerts');
  }

  @Cron('0 */30 * * * *')
  async refreshSymbols() {
    this.symbols = await this.binanceService.getUsdtFuturesSymbols();
  }

  @Cron('*/10 * * * * *') // Scan every 10 seconds for real-time responsiveness
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
      const batchSize = 25;
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

    const now = Date.now();
    const prev30Klines = klines.slice(-31, -1);

    // 1. Calculate 1m Change %
    const maxPumpPct = ((highPrice - openPrice) / openPrice) * 100;
    const closePumpPct = ((currentPrice - openPrice) / openPrice) * 100;
    const maxDumpPct = ((openPrice - lowPrice) / openPrice) * 100;
    const closeDumpPct = ((openPrice - currentPrice) / openPrice) * 100;

    const pumpSpikePct = Math.max(maxPumpPct, closePumpPct);
    const dumpSpikePct = Math.max(maxDumpPct, closeDumpPct);

    // 2. Baseline Volatility (30 candles)
    const avgCandleRangePct =
      prev30Klines.reduce((sum, k) => {
        const range = k.open > 0 ? ((k.high - k.low) / k.open) * 100 : 0;
        return sum + range;
      }, 0) / prev30Klines.length;

    // 3. Volume Surge & Taker Order Imbalance
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

    // --- CHECK EXIT / TAKE PROFIT FOR ACTIVE POSITIONS FIRST ---
    const trackedPos = this.activePositions.get(symbol);
    if (trackedPos) {
      if (currentPrice > trackedPos.highestPrice) trackedPos.highestPrice = currentPrice;
      if (currentPrice < trackedPos.lowestPrice) trackedPos.lowestPrice = currentPrice;

      const timeInPos = now - trackedPos.entryTime;
      const lastExitAlert = trackedPos.lastExitAlertTime || 0;

      // Exit Condition for LONG (BUY):
      // Lực bán chốt lời gia tăng (Taker Sell >= 62%) hoặc Giá quay đầu giảm >= 1.8% từ đỉnh
      if (trackedPos.direction === 'BUY' && (now - lastExitAlert > 2 * 60 * 1000)) {
        const dropFromPeakPct = ((trackedPos.highestPrice - currentPrice) / trackedPos.highestPrice) * 100;
        const totalProfitPct = ((currentPrice - trackedPos.entryPrice) / trackedPos.entryPrice) * 100;

        let shouldExit = false;
        let exitReason = '';

        if (takerSellRatio >= 0.62 && volumeMultiplier >= 2.0) {
          shouldExit = true;
          exitReason = `Dòng tiền bán xả chốt lời đột biến (Lực bán Taker Sell chiếm ${(takerSellRatio * 100).toFixed(1)}%)!`;
        } else if (dropFromPeakPct >= 1.8 && totalProfitPct > 1.0) {
          shouldExit = true;
          exitReason = `Giá vừa quay đầu giảm -${dropFromPeakPct.toFixed(2)}% từ đỉnh ($${trackedPos.highestPrice})!`;
        } else if (timeInPos > 15 * 60 * 1000 && totalProfitPct < 0.5) {
          shouldExit = true;
          exitReason = `Sóng tăng suy yếu, lực mua đứng yên sau 15 phút!`;
        }

        if (shouldExit) {
          trackedPos.lastExitAlertTime = now;
          const payload: CashflowAlertPayload = {
            symbol,
            action: 'EXIT_TAKE_PROFIT',
            priceChangePct: totalProfitPct,
            openPrice,
            highPrice,
            lowPrice,
            currentPrice,
            volume1m: Math.round(currentVol),
            avgVolume: Math.round(avgVolume),
            volumeMultiplier,
            volatilitySurgeRatio: avgCandleRangePct > 0 ? pumpSpikePct / avgCandleRangePct : 1,
            forecastScore: 90,
            forecastLabel: `💰 CẢNH BÁO CHỐT LỜI (${totalProfitPct >= 0 ? '+' : ''}${totalProfitPct.toFixed(2)}%)`,
            change1hPct,
            takerBuyRatio,
            reasonText: exitReason,
          };

          this.logger.warn(`💰 [EXIT ALERT] ${symbol} -> Profit: ${totalProfitPct.toFixed(2)}%, Reason: ${exitReason}`);
          await this.telegramService.sendCashflowAlert(payload);
          return;
        }
      }
    }

    // --- EARLY PRE-BREAKOUT ENTRY SCANNING ---
    const lastEntryTime = this.entryCooldowns.get(symbol) || 0;
    if (now - lastEntryTime < 4 * 60 * 1000) return; // 4-minute entry cooldown

    const isEarlyPump = pumpSpikePct >= 1.8 && takerBuyRatio >= 0.62;
    const isEarlyDump = dumpSpikePct >= 1.8 && takerSellRatio >= 0.62;

    if (!isEarlyPump && !isEarlyDump) return;

    const direction: 'BUY' | 'SELL' = isEarlyPump ? 'BUY' : 'SELL';
    const activeSpikePct = isEarlyPump ? pumpSpikePct : dumpSpikePct;
    const takerDominance = isEarlyPump ? takerBuyRatio : takerSellRatio;
    const volatilitySurgeRatio = avgCandleRangePct > 0 ? activeSpikePct / avgCandleRangePct : 1;

    // Minimum filters for Early Entry:
    // - Early price momentum >= 1.8%
    // - Volume acceleration >= 2.5x
    // - Taker dominance >= 62%
    // - Volatility surge ratio >= 1.8x
    if (
      activeSpikePct >= 1.8 &&
      volumeMultiplier >= 2.5 &&
      takerDominance >= 0.62 &&
      volatilitySurgeRatio >= 1.8 &&
      currentVol >= 20000
    ) {
      // Calculate High Precision Forecast Score (0-100)
      let score = 0;
      score += Math.min(40, (volumeMultiplier / 4.0) * 40);       // Cashflow volume velocity
      score += Math.min(30, (takerDominance / 0.85) * 30);        // Taker order aggression
      score += Math.min(20, (volatilitySurgeRatio / 3.0) * 20);   // Volatility explosion
      if (change1hPct !== undefined) {
        if (direction === 'BUY' && change1hPct > 0) score += Math.min(10, (change1hPct / 8.0) * 10);
        if (direction === 'SELL' && change1hPct < 0) score += Math.min(10, (Math.abs(change1hPct) / 8.0) * 10);
      }

      const forecastScore = Math.min(100, Math.round(score));

      let forecastLabel = '⚡ BẮT ĐẦU NGỌN SÓNG (ENTRY MỚI)';
      if (forecastScore >= 85) {
        forecastLabel = direction === 'BUY'
          ? '🔥 DÒNG TIỀN VÀO CỰC MẠNH - ENTRY ĐẦU SÓNG TĂNG'
          : '🔥 DÒNG TIỀN BÁN XẢ CỰC MẠNH - ENTRY ĐẦU SÓNG GIẢM';
      }

      // Calculate Target TP & SL
      const tp1Multiplier = direction === 'BUY' ? 1.03 : 0.97;
      const tp2Multiplier = direction === 'BUY' ? 1.06 : 0.94;
      const slMultiplier = direction === 'BUY' ? 0.985 : 1.015;

      const suggestedTp1 = currentPrice * tp1Multiplier;
      const suggestedTp2 = currentPrice * tp2Multiplier;
      const suggestedSl = currentPrice * slMultiplier;

      this.entryCooldowns.set(symbol, now);
      this.activePositions.set(symbol, {
        symbol,
        entryPrice: currentPrice,
        entryTime: now,
        highestPrice: currentPrice,
        lowestPrice: currentPrice,
        direction,
        alertCount: 1,
      });

      const payload: CashflowAlertPayload = {
        symbol,
        action: direction === 'BUY' ? 'ENTRY_BUY' : 'ENTRY_SELL',
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
        suggestedTp1,
        suggestedTp2,
        suggestedSl,
        change1hPct,
        takerBuyRatio,
      };

      this.logger.warn(
        `💵 [ENTRY SIGNAL] ${symbol} (${direction}) -> Score: ${forecastScore}/100, Early Jump: +${activeSpikePct.toFixed(2)}%, Vol: ${volumeMultiplier.toFixed(1)}x`,
      );

      await this.telegramService.sendCashflowAlert(payload);
    }
  }
}

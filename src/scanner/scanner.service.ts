import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { BinanceService } from '../binance/binance.service.js';
import { TelegramService, OrderflowAlertPayload } from '../telegram/telegram.service.js';

interface ActivePositionTrack {
  symbol: string;
  entryPrice: number;
  entryTime: number;
  highestPrice: number;
  lowestPrice: number;
  direction: 'BUY' | 'SELL';
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
    this.logger.log('Khoi tao Scanner Bắt Đầu Dòng Tiền Vừa VÀO (Net Orderflow Acceleration)...');
    await this.refreshSymbols();
    this.logger.log('Scanner đang quét Dòng Tiền VƯA BƠM VÀO 100% Tiếng Việt...');
  }

  @Cron('0 */30 * * * *')
  async refreshSymbols() {
    this.symbols = await this.binanceService.getUsdtFuturesSymbols();
  }

  @Cron('*/10 * * * * *') // Quét mỗi 10 giây
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
      this.logger.error(`Lỗi khi quét thị trường: ${err.message}`);
    } finally {
      this.isScanning = false;
    }
  }

  private async scanSymbol(symbol: string) {
    const klines = await this.binanceService.getKlines(symbol, '1m', 60);
    if (!klines || klines.length < 30) return;

    const currentCandle = klines[klines.length - 1];
    const prevCandle = klines[klines.length - 2];

    const openPrice = currentCandle.open;
    const highPrice = currentCandle.high;
    const lowPrice = currentCandle.low;
    const currentPrice = currentCandle.close;

    if (openPrice <= 0) return;

    const now = Date.now();
    const prev30Klines = klines.slice(-31, -1);

    // 1. Biên độ nến 1m
    const maxPumpPct = ((highPrice - openPrice) / openPrice) * 100;
    const closePumpPct = ((currentPrice - openPrice) / openPrice) * 100;
    const maxDumpPct = ((openPrice - lowPrice) / openPrice) * 100;
    const closeDumpPct = ((openPrice - currentPrice) / openPrice) * 100;

    const pumpSpikePct = Math.max(maxPumpPct, closePumpPct);
    const dumpSpikePct = Math.max(maxDumpPct, closeDumpPct);
    const net1mChangePct = ((currentPrice - openPrice) / openPrice) * 100;

    // 2. Biên độ nến nền tĩnh (30 nến trước)
    const avgCandleRangePct =
      prev30Klines.reduce((sum, k) => {
        const range = k.open > 0 ? ((k.high - k.low) / k.open) * 100 : 0;
        return sum + range;
      }, 0) / prev30Klines.length;

    // 3. Phân tích Dòng Tiền Taker Mua vs Bán Chi Tiết
    const avgVolume =
      prev30Klines.reduce((acc, k) => acc + k.quoteVolume, 0) / prev30Klines.length;
    const avgTakerBuyVol =
      prev30Klines.reduce((acc, k) => acc + k.takerBuyQuoteVolume, 0) / prev30Klines.length;

    const currentVol = currentCandle.quoteVolume;
    const volumeMultiplier = avgVolume > 0 ? currentVol / avgVolume : 0;

    const takerBuyVol = currentCandle.takerBuyQuoteVolume;
    const takerSellVol = Math.max(0, currentVol - takerBuyVol);
    const netCashflow = takerBuyVol - takerSellVol; // Dòng tiền ròng (USDT)
    const takerBuyPct = currentVol > 0 ? (takerBuyVol / currentVol) * 100 : 50;

    // Tăng tốc dòng tiền mua: Nến hiện tại volume Mua Taker gấp >= 2.5x trung bình VÀ nến trước đó còn phẳng lặng
    const takerBuyAcceleration = avgTakerBuyVol > 0 ? takerBuyVol / avgTakerBuyVol : 0;
    const wasQuietBefore = prevCandle ? (prevCandle.quoteVolume <= avgVolume * 1.8) : true;

    // 4. Xu hướng 1h
    const kline1hAgo = klines[0];
    const change1hPct =
      kline1hAgo && kline1hAgo.close > 0
        ? ((currentPrice - kline1hAgo.close) / kline1hAgo.close) * 100
        : undefined;

    // --- 5. KIỂM TRA CHỐT LỜI/EXIT CHO VỊ THẾ ĐANG THEO DÕI ---
    const trackedPos = this.activePositions.get(symbol);
    if (trackedPos) {
      if (currentPrice > trackedPos.highestPrice) trackedPos.highestPrice = currentPrice;
      if (currentPrice < trackedPos.lowestPrice) trackedPos.lowestPrice = currentPrice;

      const lastExitAlert = trackedPos.lastExitAlertTime || 0;

      if (trackedPos.direction === 'BUY' && (now - lastExitAlert > 2 * 60 * 1000)) {
        const dropFromPeakPct = ((trackedPos.highestPrice - currentPrice) / trackedPos.highestPrice) * 100;
        const totalProfitPct = ((currentPrice - trackedPos.entryPrice) / trackedPos.entryPrice) * 100;

        let shouldExit = false;
        let exitReason = '';

        if (takerBuyPct < 38 && volumeMultiplier >= 1.8) {
          shouldExit = true;
          exitReason = `Dòng tiền ròng đổi chiều rút ra (Lực Bán Taker xả chiếm ${(100 - takerBuyPct).toFixed(1)}%)!`;
        } else if (dropFromPeakPct >= 1.6 && totalProfitPct > 0.8) {
          shouldExit = true;
          exitReason = `Giá đã quay đầu rút chân giảm -${dropFromPeakPct.toFixed(2)}% từ đỉnh ($${trackedPos.highestPrice})!`;
        }

        if (shouldExit) {
          trackedPos.lastExitAlertTime = now;
          const payload: OrderflowAlertPayload = {
            symbol,
            patternType: 'EXIT_TAKE_PROFIT',
            priceChangePct: totalProfitPct,
            openPrice,
            highPrice,
            lowPrice,
            currentPrice,
            volume1m: currentVol,
            avgVolume,
            volumeMultiplier,
            takerBuyVol,
            takerSellVol,
            netCashflow,
            takerBuyPct,
            volatilitySurgeRatio: avgCandleRangePct > 0 ? pumpSpikePct / avgCandleRangePct : 1,
            forecastScore: 92,
            forecastLabel: `💰 DÒNG TIỀN MUA SUY YẾU - KHUYẾN NGHỊ CHỐT LỜI (${totalProfitPct >= 0 ? '+' : ''}${totalProfitPct.toFixed(2)}%)`,
            change1hPct,
            reasonText: exitReason,
          };

          this.logger.warn(`💰 [CẢNH BÁO CHỐT LỜI] ${symbol} -> Profit: ${totalProfitPct.toFixed(2)}%, Reason: ${exitReason}`);
          await this.telegramService.sendOrderflowAlert(payload);
          return;
        }
      }
    }

    // --- 6. PHÂN TÍCH MÔ HÌNH DÒNG TIỀN VỪA BẮT ĐẦU ĐỔ VÀO (INITIAL CASHFLOW INFLOW) ---
    const lastEntryTime = this.entryCooldowns.get(symbol) || 0;
    if (now - lastEntryTime < 5 * 60 * 1000) return; // Cooldown 5 phut

    let patternType:
      | 'NET_INFLOW_PUMP'
      | 'ACCUMULATION_DIP'
      | 'DISTRIBUTION_TRAP'
      | 'NET_OUTFLOW_DUMP'
      | null = null;

    let isTriggered = false;

    // LỘC CHẶT CHẼ: CHỈ THÔNG BÁO KHI DÒNG TIỀN VỪA BƠM ĐỘT BIẾN (Taker Buy Acceleration >= 2.5x & Nền trước phẳng)
    // Pattern 1: NET_INFLOW_PUMP (Dòng tiền mua VỪA ĐỔ VÀO + Lực Mua Taker >= 64% + Net Flow > 20k USDT)
    if (
      pumpSpikePct >= 1.5 &&
      takerBuyPct >= 64 &&
      netCashflow > 20000 &&
      takerBuyAcceleration >= 2.5 &&
      wasQuietBefore
    ) {
      patternType = 'NET_INFLOW_PUMP';
      isTriggered = true;
    }
    // Pattern 2: ACCUMULATION_DIP (Giá đang tích lũy/đi ngang nhẹ nhưng Dòng tiền Mua VỪA BƠM MẠNH >= 68%)
    else if (
      net1mChangePct >= -1.0 &&
      net1mChangePct <= 0.8 &&
      takerBuyPct >= 68 &&
      netCashflow >= 30000 &&
      takerBuyAcceleration >= 2.5 &&
      wasQuietBefore
    ) {
      patternType = 'ACCUMULATION_DIP';
      isTriggered = true;
    }
    // Pattern 3: DISTRIBUTION_TRAP (Giá tăng nhẹ nhưng Dòng tiền BÁN VỪA XẢ THÁO ĐỘT BIẾN)
    else if (
      pumpSpikePct >= 1.5 &&
      takerBuyPct <= 35 &&
      netCashflow < -20000 &&
      volumeMultiplier >= 2.5 &&
      wasQuietBefore
    ) {
      patternType = 'DISTRIBUTION_TRAP';
      isTriggered = true;
    }
    // Pattern 4: NET_OUTFLOW_DUMP (Dòng tiền bán tháo VỪA BẮT ĐẦU XẢ CỰC MẠNH)
    else if (
      dumpSpikePct >= 1.5 &&
      takerBuyPct <= 35 &&
      netCashflow < -20000 &&
      volumeMultiplier >= 2.5 &&
      wasQuietBefore
    ) {
      patternType = 'NET_OUTFLOW_DUMP';
      isTriggered = true;
    }

    if (isTriggered && patternType) {
      // Tính toán Điểm Tin Cậy Dự Đoán (0 - 100 Điểm)
      let score = 0;
      score += Math.min(40, (takerBuyAcceleration / 4.0) * 40);                       // Tốc độ bơm tiền mua
      score += Math.min(30, (Math.abs(takerBuyPct - 50) / 35.0) * 30);              // Tỷ lệ chênh lệch Mua/Bán
      score += Math.min(20, (Math.abs(netCashflow) / 100000) * 20);                  // Giá trị Dòng tiền ròng
      if (change1hPct !== undefined) {
        if ((patternType === 'NET_INFLOW_PUMP' || patternType === 'ACCUMULATION_DIP') && change1hPct > 0) {
          score += Math.min(10, (change1hPct / 8.0) * 10);
        }
        if ((patternType === 'DISTRIBUTION_TRAP' || patternType === 'NET_OUTFLOW_DUMP') && change1hPct < 0) {
          score += Math.min(10, (Math.abs(change1hPct) / 8.0) * 10);
        }
      }

      const forecastScore = Math.min(100, Math.round(score));

      let forecastLabel = '⚡ CƠ HỘI BẮT ĐẦU VÀO SÓNG';
      if (patternType === 'NET_INFLOW_PUMP') {
        forecastLabel = forecastScore >= 85
          ? '🔥 DÒNG TIỀN VỪA BƠM MẠNH - ĐẦU SÓNG TĂNG'
          : '🟢 DÒNG TIỀN VỪA VÀO (ENTRY MUA)';
      } else if (patternType === 'ACCUMULATION_DIP') {
        forecastLabel = '💎 TÍCH LŨY ÂM THẦM (BẮT ĐÁY ĐẦU SÓNG)';
      } else if (patternType === 'DISTRIBUTION_TRAP') {
        forecastLabel = '🚨 BẪY TĂNG GIẢ (CÁ MẠP ĐANG XẢ HÀNG)';
      } else if (patternType === 'NET_OUTFLOW_DUMP') {
        forecastLabel = forecastScore >= 85
          ? '🔥 DÒNG TIỀN VỪA XẢ THÁO - ĐẦU SÓNG GIẢM'
          : '🔴 DÒNG TIỀN VỪA RÚT (ENTRY SHORT)';
      }

      const isLong = patternType === 'NET_INFLOW_PUMP' || patternType === 'ACCUMULATION_DIP';

      const suggestedTp1 = isLong ? currentPrice * 1.03 : currentPrice * 0.97;
      const suggestedTp2 = isLong ? currentPrice * 1.06 : currentPrice * 0.94;
      const suggestedSl = isLong ? currentPrice * 0.985 : currentPrice * 1.015;

      this.entryCooldowns.set(symbol, now);
      this.activePositions.set(symbol, {
        symbol,
        entryPrice: currentPrice,
        entryTime: now,
        highestPrice: currentPrice,
        lowestPrice: currentPrice,
        direction: isLong ? 'BUY' : 'SELL',
      });

      const payload: OrderflowAlertPayload = {
        symbol,
        patternType,
        priceChangePct: net1mChangePct,
        openPrice,
        highPrice,
        lowPrice,
        currentPrice,
        volume1m: currentVol,
        avgVolume,
        volumeMultiplier,
        takerBuyVol,
        takerSellVol,
        netCashflow,
        takerBuyPct,
        volatilitySurgeRatio: avgCandleRangePct > 0 ? Math.abs(net1mChangePct) / avgCandleRangePct : 1,
        forecastScore,
        forecastLabel,
        suggestedTp1,
        suggestedTp2,
        suggestedSl,
        change1hPct,
      };

      this.logger.warn(
        `🚨 [DÒNG TIỀN VỪA VÀO] ${symbol} (${patternType}) -> NetCashflow: ${Math.round(netCashflow)} USDT, Acceleration: ${takerBuyAcceleration.toFixed(1)}x`,
      );

      await this.telegramService.sendOrderflowAlert(payload);
    }
  }
}

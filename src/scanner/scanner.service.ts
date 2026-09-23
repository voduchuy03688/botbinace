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
    this.logger.log('Khoi tao Scanner Chon Loc Ngay Dau Chan Song (Strict Early Wave Filter)...');
    await this.refreshSymbols();
    this.logger.log('Scanner dang quet DONG TIEN VOAP BAN DAU - CHONG DU DINH...');
  }

  @Cron('0 */30 * * * *')
  async refreshSymbols() {
    this.symbols = await this.binanceService.getUsdtFuturesSymbols();
  }

  @Cron('*/10 * * * * *') // Quet moi 10 giay
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
      this.logger.error(`Loi khi quet thi truong: ${err.message}`);
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
    const prev20Klines = klines.slice(-21, -1);
    const prev60Klines = klines;

    // 1. Bien do nen nen tinh (20 nen truoc)
    const avgCandleRangePct =
      prev20Klines.reduce((sum, k) => {
        const range = k.open > 0 ? ((k.high - k.low) / k.open) * 100 : 0;
        return sum + range;
      }, 0) / prev20Klines.length;

    // Kiem tra nen truoc do co phang lang (Dau Chan Song)
    const isQuietBase = avgCandleRangePct <= 1.25;

    // 2. Bien do gia nen 1m hien tai
    const maxPumpPct = ((highPrice - openPrice) / openPrice) * 100;
    const closePumpPct = ((currentPrice - openPrice) / openPrice) * 100;
    const maxDumpPct = ((openPrice - lowPrice) / openPrice) * 100;
    const closeDumpPct = ((openPrice - currentPrice) / openPrice) * 100;

    const pumpSpikePct = Math.max(maxPumpPct, closePumpPct);
    const dumpSpikePct = Math.max(maxDumpPct, closeDumpPct);
    const net1mChangePct = ((currentPrice - openPrice) / openPrice) * 100;

    // 3. Phân tích Dòng Tiền Taker Mua vs Bán Chi Tiết
    const avgVolume =
      prev20Klines.reduce((acc, k) => acc + k.quoteVolume, 0) / prev20Klines.length;
    const avgTakerBuyVol =
      prev20Klines.reduce((acc, k) => acc + k.takerBuyQuoteVolume, 0) / prev20Klines.length;

    const currentVol = currentCandle.quoteVolume;
    const volumeMultiplier = avgVolume > 0 ? currentVol / avgVolume : 0;

    const takerBuyVol = currentCandle.takerBuyQuoteVolume;
    const takerSellVol = Math.max(0, currentVol - takerBuyVol);
    const netCashflow = takerBuyVol - takerSellVol; // Dòng tiền ròng (USDT)
    const takerBuyPct = currentVol > 0 ? (takerBuyVol / currentVol) * 100 : 50;

    // Tăng tốc dòng tiền mua
    const takerBuyAcceleration = avgTakerBuyVol > 0 ? takerBuyVol / avgTakerBuyVol : 0;
    const wasQuietVolumeBefore = prevCandle ? (prevCandle.quoteVolume <= avgVolume * 1.8) : true;

    // 4. Xu hướng 1h
    const kline1hAgo = klines[0];
    const change1hPct =
      kline1hAgo && kline1hAgo.close > 0
        ? ((currentPrice - kline1hAgo.close) / kline1hAgo.close) * 100
        : undefined;

    // BLOCKED LATE WAVE: Nếu coin đã tăng > 12% trong 1h qua -> ĐÃ CHẠY GIỮA/CUỐI SÓNG -> BLOCK ENTRY BẮT ĐỦ ĐỈNH!
    const isLateWavePump = change1hPct !== undefined && change1hPct >= 12.0;

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
            wavePhase: 'EARLY_BASE',
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

          this.logger.warn(`💰 [CANH BAO CHOT LOI] ${symbol} -> Profit: ${totalProfitPct.toFixed(2)}%, Reason: ${exitReason}`);
          await this.telegramService.sendOrderflowAlert(payload);
          return;
        }
      }
    }

    // --- 6. PHÂN TÍCH MÔ HÌNH DÒNG TIỀN CHUẨN ĐẦU CHÂN SÓNG (EARLY BASE BREAKOUT) ---
    const lastEntryTime = this.entryCooldowns.get(symbol) || 0;
    if (now - lastEntryTime < 5 * 60 * 1000) return; // Cooldown 5 phut

    let patternType:
      | 'NET_INFLOW_PUMP'
      | 'ACCUMULATION_DIP'
      | 'DISTRIBUTION_TRAP'
      | 'NET_OUTFLOW_DUMP'
      | null = null;

    let isTriggered = false;

    // LOẠI BỎ SÓNG CUỐI / ĐU ĐỈNH: Không phát tín hiệu Entry Mua nếu coin đã tăng > 12% ở giữa/cuối sóng
    if (!isLateWavePump) {
      // Pattern 1: NET_INFLOW_PUMP (Dòng tiền mua VỪA NỔ ĐỘT BIẾN TỪ ĐẦU CHÂN SÓNG)
      if (
        pumpSpikePct >= 1.5 &&
        takerBuyPct >= 65 &&
        netCashflow > 25000 &&
        takerBuyAcceleration >= 2.8 &&
        wasQuietVolumeBefore &&
        isQuietBase
      ) {
        patternType = 'NET_INFLOW_PUMP';
        isTriggered = true;
      }
      // Pattern 2: ACCUMULATION_DIP (Nền phẳng đi ngang âm thầm Gom Mua)
      else if (
        net1mChangePct >= -0.8 &&
        net1mChangePct <= 0.8 &&
        takerBuyPct >= 70 &&
        netCashflow >= 30000 &&
        takerBuyAcceleration >= 2.5 &&
        isQuietBase
      ) {
        patternType = 'ACCUMULATION_DIP';
        isTriggered = true;
      }
    }

    // Pattern 3: DISTRIBUTION_TRAP (Giá đẩy nhích nhẹ nhưng Dòng tiền đang XẢ tháo)
    if (!isTriggered && pumpSpikePct >= 1.5 && takerBuyPct <= 35 && netCashflow < -25000 && volumeMultiplier >= 2.5) {
      patternType = 'DISTRIBUTION_TRAP';
      isTriggered = true;
    }
    // Pattern 4: NET_OUTFLOW_DUMP (Dòng tiền bán xả tháo từ chân sóng giảm)
    else if (!isTriggered && dumpSpikePct >= 1.5 && takerBuyPct <= 35 && netCashflow < -25000 && volumeMultiplier >= 2.5) {
      patternType = 'NET_OUTFLOW_DUMP';
      isTriggered = true;
    }

    if (isTriggered && patternType) {
      // Tính toán Điểm Tin Cậy Dự Đoán (0 - 100 Điểm)
      let score = 0;
      score += Math.min(40, (takerBuyAcceleration / 4.0) * 40);                       // Tốc độ dồn volume mua
      score += Math.min(30, (Math.abs(takerBuyPct - 50) / 35.0) * 30);              // Chênh lệch Mua/Bán
      score += Math.min(20, (Math.abs(netCashflow) / 100000) * 20);                  // Dòng tiền ròng USDT
      if (isQuietBase) score += 10;                                                  // Thưởng 10 điểm nền đi ngang chuẩn đầu chân sóng

      const forecastScore = Math.min(100, Math.round(score));

      let forecastLabel = '🌱 ĐẦU CHÂN SÓNG TĂNG MỚI KÍCH HOẠT';
      if (patternType === 'NET_INFLOW_PUMP') {
        forecastLabel = forecastScore >= 85
          ? '🔥 ĐẦU CHÂN SÓNG TĂNG CỰC MẠNH (ENTRY CHUẨN ĐẦU SÓNG)'
          : '🟢 DÒNG TIỀN VỪA VÀO ĐẦU SÓNG (ENTRY MUA)';
      } else if (patternType === 'ACCUMULATION_DIP') {
        forecastLabel = '💎 TÍCH LŨY ÂM THẦM DƯỚI ĐÁY (ENTRY BẮT ĐÁY ĐẦU SÓNG)';
      } else if (patternType === 'DISTRIBUTION_TRAP') {
        forecastLabel = '🚨 BẪY TĂNG GIẢ (CÁ MẠP ĐANG XẢ HÀNG)';
      } else if (patternType === 'NET_OUTFLOW_DUMP') {
        forecastLabel = forecastScore >= 85
          ? '🔥 ĐẦU CHÂN SÓNG GIẢM CỰC MẠNH (ENTRY SHORT CHUẨN)'
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
        wavePhase: isQuietBase ? 'EARLY_BASE' : 'MID_LATE_WAVE',
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
        `🚨 [ĐẦU CHÂN SÓNG] ${symbol} (${patternType}) -> NetCashflow: ${Math.round(netCashflow)} USDT, Score: ${forecastScore}/100`,
      );

      await this.telegramService.sendOrderflowAlert(payload);
    }
  }
}

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { BinanceService } from '../binance/binance.service.js';
import { TelegramService, TieredAlertPayload } from '../telegram/telegram.service.js';

interface ActivePositionTrack {
  symbol: string;
  entryPrice: number;
  entryTime: number;
  highestPrice: number;
  lowestPrice: number;
  lastExitAlertTime?: number;
}

@Injectable()
export class ScannerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScannerService.name);

  private symbols: string[] = [];
  private activePositions: Map<string, ActivePositionTrack> = new Map();
  private symbolCooldowns: Map<string, number> = new Map();
  private lastGlobalAlertTime = 0;

  private isScanning = false;

  constructor(
    private readonly binanceService: BinanceService,
    private readonly telegramService: TelegramService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log('Khoi tao Scanner theo doi HET NGON & CHOT LOI...');
    await this.refreshSymbols();
    this.logger.log('Scanner active: Signal entries + Invalidation tracking');
  }

  @Cron('0 */30 * * * *')
  async refreshSymbols() {
    this.symbols = await this.binanceService.getUsdtFuturesSymbols();
  }

  @Cron('*/6 * * * * *') // Quet moi 6 giay
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

    // 1. Phân tích Dòng Tiền Taker Mua chủ động
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

    const takerBuyAcceleration = avgTakerBuyVol > 0 ? takerBuyVol / avgTakerBuyVol : 0;
    const wasQuietVolumeBefore = prevCandle ? (prevCandle.quoteVolume <= avgVolume * 1.6) : true;

    // 2. Xu hướng 1h
    const kline1hAgo = klines[0];
    const change1hPct =
      kline1hAgo && kline1hAgo.close > 0
        ? ((currentPrice - kline1hAgo.close) / kline1hAgo.close) * 100
        : undefined;

    const avgCandleRangePct =
      prev20Klines.reduce((sum, k) => {
        const range = k.open > 0 ? ((k.high - k.low) / k.open) * 100 : 0;
        return sum + range;
      }, 0) / prev20Klines.length;

    const isQuietBase = avgCandleRangePct <= 1.25;

    // --- 3. KIỂM TRA HẾT NGON CHO CÁC COIN ĐÃ THÔNG BÁO ---
    const trackedPos = this.activePositions.get(symbol);
    if (trackedPos) {
      if (currentPrice > trackedPos.highestPrice) trackedPos.highestPrice = currentPrice;
      if (currentPrice < trackedPos.lowestPrice) trackedPos.lowestPrice = currentPrice;

      const timeInPos = now - trackedPos.entryTime;
      const lastExitAlert = trackedPos.lastExitAlertTime || 0;

      if (now - lastExitAlert > 3 * 60 * 1000) { // Cooldown 3 phut giua cac thong bao het ngon
        const dropFromPeakPct = ((trackedPos.highestPrice - currentPrice) / trackedPos.highestPrice) * 100;
        const totalProfitPct = ((currentPrice - trackedPos.entryPrice) / trackedPos.entryPrice) * 100;

        let isHetNgon = false;
        let hetNgonPattern: 'HET_NGON_STAGNANT' | 'HET_NGON_SELL_OUT' = 'HET_NGON_STAGNANT';
        let reasonText = '';

        // Kịch bản A: Lực bán Taker xả mạnh hoặc Giá quay đầu rơi từ đỉnh >= 1.5%
        if (takerBuyPct <= 38 && volumeMultiplier >= 1.8) {
          isHetNgon = true;
          hetNgonPattern = 'HET_NGON_SELL_OUT';
          reasonText = `Cá mập bắt đầu xả tháo hàng (Lực Bán Taker xả chiếm ${(100 - takerBuyPct).toFixed(1)}%)!`;
        } else if (dropFromPeakPct >= 1.5 && totalProfitPct > 0.5) {
          isHetNgon = true;
          hetNgonPattern = 'HET_NGON_SELL_OUT';
          reasonText = `Giá đã quay đầu giảm -${dropFromPeakPct.toFixed(2)}% từ đỉnh ($${trackedPos.highestPrice}) $\\rightarrow$ Chốt lời ngay!`;
        }
        // Kịch bản B: Đi ngang kiệt sức sau 10-15 phút mà không tăng nổi (+0.3%)
        else if (timeInPos >= 10 * 60 * 1000 && totalProfitPct <= 0.3) {
          isHetNgon = true;
          hetNgonPattern = 'HET_NGON_STAGNANT';
          reasonText = `Tín hiệu bị trơ, giá đi ngang nén đứng yên sau 10 phút $\\rightarrow$ Hủy theo dõi!`;
        }

        if (isHetNgon) {
          trackedPos.lastExitAlertTime = now;
          if (hetNgonPattern === 'HET_NGON_STAGNANT') {
            this.activePositions.delete(symbol); // Xoa khoi danh sach theo doi
          }

          const payload: TieredAlertPayload = {
            symbol,
            patternType: hetNgonPattern,
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
            volatilitySurgeRatio: avgCandleRangePct > 0 ? Math.abs(totalProfitPct) / avgCandleRangePct : 1,
            forecastScore: 90,
            change1hPct,
            reasonText,
          };

          this.logger.warn(`🛑 [HET NGON] ${symbol} (${hetNgonPattern}) -> Reason: ${reasonText}`);
          await this.telegramService.sendTieredAlert(payload);
          return;
        }
      }
    }

    // --- 4. KIỂM TRA TÍN HIỆU ENTRY MỚI (NGON & CỰC KÌ NGON) ---
    const lastSymbolAlert = this.symbolCooldowns.get(symbol) || 0;
    if (now - lastSymbolAlert < 10 * 60 * 1000) return;
    if (now - this.lastGlobalAlertTime < 15 * 1000) return;

    const maxPumpPct = ((highPrice - openPrice) / openPrice) * 100;
    const closePumpPct = ((currentPrice - openPrice) / openPrice) * 100;
    const pumpSpikePct = Math.max(maxPumpPct, closePumpPct);
    const net1mChangePct = ((currentPrice - openPrice) / openPrice) * 100;

    // CHẶN ENTRY NẾU SÓNG ĐÃ CHẠY > 9%: Tránh đu đỉnh
    if (change1hPct !== undefined && change1hPct >= 9.0) return;

    let patternType: 'TICH_LUY' | 'CHAN_SONG' | null = null;
    let qualityTier: 'CUC_KI_NGON' | 'NGON' | null = null;

    // A. BẮT ĐẦU CHÂN SÓNG TĂNG (CHAN_SONG)
    if (pumpSpikePct >= 1.5 && takerBuyPct >= 78 && netCashflow >= 100000 && takerBuyAcceleration >= 4.5 && isQuietBase) {
      patternType = 'CHAN_SONG';
      qualityTier = 'CUC_KI_NGON';
    } else if (pumpSpikePct >= 1.4 && takerBuyPct >= 70 && netCashflow >= 50000 && takerBuyAcceleration >= 3.0 && isQuietBase) {
      patternType = 'CHAN_SONG';
      qualityTier = 'NGON';
    }

    // B. TÍCH LŨY DƯỚI ĐÁY (TICH_LUY)
    if (!patternType) {
      if (net1mChangePct >= -0.8 && net1mChangePct <= 0.6 && takerBuyPct >= 80 && netCashflow >= 80000 && takerBuyAcceleration >= 3.5 && isQuietBase) {
        patternType = 'TICH_LUY';
        qualityTier = 'CUC_KI_NGON';
      } else if (net1mChangePct >= -1.0 && net1mChangePct <= 0.8 && takerBuyPct >= 72 && netCashflow >= 45000 && takerBuyAcceleration >= 2.5 && isQuietBase) {
        patternType = 'TICH_LUY';
        qualityTier = 'NGON';
      }
    }

    if (patternType && qualityTier) {
      let score = 55;
      score += Math.min(25, (takerBuyAcceleration / 5.0) * 25);
      score += Math.min(10, ((takerBuyPct - 50) / 30.0) * 10);
      score += Math.min(10, (netCashflow / 200000) * 10);

      const forecastScore = Math.min(100, Math.round(score));

      if (qualityTier === 'CUC_KI_NGON' && forecastScore < 90) {
        qualityTier = 'NGON';
      }

      if (forecastScore < 82) return; // Loại bỏ tất cả tín hiệu < 82 điểm

      this.symbolCooldowns.set(symbol, now);
      this.lastGlobalAlertTime = now;
      this.activePositions.set(symbol, {
        symbol,
        entryPrice: currentPrice,
        entryTime: now,
        highestPrice: currentPrice,
        lowestPrice: currentPrice,
      });

      const suggestedTp1 = currentPrice * 1.03;
      const suggestedTp2 = currentPrice * 1.06;
      const suggestedSl = currentPrice * 0.985;

      const payload: TieredAlertPayload = {
        symbol,
        patternType,
        qualityTier,
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
        suggestedTp1,
        suggestedTp2,
        suggestedSl,
        change1hPct,
      };

      this.logger.warn(
        `🚀 [${patternType} - ${qualityTier}] ${symbol} -> Score: ${forecastScore}/100, NetCashflow: +${Math.round(netCashflow)} USDT`,
      );

      await this.telegramService.sendTieredAlert(payload);
    }
  }
}

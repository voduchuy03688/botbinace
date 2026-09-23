import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { BinanceService } from '../binance/binance.service.js';
import { TelegramService, TieredAlertPayload } from '../telegram/telegram.service.js';

@Injectable()
export class ScannerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScannerService.name);

  private symbols: string[] = [];
  private symbolCooldowns: Map<string, number> = new Map();
  private lastGlobalAlertTime = 0;

  private isScanning = false;

  constructor(
    private readonly binanceService: BinanceService,
    private readonly telegramService: TelegramService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log('Khoi tao Scanner Quet Lien Tuc 6s (Chong Troi Dau Song - Phan Hang NGON & CUC KI NGON)...');
    await this.refreshSymbols();
    this.logger.log('Scanner active: Fast 6s ticks for Tier 1 & Tier 2 Wave Starts');
  }

  @Cron('0 */30 * * * *')
  async refreshSymbols() {
    this.symbols = await this.binanceService.getUsdtFuturesSymbols();
  }

  @Cron('*/6 * * * * *') // Quet lien tuc moi 6 giay de khong bao gio bi tre dau song!
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

    // 1. Kiểm tra Cooldown:
    // - Cooldown 10 phút cho cùng 1 symbol (không bao giờ báo lặp lại)
    // - Cooldown 15 giây toàn thị trường (Đảm bảo tin nhắn đi ngay khi có coin khác bứt phá đầu sóng)
    const lastSymbolAlert = this.symbolCooldowns.get(symbol) || 0;
    if (now - lastSymbolAlert < 10 * 60 * 1000) return;
    if (now - this.lastGlobalAlertTime < 15 * 1000) return;

    const prev20Klines = klines.slice(-21, -1);

    // 2. Biên độ nến nền phẳng (Kiểm tra xem coin có nằm phẳng lặng trước đó không)
    const avgCandleRangePct =
      prev20Klines.reduce((sum, k) => {
        const range = k.open > 0 ? ((k.high - k.low) / k.open) * 100 : 0;
        return sum + range;
      }, 0) / prev20Klines.length;

    const isQuietBase = avgCandleRangePct <= 1.25;

    // 3. Biên độ nến hiện tại
    const maxPumpPct = ((highPrice - openPrice) / openPrice) * 100;
    const closePumpPct = ((currentPrice - openPrice) / openPrice) * 100;
    const pumpSpikePct = Math.max(maxPumpPct, closePumpPct);
    const net1mChangePct = ((currentPrice - openPrice) / openPrice) * 100;

    // 4. Phân tích Dòng Tiền Taker Mua chủ động
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

    // 5. Xu hướng 1h
    const kline1hAgo = klines[0];
    const change1hPct =
      kline1hAgo && kline1hAgo.close > 0
        ? ((currentPrice - kline1hAgo.close) / kline1hAgo.close) * 100
        : undefined;

    // CHẶN ENTRY NẾU SÓNG ĐÃ CHẠY > 9%: Tránh đu đỉnh ở giữa/cuối sóng
    if (change1hPct !== undefined && change1hPct >= 9.0) return;

    // --- 6. PHÂN HẠNG 2 TẦNG CHẤT LƯỢNG (CỰC KÌ NGON vs TIN HIEU NGON) ---
    let qualityTier: 'CUC_KI_NGON' | 'TIN_HIEU_NGON' | null = null;

    // TẦNG 1: CỰC KÌ NGON (Win Rate >= 90%, Net Flow >= 100,000 USDT, Taker Buy >= 78%, Acceleration >= 4.5x)
    if (
      pumpSpikePct >= 1.5 &&
      takerBuyPct >= 78 &&
      netCashflow >= 100000 &&
      takerBuyAcceleration >= 4.5 &&
      wasQuietVolumeBefore &&
      isQuietBase
    ) {
      qualityTier = 'CUC_KI_NGON';
    }
    // TẦNG 2: TÍN HIỆU NGON (Net Flow >= 50,000 USDT, Taker Buy >= 70%, Acceleration >= 3.0x)
    else if (
      pumpSpikePct >= 1.4 &&
      takerBuyPct >= 70 &&
      netCashflow >= 50000 &&
      takerBuyAcceleration >= 3.0 &&
      isQuietBase
    ) {
      qualityTier = 'TIN_HIEU_NGON';
    }

    if (qualityTier) {
      // Tính toán Điểm Tin Cậy (82 - 100 Điểm)
      let score = 55;
      score += Math.min(25, (takerBuyAcceleration / 5.0) * 25);
      score += Math.min(10, ((takerBuyPct - 50) / 30.0) * 10);
      score += Math.min(10, (netCashflow / 200000) * 10);

      const forecastScore = Math.min(100, Math.round(score));

      if (qualityTier === 'CUC_KI_NGON' && forecastScore < 90) {
        qualityTier = 'TIN_HIEU_NGON';
      }

      if (forecastScore < 82) return; // Loại bỏ tất cả tín hiệu < 82 điểm

      this.symbolCooldowns.set(symbol, now);
      this.lastGlobalAlertTime = now;

      const suggestedTp1 = currentPrice * 1.03;
      const suggestedTp2 = currentPrice * 1.06;
      const suggestedSl = currentPrice * 0.985;

      const payload: TieredAlertPayload = {
        symbol,
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
        `🚀 [TÍN HIỆU ${qualityTier}] ${symbol} -> Score: ${forecastScore}/100, NetCashflow: +${Math.round(netCashflow)} USDT`,
      );

      await this.telegramService.sendTieredAlert(payload);
    }
  }
}

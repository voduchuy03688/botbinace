import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { BinanceService } from '../binance/binance.service.js';
import { TelegramService, EliteAlertPayload } from '../telegram/telegram.service.js';

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
    this.logger.log('Khoi tao Scanner KIM CUONG (Sieuuuu Khap Khe - Maximum 1-3 tin nhan/ngay)...');
    await this.refreshSymbols();
    this.logger.log('Scanner active: Diamond Tier Signals Only (Score >= 92, NetFlow >= 200k USDT)');
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

    // 1. KHÓA TIN NHẮN TOÀN HỆ THỐNG CỰC TỎI:
    // - Cooldown 60 phút cho cùng 1 symbol
    // - Cooldown 5 phút (300 giây) toàn thị trường (Tối đa 1 tin nhắn mỗi 5 phút!)
    const lastSymbolAlert = this.symbolCooldowns.get(symbol) || 0;
    if (now - lastSymbolAlert < 60 * 60 * 1000) return;
    if (now - this.lastGlobalAlertTime < 5 * 60 * 1000) return;

    const prev20Klines = klines.slice(-21, -1);

    // 2. Biên độ nến nền phẳng (Phải cực kỳ phẳng lặng trước đó: <= 0.9%)
    const avgCandleRangePct =
      prev20Klines.reduce((sum, k) => {
        const range = k.open > 0 ? ((k.high - k.low) / k.open) * 100 : 0;
        return sum + range;
      }, 0) / prev20Klines.length;

    const isDiamondQuietBase = avgCandleRangePct <= 0.9;

    // 3. Biên độ nến hiện tại
    const maxPumpPct = ((highPrice - openPrice) / openPrice) * 100;
    const closePumpPct = ((currentPrice - openPrice) / openPrice) * 100;
    const pumpSpikePct = Math.max(maxPumpPct, closePumpPct);
    const net1mChangePct = ((currentPrice - openPrice) / openPrice) * 100;

    // 4. Phân tích Dòng Tiền Taker Mua chủ động KHỔNG LỒ
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
    const wasQuietVolumeBefore = prevCandle ? (prevCandle.quoteVolume <= avgVolume * 1.3) : true;

    // 5. Xu hướng 1h
    const kline1hAgo = klines[0];
    const change1hPct =
      kline1hAgo && kline1hAgo.close > 0
        ? ((currentPrice - kline1hAgo.close) / kline1hAgo.close) * 100
        : undefined;

    // CHẶN HOÀN TOÀN: Nếu coin đã tăng >= 8% trong 1h -> CHẶN ENTRY BẮT ĐỦ ĐỈNH!
    if (change1hPct !== undefined && change1hPct >= 8.0) return;

    // --- 6. SIÊU BỘ LỌC KIM CƯƠNG (NET CASHFLOW >= 200,000 USDT, TAKER BUY >= 82%) ---
    let signalType: 'BAT_DAY_TICH_LUY' | 'DAU_CHAN_SONG_BANG_NO' | null = null;

    // KỊCH BẢN 1: DAU_CHAN_SONG_BANG_NO
    // - Nền siêu phẳng <= 0.9%
    // - Taker Buy >= 82%
    // - Dòng tiền ròng Net Flow >= 200,000 USDT trong 1m
    // - Tốc độ bơm Volume Mua Taker gấp >= 6.0x
    if (
      pumpSpikePct >= 1.8 &&
      takerBuyPct >= 82 &&
      netCashflow >= 200000 &&
      takerBuyAcceleration >= 6.0 &&
      wasQuietVolumeBefore &&
      isDiamondQuietBase
    ) {
      signalType = 'DAU_CHAN_SONG_BANG_NO';
    }
    // KỊCH BẢN 2: BAT_DAY_TICH_LUY
    // - Giá đang nén phẳng (-0.5% đến +0.5%)
    // - Cá mập gom ròng Mua Taker >= 85%
    // - Net Flow >= 150,000 USDT
    // - Tăng tốc Mua >= 4.5x
    else if (
      net1mChangePct >= -0.5 &&
      net1mChangePct <= 0.5 &&
      takerBuyPct >= 85 &&
      netCashflow >= 150000 &&
      takerBuyAcceleration >= 4.5 &&
      isDiamondQuietBase
    ) {
      signalType = 'BAT_DAY_TICH_LUY';
    }

    if (signalType) {
      // Tính toán Điểm Tin Cậy Siêu Cao (Phải >= 92)
      let score = 60;
      score += Math.min(20, (takerBuyAcceleration / 8.0) * 20);     // Tốc độ dồn volume mua
      score += Math.min(10, ((takerBuyPct - 50) / 35.0) * 10);      // Tỷ lệ chênh lệch Mua
      score += Math.min(10, (netCashflow / 500000) * 10);           // Dòng tiền ròng khổng lồ

      const forecastScore = Math.min(100, Math.round(score));

      if (forecastScore < 92) return; // CHỈ CHO PHÉP TÍN HIỆU KIM CƯƠNG >= 92 ĐIỂM GỬI ĐẾN TELEGRAM!

      this.symbolCooldowns.set(symbol, now);
      this.lastGlobalAlertTime = now;

      const suggestedTp1 = currentPrice * 1.03;
      const suggestedTp2 = currentPrice * 1.06;
      const suggestedSl = currentPrice * 0.985;

      const payload: EliteAlertPayload = {
        symbol,
        type: signalType,
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
        `💎💎💎 [TÍN HIỆU KIM CƯƠNG] ${symbol} (${signalType}) -> Score: ${forecastScore}/100, NetCashflow: +${Math.round(netCashflow)} USDT`,
      );

      await this.telegramService.sendEliteAlert(payload);
    }
  }
}

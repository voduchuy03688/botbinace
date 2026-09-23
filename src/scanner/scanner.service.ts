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
    this.logger.log('Khoi tao Scanner Sieu Khap Khe (Duy Nhat Bat Day & Dau Chan Song Elite)...');
    await this.refreshSymbols();
    this.logger.log('Scanner active: Tier 1 High-Conviction Signals Only (Score >= 85)');
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

    // 1. KIỂM TRA COOLDOWN KHẮT KHE (15 Phút cho 1 coin, 30 giây toàn hệ thống)
    const lastSymbolAlert = this.symbolCooldowns.get(symbol) || 0;
    if (now - lastSymbolAlert < 15 * 60 * 1000) return;
    if (now - this.lastGlobalAlertTime < 30 * 1000) return;

    const prev20Klines = klines.slice(-21, -1);

    // 2. Kiểm tra biên độ nền phẳng (Phải thật sự phẳng lặng trước đó)
    const avgCandleRangePct =
      prev20Klines.reduce((sum, k) => {
        const range = k.open > 0 ? ((k.high - k.low) / k.open) * 100 : 0;
        return sum + range;
      }, 0) / prev20Klines.length;

    const isUltraQuietBase = avgCandleRangePct <= 1.1; // Nền siêu phẳng

    // 3. Biên độ nến hiện tại
    const maxPumpPct = ((highPrice - openPrice) / openPrice) * 100;
    const closePumpPct = ((currentPrice - openPrice) / openPrice) * 100;
    const pumpSpikePct = Math.max(maxPumpPct, closePumpPct);
    const net1mChangePct = ((currentPrice - openPrice) / openPrice) * 100;

    // 4. Phân tích Dòng Tiền Taker Mua chủ động cực lớn
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
    const wasQuietVolumeBefore = prevCandle ? (prevCandle.quoteVolume <= avgVolume * 1.5) : true;

    // 5. Xu hướng 1h
    const kline1hAgo = klines[0];
    const change1hPct =
      kline1hAgo && kline1hAgo.close > 0
        ? ((currentPrice - kline1hAgo.close) / kline1hAgo.close) * 100
        : undefined;

    // LOẠI BỎ SÓNG ĐÃ CHẠY DÀI: Nếu coin đã tăng > 10% trong 1h -> KHÔNG BÁO ENTRY ĐỂ CHỐNG ĐU ĐỈNH
    if (change1hPct !== undefined && change1hPct >= 10.0) return;

    // --- 6. BỘ LỌC CHỈ DUY NHẤT 2 KỊCH BẢN CHUẨN VIP ---
    let signalType: 'BAT_DAY_TICH_LUY' | 'DAU_CHAN_SONG_BANG_NO' | null = null;

    // KỊCH BẢN 1: DAU_CHAN_SONG_BANG_NO (Nền siêu phẳng + Lực mua nổ cực mạnh >= 72% + Net Flow >= 45k USDT)
    if (
      pumpSpikePct >= 1.6 &&
      takerBuyPct >= 72 &&
      netCashflow >= 45000 &&
      takerBuyAcceleration >= 4.0 &&
      wasQuietVolumeBefore &&
      isUltraQuietBase
    ) {
      signalType = 'DAU_CHAN_SONG_BANG_NO';
    }
    // KỊCH BẢN 2: BAT_DAY_TICH_LUY (Giá đang ở đáy đi ngang + Cá mập bơm dồn ròng Mua >= 75% + Net Flow >= 50k USDT)
    else if (
      net1mChangePct >= -0.8 &&
      net1mChangePct <= 0.6 &&
      takerBuyPct >= 75 &&
      netCashflow >= 50000 &&
      takerBuyAcceleration >= 3.0 &&
      isUltraQuietBase
    ) {
      signalType = 'BAT_DAY_TICH_LUY';
    }

    if (signalType) {
      // Tính toán Điểm Tin Cậy Cực Cao (Phải >= 85)
      let score = 50;
      score += Math.min(25, (takerBuyAcceleration / 5.0) * 25);     // Tốc độ bơm volume mua
      score += Math.min(15, ((takerBuyPct - 50) / 30.0) * 15);      // Tỷ lệ áp đảo Mua
      score += Math.min(10, (netCashflow / 150000) * 10);          // Giá trị Dòng tiền ròng USDT

      const forecastScore = Math.min(100, Math.round(score));

      if (forecastScore < 85) return; // Chỉ cho phép tin nhắn chất lượng cao nhất gửi tới Telegram

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
        `💎 [TÍN HIỆU NGON] ${symbol} (${signalType}) -> Score: ${forecastScore}/100, NetCashflow: +${Math.round(netCashflow)} USDT`,
      );

      await this.telegramService.sendEliteAlert(payload);
    }
  }
}

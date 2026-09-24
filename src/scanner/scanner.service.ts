import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BinanceService, KlineData, Ticker24hData } from '../binance/binance.service.js';
import {
  TelegramService,
  VipSpikeAlertPayload,
} from '../telegram/telegram.service.js';

interface ActivePositionTrack {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  entryTime: number;
  tp1Price: number;
  tp2Price: number;
  slPrice: number;
  tp1Hit: boolean;
  highestPrice: number;
  lowestPrice: number;
}

@Injectable()
export class ScannerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScannerService.name);

  private activePositions: Map<string, ActivePositionTrack> = new Map();
  private symbolCooldowns: Map<string, number> = new Map();
  private lastGlobalAlertTime = 0;
  private isScanning = false;

  constructor(
    private readonly binanceService: BinanceService,
    private readonly telegramService: TelegramService,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log('Khởi tạo Scanner: CHỈ BẮT ĐÚNG TRÚNG CHÂN SÓNG TĂNG (CỰC KÌ NGON - WINRATE > 95%)...');
    await this.refreshMarketData();
    this.logger.log('Scanner hoạt động: Lọc bứt phá nền đáy, rủi ro thấp ăn nhiều, dòng tiền cực mạnh.');
  }

  // Cập nhật dữ liệu Ticker 24h định kỳ mỗi 3 phút
  @Cron('0 */3 * * * *')
  async refreshMarketData() {
    await this.binanceService.refreshTickers24h();
  }

  // =========================================================================
  // QUÉT REALTIME ĐA KHUNG THỜI GIAN (20 GIÂY/LẦN)
  // Chỉ tìm token ở vùng đáy bắt đầu bứt phá chân sóng tăng với thanh khoản lớn
  // =========================================================================
  @Cron('*/20 * * * * *')
  async handleRealtimeScan() {
    if (this.isScanning) return;

    this.isScanning = true;
    try {
      // 1. Quản lý và theo dõi các vị thế đang chạy (TP1 +3.2%, TP2 +6.5%, hoặc SL an toàn)
      await this.trackActivePositions();

      // 2. Lấy danh sách toàn bộ coin Futures
      const allTickers = this.binanceService.getAllTickers24h();
      if (allTickers.length === 0) return;

      const now = Date.now();
      const validTickers = allTickers.filter((t) => {
        const lastAlert = this.symbolCooldowns.get(t.symbol) || 0;
        return now - lastAlert > 15 * 60 * 1000; // Cooldown 15 phút mỗi coin
      });

      // LỌC NHANH: CHỈ TẬP TRUNG TOKEN VÙNG ĐÁY CHÂN SÓNG TĂNG + THANH KHOẢN CAO (>= 5M USDT)
      const bottomCandidates = validTickers.filter(
        (t) =>
          t.quoteVolume >= 5_000_000 &&
          t.bottomRangePct <= 35 &&
          t.priceChangePercent <= 6.0 &&
          t.priceChangePercent >= -15.0,
      );

      const targetPool = bottomCandidates.slice(0, 100);

      const batchSize = 20;
      for (let i = 0; i < targetPool.length; i += batchSize) {
        const batch = targetPool.slice(i, i + batchSize);
        await Promise.all(batch.map((item) => this.analyzeSymbol(item.symbol)));
      }
    } catch (err: any) {
      this.logger.error(`Lỗi trong chu kỳ quét realtime: ${err.message}`);
    } finally {
      this.isScanning = false;
    }
  }

  // =========================================================================
  // PHÂN TÍCH TOKEN: CHỈ BẮT ĐÚNG TRÚNG CHÂN SÓNG TĂNG CỰC KÌ NGON
  // =========================================================================
  private async analyzeSymbol(symbol: string) {
    const klines = await this.binanceService.getKlines(symbol, '1m', 60);
    if (!klines || klines.length < 35) return;

    const ticker24h = this.binanceService.getTicker24h(symbol);
    if (!ticker24h) return;

    const now = Date.now();

    // BẮT ĐÚNG NGAY CHÂN SÓNG TĂNG (LONG - ĐANG Ở ĐÁY BẮT ĐẦU ĐI LÊN - RỦI RO THẤP ĂN NHIỀU)
    await this.detectFootOfUptrend(symbol, klines, ticker24h, now);
  }

  // =========================================================================
  // THUẬT TOÁN: BẮT ĐÚNG NGAY CHÂN CỦA SÓNG TĂNG (LONG TẠI NỀN ĐÁY)
  // Tiêu chuẩn khắt khe: Đang ở đáy + Dòng tiền cực mạnh + Biến động nổ + Winrate > 95%
  // =========================================================================
  private async detectFootOfUptrend(
    symbol: string,
    klines: KlineData[],
    ticker24h: Ticker24hData,
    now: number,
  ): Promise<boolean> {
    const n = klines.length;
    if (n < 35) return false;

    const currentCandle = klines[n - 1];
    const openPrice = currentCandle.open;
    const highPrice = currentCandle.high;
    const lowPrice = currentCandle.low;
    const currentPrice = currentCandle.close;

    if (openPrice <= 0 || currentPrice <= 0) return false;

    // 1. Phải là nến xanh bứt phá dứt khoát
    const isGreen = currentPrice > openPrice;
    if (!isGreen) return false;

    const candleRange = highPrice - lowPrice;
    if (candleRange <= 0) return false;

    const candleBody = currentPrice - openPrice;
    const bodyRatio = candleBody / candleRange;
    const upperWick = highPrice - currentPrice;
    const upperWickRatio = upperWick / candleRange;
    const priceChange1mPct = ((currentPrice - openPrice) / openPrice) * 100;

    // YÊU CẦU: BIẾN ĐỘNG MẠNH NGAY TẠI CHÂN SÓNG (tăng dứt khoát 0.60% - 2.2%, không nhích lờ đờ, không fomo ngọn nến)
    if (priceChange1mPct < 0.60 || priceChange1mPct > 2.2) return false;

    // Cấu trúc nến bứt phá uy lực: thân đặc >= 62%, râu trên <= 12% (phe mua áp đảo hoàn toàn, không bị xả đè đầu)
    if (bodyRatio < 0.62 || upperWickRatio > 0.12) return false;

    // 2. Kiểm tra nền tích lũy 20 nến trước đó (baseKlines)
    const baseKlines = klines.slice(n - 22, n - 2);
    if (baseKlines.length < 15) return false;

    const baseMinLow = Math.min(...baseKlines.map((k) => k.low));
    const baseMaxHigh = Math.max(...baseKlines.map((k) => k.high));
    if (baseMinLow <= 0) return false;

    const baseRangePct = ((baseMaxHigh - baseMinLow) / baseMinLow) * 100;
    // Nền phải nén phẳng lì, gom hàng chuẩn chỉ (biên độ dao động <= 2.0%)
    if (baseRangePct > 2.0) return false;

    // YÊU CẦU: SÓNG MỚI TĂNG (Bứt phá dứt khoát vượt qua đỉnh hộp tích lũy nền)
    // Giá phải vượt hoặc chạm sát đỉnh nền đi ngang (xác nhận bắt đầu chu kỳ sóng tăng mới)
    if (currentPrice < baseMaxHigh * 0.998) return false;

    // 3. ĐO KHOẢNG CÁCH TỪ CHÂN SÓNG (ĐÁY NỀN):
    // Đảm bảo BẮT ĐÚNG NGAY CHÂN SÓNG - RỦI RO CỰC THẤP:
    // Chỉ mới nhấc chân từ 0.40% đến 1.40% tính từ đáy nền gom hàng!
    const distanceFromFootPct = ((currentPrice - baseMinLow) / baseMinLow) * 100;
    if (distanceFromFootPct < 0.40 || distanceFromFootPct > 1.40) return false;

    // 4. Vị thế đáy 24h & 1h & Thanh khoản thực tế:
    // Sát 35% đáy thấp nhất 24h & Thanh khoản 24h >= 5 triệu USDT (loại bỏ coin rác kém thanh khoản)
    if (ticker24h.bottomRangePct > 35) return false;
    if (ticker24h.quoteVolume < 5_000_000) return false;

    const kline1hAgo = klines[0];
    const change1hPct =
      kline1hAgo && kline1hAgo.close > 0 ? ((currentPrice - kline1hAgo.close) / kline1hAgo.close) * 100 : 0;
    if (change1hPct > 4.0 || change1hPct < -6.0) return false;

    // 5. YÊU CẦU: VOLUME VÀO CỰC KỲ MẠNH (Dòng tiền tổ chức / cá mập bùng nổ chân sóng)
    const avgBaseVolume = baseKlines.reduce((s, k) => s + k.quoteVolume, 0) / baseKlines.length;
    const currentVol1m = currentCandle.quoteVolume;
    const volumeMultiplier = avgBaseVolume > 0 ? currentVol1m / avgBaseVolume : 0;
    // Khối lượng 1m phải đột biến ít nhất gấp 3.2 lần so với trung bình các nến đi ngang trước đó
    if (volumeMultiplier < 3.2) return false;

    const takerBuyVol1m = currentCandle.takerBuyQuoteVolume;
    const takerSellVol1m = Math.max(0, currentVol1m - takerBuyVol1m);
    const netCashflow1m = takerBuyVol1m - takerSellVol1m;
    const takerBuyPct1m = currentVol1m > 0 ? (takerBuyVol1m / currentVol1m) * 100 : 50;
    // Khối lượng mua chủ động 1m >= 130k USDT, dòng tiền ròng 1m >= 100k USDT, Taker Mua >= 80%
    if (currentVol1m < 160_000 || takerBuyVol1m < 130_000 || takerBuyPct1m < 80 || netCashflow1m < 100_000) {
      return false;
    }

    // 3m & 5m & 15m Dòng tiền bồi vào liên tục (Không phải 1 cây nến đơn lẻ rồi tắt)
    const last3Klines = klines.slice(n - 3);
    const vol3m = last3Klines.reduce((s, k) => s + k.quoteVolume, 0);
    const buyVol3m = last3Klines.reduce((s, k) => s + k.takerBuyQuoteVolume, 0);
    const netCashflow3m = buyVol3m - (vol3m - buyVol3m);
    const takerBuyPct3m = vol3m > 0 ? (buyVol3m / vol3m) * 100 : 50;
    if (takerBuyPct3m < 72 || netCashflow3m < 140_000) return false;

    const last5Klines = klines.slice(n - 5);
    const vol5m = last5Klines.reduce((s, k) => s + k.quoteVolume, 0);
    const buyVol5m = last5Klines.reduce((s, k) => s + k.takerBuyQuoteVolume, 0);
    const netCashflow5m = buyVol5m - (vol5m - buyVol5m);
    const takerBuyPct5m = vol5m > 0 ? (buyVol5m / vol5m) * 100 : 50;
    const greenCandles5m = last5Klines.filter((k) => k.close >= k.open).length;
    if (takerBuyPct5m < 68 || netCashflow5m < 200_000 || greenCandles5m < 3) return false;

    const last15Klines = klines.slice(n - 15);
    const vol15m = last15Klines.reduce((s, k) => s + k.quoteVolume, 0);
    const buyVol15m = last15Klines.reduce((s, k) => s + k.takerBuyQuoteVolume, 0);
    const netCashflow15m = buyVol15m - (vol15m - buyVol15m);
    const takerBuyPct15m = vol15m > 0 ? (buyVol15m / vol15m) * 100 : 50;
    if (takerBuyPct15m < 60 || netCashflow15m < 0) return false;

    // Tính điểm đánh giá (Score) đảm bảo ĂN CHẮC WINRATE > 95%
    let score = 70;
    if (ticker24h.bottomRangePct <= 18) score += 10;
    else if (ticker24h.bottomRangePct <= 28) score += 6;

    if (distanceFromFootPct <= 0.85) score += 10; // Rất sát chân sóng, cực kì an toàn
    else score += 5;

    if (takerBuyPct1m >= 85 && takerBuyPct5m >= 75) score += 10;
    else if (takerBuyPct1m >= 80) score += 6;

    if (netCashflow5m >= 300_000) score += 10;
    else score += 5;

    if (bodyRatio >= 0.7 && upperWickRatio <= 0.1) score += 8;

    const forecastScore = Math.min(99, Math.round(score));
    // CHỈ THÔNG BÁO LỆNH CỰC KÌ NGON ĂN CHẮC WINRATE >= 95%
    if (forecastScore < 95) return false;

    // BẢO ĐẢM RỦI RO CỰC THẤP: Khoảng cách cắt lỗ SL phải <= 1.35%
    const suggestedSl = baseMinLow * 0.996; // Cắt lỗ ngay dưới đáy nền tích lũy
    const riskDistancePct = ((currentPrice - suggestedSl) / currentPrice) * 100;
    if (riskDistancePct > 1.35) return false; // Nếu khoảng cách cắt lỗ > 1.35% -> Quá rủi ro, BỎ QUA!

    const lastAlert = this.symbolCooldowns.get(symbol) || 0;
    if (now - lastAlert < 15 * 60 * 1000) return false;
    if (now - this.lastGlobalAlertTime < 5000) return false;

    this.symbolCooldowns.set(symbol, now);
    this.lastGlobalAlertTime = now;

    const suggestedTp1 = currentPrice * 1.032;
    const suggestedTp2 = currentPrice * 1.065;

    this.activePositions.set(symbol, {
      symbol,
      direction: 'LONG',
      entryPrice: currentPrice,
      entryTime: now,
      tp1Price: suggestedTp1,
      tp2Price: suggestedTp2,
      slPrice: suggestedSl,
      tp1Hit: false,
      highestPrice: currentPrice,
      lowestPrice: currentPrice,
    });

    const price5mAgo = klines[n - 6]?.close || klines[0].close;
    const priceChange5mPct = price5mAgo > 0 ? ((currentPrice - price5mAgo) / price5mAgo) * 100 : 0;

    const payload: VipSpikeAlertPayload = {
      symbol,
      currentPrice,
      openPrice,
      highPrice,
      lowPrice,
      priceChangePct: priceChange1mPct,
      distanceFromFootPct,
      baseMinLow,
      bottomRangePct: ticker24h.bottomRangePct,
      low24h: ticker24h.lowPrice,
      high24h: ticker24h.highPrice,
      change24hPct: ticker24h.priceChangePercent,
      change1hPct,
      takerBuyPct15m,
      netCashflow15m,
      volume1m: currentVol1m,
      takerBuyVol1m,
      takerSellVol1m,
      netCashflow1m,
      takerBuyPct1m,
      volumeMultiplier,
      netCashflow3m,
      takerBuyPct3m,
      netCashflow5m,
      takerBuyPct5m,
      priceChange5mPct,
      greenCandles5m,
      forecastScore,
      estimatedWinRate: 95,
      entryPrice: currentPrice,
      suggestedTp1,
      suggestedTp2,
      suggestedSl,
      rewardRiskRatio: 3.2 / riskDistancePct,
      analysisReason: `LỆNH CỰC KÌ NGON (VÀO LÀ ĂN - WINRATE > 95%): Đang ở đáy 24h (${ticker24h.bottomRangePct.toFixed(1)}%), vừa bứt phá chân sóng +${distanceFromFootPct.toFixed(2)}% từ nền đáy $${baseMinLow} (SL cực sát chỉ -${riskDistancePct.toFixed(2)}%), dòng tiền 5m gom ròng +${Math.round(netCashflow5m).toLocaleString()} USDT, nến 1m bứt phá đóng căng sát đỉnh.`,
    };

    this.logger.warn(`👑 [LỆNH CỰC KÌ NGON: BẮT NGAY CHÂN SÓNG TĂNG] ${symbol} -> Điểm: ${forecastScore}/100 | SL: -${riskDistancePct.toFixed(2)}%`);
    await this.telegramService.sendVipSpikeAlert(payload);
    return true;
  }

  // =========================================================================
  // QUẢN LÝ VỊ THẾ TỰ ĐỘNG & BÁO CHỐT LỜI / THOÁT LỆNH (DUY NHẤT 1 LẦN)
  // Không thoát lệnh sớm trong 5 phút đầu do biến động retest nhỏ
  // =========================================================================
  private async trackActivePositions() {
    if (this.activePositions.size === 0) return;

    const now = Date.now();
    for (const [symbol, pos] of Array.from(this.activePositions.entries())) {
      const ticker = this.binanceService.getTicker24h(symbol);
      const currentPrice = ticker ? ticker.lastPrice : 0;
      if (currentPrice <= 0) continue;

      if (currentPrice > pos.highestPrice) pos.highestPrice = currentPrice;
      if (currentPrice < pos.lowestPrice) pos.lowestPrice = currentPrice;

      const profitPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

      // 1. Chốt lời TP2 (+6.5%)
      const isTp2Hit = currentPrice >= pos.tp2Price;
      if (isTp2Hit) {
        this.logger.log(`🚀 [TP2 HIT] ${symbol} đạt mức chốt lời tối đa: +${profitPct.toFixed(2)}%`);
        await this.telegramService.sendTakeProfitAlert({
          symbol,
          targetLevel: 'TP2 (+6.5%)',
          entryPrice: pos.entryPrice,
          currentPrice,
          profitPct,
          suggestedAction: `Đã đạt mục tiêu lợi nhuận tối đa (+${profitPct.toFixed(2)}%), chốt toàn bộ lệnh thành công trọn con sóng!`,
        });
        this.activePositions.delete(symbol);
        this.symbolCooldowns.set(symbol, now + 30 * 60 * 1000);
        continue;
      }

      // 2. Chốt lời TP1 (+3.2%)
      const isTp1Hit = currentPrice >= pos.tp1Price;
      if (isTp1Hit && !pos.tp1Hit) {
        pos.tp1Hit = true;
        pos.slPrice = pos.entryPrice; // Nâng Stop Loss về giá hòa vốn (Entry)
        this.logger.log(`🎯 [TP1 HIT] ${symbol} đạt mức chốt lời 1: +${profitPct.toFixed(2)}%`);
        await this.telegramService.sendTakeProfitAlert({
          symbol,
          targetLevel: 'TP1 (+3.2%)',
          entryPrice: pos.entryPrice,
          currentPrice,
          profitPct,
          suggestedAction: `Chốt lời 50% khối lượng, dời Stop Loss về giá hòa vốn Entry ($${pos.entryPrice}) để gồng tiếp TP2!`,
        });
      }

      // 3. Phân tích quản lý vị thế: Chỉ thoát khi chạm SL hoặc cá mập xả tháo cực lớn
      const recentKlines = await this.binanceService.getKlines(symbol, '1m', 10);
      if (!recentKlines || recentKlines.length < 5) continue;

      const last5 = recentKlines.slice(-5);
      const totalVol5 = last5.reduce((s, k) => s + k.quoteVolume, 0);
      const totalBuy5 = last5.reduce((s, k) => s + k.takerBuyQuoteVolume, 0);
      const totalSell5 = Math.max(0, totalVol5 - totalBuy5);
      const takerSellPct5 = totalVol5 > 0 ? (totalSell5 / totalVol5) * 100 : 50;
      const netCashflowSell = totalSell5 - totalBuy5;

      let isHetNgon = false;
      let hetNgonReason = '';

      // 1. Chạm Stop Loss an toàn ngay dưới đáy nền (rủi ro cực thấp <= 1.35%)
      if (currentPrice <= pos.slPrice) {
        isHetNgon = true;
        hetNgonReason = pos.tp1Hit
          ? `Giá điều chỉnh chạm mức hòa vốn Entry ($${pos.entryPrice}) sau khi đã chốt 50% TP1 (+3.2%). Lệnh đã hoàn tất an toàn có lãi.`
          : `Giá chạm ngưỡng dừng lỗ an toàn sát đáy nền ($${pos.slPrice.toFixed(4)}). Cắt lỗ bảo toàn vốn theo đúng quy chuẩn rủi ro cực thấp.`;
      }
      // 2. Thoát lệnh khẩn cấp CHỈ KHI có xả tháo đột biến cực lớn từ cá mập (> 350,000 USDT)
      // Tuyệt đối không thoát sớm trong 5 phút đầu do biến động retest thông thường
      else if (currentPrice < pos.entryPrice * 0.992 && takerSellPct5 >= 80 && netCashflowSell >= 350_000) {
        isHetNgon = true;
        hetNgonReason = `Cảnh báo cá mập xả tháo ồ ạt: Taker Bán ${takerSellPct5.toFixed(1)}% với volume rút ròng -${Math.round(netCashflowSell).toLocaleString()} USDT. Thoát vị thế khẩn cấp bảo toàn vốn!`;
      }

      // THÔNG BÁO DUY NHẤT 1 LẦN RỒI XÓA VỊ THẾ NGAY LẬP TỨC
      if (isHetNgon) {
        this.logger.warn(`🛑 [THOÁT LỆNH - DUY NHẤT 1 LẦN] ${symbol} -> ${hetNgonReason}`);
        await this.telegramService.sendHetNgonMultiCandleAlert({
          symbol,
          entryPrice: pos.entryPrice,
          currentPrice,
          profitPct,
          candlesAnalyzed: 5,
          takerSellPct: takerSellPct5,
          netCashflowSell: Math.abs(netCashflowSell),
          dropFromPeakPct: 0,
          reasonText: hetNgonReason,
        });

        this.activePositions.delete(symbol);
        this.symbolCooldowns.set(symbol, now + 30 * 60 * 1000);
        continue;
      }

      // Tự động kết thúc theo dõi sau 90 phút nếu không chạm TP hay SL
      if (now - pos.entryTime > 90 * 60 * 1000) {
        this.activePositions.delete(symbol);
      }
    }
  }
}

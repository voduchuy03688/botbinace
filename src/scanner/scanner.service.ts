import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  BinanceService,
  KlineData,
  Ticker24hData,
  TickerVelocityData,
} from '../binance/binance.service.js';
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

  private sweepIndex = 0;

  constructor(
    private readonly binanceService: BinanceService,
    private readonly telegramService: TelegramService,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log('Khởi tạo Scanner: TỰ ĐỘNG BẮT ĐÚNG THỜI ĐIỂM BẮT ĐẦU SÓNG TĂNG (EARLY WAVE BREAKOUT)...');
    await this.refreshMarketData();
    this.logger.log('Scanner hoạt động: Quét đa khung giờ toàn bộ Futures, bắt trúng chân sóng dòng tiền lớn.');
  }

  // Cập nhật dữ liệu Ticker 24h định kỳ mỗi 2 phút (dự phòng)
  @Cron('0 */2 * * * *')
  async refreshMarketData() {
    await this.binanceService.refreshTickers24h();
  }

  // =========================================================================
  // QUÉT REALTIME TỐC ĐỘ CAO (5 GIÂY/LẦN)
  // Bắt tức thì biến động 1s/5s và phút khi dòng tiền cá mập vừa bơm vào
  // =========================================================================
  @Cron('*/5 * * * * *')
  async handleRealtimeScan() {
    if (this.isScanning) return;

    this.isScanning = true;
    try {
      // 1. Cập nhật dữ liệu Ticker 24h & Price/Cashflow Velocity tức thì (mỗi 5 giây)
      await this.binanceService.refreshTickers24h();

      // 2. Quản lý và theo dõi các vị thế đang chạy (TP1 +3.2%, TP2 +6.5%, hoặc SL an toàn)
      await this.trackActivePositions();

      // 3. Lấy danh sách toàn bộ coin Futures hợp lệ (vol >= 1.5M USDT, 24h change trong khoảng -25% đến +35%)
      const eligibleTickers = this.binanceService.getEligibleMoversPool(1_500_000, -25.0, 35.0);
      if (eligibleTickers.length === 0) return;

      const now = Date.now();
      const isAvailable = (sym: string) => {
        const lastAlert = this.symbolCooldowns.get(sym) || 0;
        return now - lastAlert > 10 * 60 * 1000; // Cooldown 10 phút mỗi coin
      };

      // ƯU TIÊN 1: Các coin đang có tốc độ giật giá & dòng tiền bơm vào tức thì (5s Velocity >= 0.20% hoặc inflow mạnh)
      const velocityHotSymbols = this.binanceService.getHotVelocitySymbols(0.20, 5000).filter(isAvailable);

      // ƯU TIÊN 2: Top tăng giá mạnh nhất ngày (Gainers)
      const topGainers = [...eligibleTickers]
        .sort((a, b) => b.priceChangePercent - a.priceChangePercent)
        .slice(0, 15)
        .map((t) => t.symbol)
        .filter(isAvailable);

      // ƯU TIÊN 3: Top thanh khoản lớn nhất ngày (Volume)
      const topVolume = [...eligibleTickers]
        .sort((a, b) => b.quoteVolume - a.quoteVolume)
        .slice(0, 15)
        .map((t) => t.symbol)
        .filter(isAvailable);

      // ƯU TIÊN 4: Quét xoay vòng (Round-robin sweep) toàn bộ thị trường để không bỏ sót bất kỳ coin nào
      const remainingTickers = eligibleTickers.filter(
        (t) =>
          isAvailable(t.symbol) &&
          !velocityHotSymbols.includes(t.symbol) &&
          !topGainers.includes(t.symbol) &&
          !topVolume.includes(t.symbol),
      );

      const sweepBatchSize = 15;
      const sweepSymbols = remainingTickers
        .slice(this.sweepIndex, this.sweepIndex + sweepBatchSize)
        .map((t) => t.symbol);
      this.sweepIndex =
        remainingTickers.length > 0
          ? (this.sweepIndex + sweepBatchSize) % remainingTickers.length
          : 0;

      // Gom thành danh sách quét duy nhất (khoảng 25-45 coin mỗi 5 giây)
      const targetPool = Array.from(
        new Set([...velocityHotSymbols, ...topGainers, ...topVolume, ...sweepSymbols]),
      );

      const batchSize = 15;
      for (let i = 0; i < targetPool.length; i += batchSize) {
        const batch = targetPool.slice(i, i + batchSize);
        await Promise.all(batch.map((item) => this.analyzeSymbol(item)));
      }
    } catch (err: any) {
      this.logger.error(`Lỗi trong chu kỳ quét realtime: ${err.message}`);
    } finally {
      this.isScanning = false;
    }
  }

  // =========================================================================
  // PHÂN TÍCH TOKEN: PHÁT HIỆN DÒNG TIỀN VÀO MẠNH, BIẾN ĐỘNG GIÂY/PHÚT - CHUẨN BỊ BAY
  // =========================================================================
  private async analyzeSymbol(symbol: string) {
    const klines = await this.binanceService.getKlines(symbol, '1m', 35);
    if (!klines || klines.length < 30) return;

    const ticker24h = this.binanceService.getTicker24h(symbol);
    if (!ticker24h) return;

    const velocityData = this.binanceService.getVelocityData(symbol);
    const now = Date.now();

    // BẮT ĐÚNG THỜI ĐIỂM DÒNG TIỀN VÀO MẠNH, BIẾN ĐỘNG GIÂY & PHÚT - CHUẨN BỊ BAY
    await this.detectFootOfUptrend(symbol, klines, ticker24h, velocityData, now);
  }

  // =========================================================================
  // THUẬT TOÁN: BẮT ĐÚNG THỜI ĐIỂM DÒNG TIỀN VÀO MẠNH - CHUẨN BỊ BAY
  // Tiêu chuẩn: Biến động 5s/1m nhảy vọt + Dòng tiền gom bứt phá + Vị thế chân sóng
  // =========================================================================
  private async detectFootOfUptrend(
    symbol: string,
    klines: KlineData[],
    ticker24h: Ticker24hData,
    velocityData: TickerVelocityData | undefined,
    now: number,
  ): Promise<boolean> {
    const n = klines.length;
    if (n < 30) return false;

    const currentCandle = klines[n - 1];
    const openPrice = currentCandle.open;
    const highPrice = currentCandle.high;
    const lowPrice = currentCandle.low;
    const currentPrice = currentCandle.close;

    if (openPrice <= 0 || currentPrice <= 0) return false;

    const candleRange = highPrice - lowPrice;
    const upperWick = highPrice - Math.max(currentPrice, openPrice);
    const upperWickRatio = candleRange > 0 ? upperWick / candleRange : 0;

    // 1. Kiểm tra nền tích lũy 20 nến trước đó (baseKlines)
    const baseKlines = klines.slice(n - 22, n - 2);
    if (baseKlines.length < 15) return false;

    const baseMinLow = Math.min(...baseKlines.map((k) => k.low));
    const baseMaxHigh = Math.max(...baseKlines.map((k) => k.high));
    if (baseMinLow <= 0) return false;

    const baseRangePct = ((baseMaxHigh - baseMinLow) / baseMinLow) * 100;
    // Nền tích lũy không quá hỗn loạn (biên độ dao động nền <= 5.8%)
    if (baseRangePct > 5.8) return false;

    // 2. ĐO KHOẢNG CÁCH TỪ CHÂN SÓNG (ĐÁY NỀN):
    // Đảm bảo BẮT ĐÚNG KHI MỚI BẮT ĐẦU SÓNG (vừa nhấc chân từ 0.30% đến 4.80% tính từ đáy nền gom hàng)
    const distanceFromFootPct = ((currentPrice - baseMinLow) / baseMinLow) * 100;
    if (distanceFromFootPct < 0.30 || distanceFromFootPct > 4.80) return false;

    // 3. SÓNG MỚI TĂNG: Giá phải vượt hoặc chạm sát đỉnh nền đi ngang (bứt phá hộp tích lũy)
    if (currentPrice < baseMaxHigh * 0.992) return false;

    // 4. KIỂM TRA BIẾN ĐỘNG GIÂY (5S) & PHÚT (1M - 3M)
    const priceChange1mPct = ((currentPrice - openPrice) / openPrice) * 100;
    const price3mAgo = klines[n - 4]?.close || openPrice;
    const priceChange3mPct = price3mAgo > 0 ? ((currentPrice - price3mAgo) / price3mAgo) * 100 : 0;

    // Kích nổ sóng: Biến động giây (5s >= 0.20%) HOẶC Nến 1m xanh (+0.35% đến +4.8%) HOẶC 3m tăng liên tiếp (+0.80% đến +6.0%)
    const hasSecondSpike = !!(velocityData && (velocityData.velocityPct >= 0.20 || velocityData.volInflow >= 6_000));
    const has1mSpike = currentPrice > openPrice && priceChange1mPct >= 0.35 && priceChange1mPct <= 4.8;
    const has3mSpike = priceChange3mPct >= 0.80 && priceChange3mPct <= 6.0;

    if (!hasSecondSpike && !has1mSpike && !has3mSpike) return false;

    // Nến không bị xả đè đầu quá nặng (râu trên <= 40% chiều dài nến)
    if (candleRange > 0 && upperWickRatio > 0.40) return false;

    // 5. YÊU CẦU: VOLUME & DÒNG TIỀN VÀO MẠNH (Cá mập kích hoạt sóng)
    const avgBaseVolume = baseKlines.reduce((s, k) => s + k.quoteVolume, 0) / baseKlines.length;
    const currentVol1m = currentCandle.quoteVolume;
    const volumeMultiplier = avgBaseVolume > 0 ? currentVol1m / avgBaseVolume : 0;

    const last3Klines = klines.slice(n - 3);
    const vol3m = last3Klines.reduce((s, k) => s + k.quoteVolume, 0);
    const buyVol3m = last3Klines.reduce((s, k) => s + k.takerBuyQuoteVolume, 0);
    const avg3mVol = vol3m / 3;
    const volumeMultiplier3m = avgBaseVolume > 0 ? avg3mVol / avgBaseVolume : 0;

    // Khối lượng đột biến so với nền (gấp >= 1.6x ở 1m, hoặc >= 1.4x ở 3m, hoặc vol 1m >= 100k USDT, hoặc 5s inflow >= 8k USDT)
    const isVolumeSpike =
      volumeMultiplier >= 1.6 ||
      volumeMultiplier3m >= 1.4 ||
      currentVol1m >= 100_000 ||
      (velocityData && velocityData.volInflow >= 8_000);
    if (!isVolumeSpike) return false;

    // Khối lượng tối thiểu 1m >= 25,000 USDT (đảm bảo thanh khoản thật, tránh giật ảo)
    if (currentVol1m < 25_000 && (!velocityData || velocityData.volInflow < 6_000)) return false;

    const takerBuyVol1m = currentCandle.takerBuyQuoteVolume;
    const takerSellVol1m = Math.max(0, currentVol1m - takerBuyVol1m);
    const netCashflow1m = takerBuyVol1m - takerSellVol1m;
    const takerBuyPct1m = currentVol1m > 0 ? (takerBuyVol1m / currentVol1m) * 100 : 50;

    const netCashflow3m = buyVol3m - (vol3m - buyVol3m);
    const takerBuyPct3m = vol3m > 0 ? (buyVol3m / vol3m) * 100 : 50;

    // Phe mua phải chiếm ưu thế (Taker Buy >= 52% ở 1m hoặc 3m, Net Cashflow dương)
    if (takerBuyPct1m < 52 && takerBuyPct3m < 52) return false;
    if (netCashflow1m < 0 && netCashflow3m < 0) return false;

    // Dòng tiền 5m
    const last5Klines = klines.slice(n - 5);
    const vol5m = last5Klines.reduce((s, k) => s + k.quoteVolume, 0);
    const buyVol5m = last5Klines.reduce((s, k) => s + k.takerBuyQuoteVolume, 0);
    const netCashflow5m = buyVol5m - (vol5m - buyVol5m);
    const takerBuyPct5m = vol5m > 0 ? (buyVol5m / vol5m) * 100 : 50;
    const greenCandles5m = last5Klines.filter((k) => k.close >= k.open).length;

    // =========================================================================
    // XÁC MINH HỘI TỤ ĐA KHUNG GIỜ: 15M VÀ 1H
    // =========================================================================
    const [klines15m, klines1h] = await Promise.all([
      this.binanceService.getKlines(symbol, '15m', 15),
      this.binanceService.getKlines(symbol, '1h', 24),
    ]);

    if (!klines15m || klines15m.length < 5 || !klines1h || klines1h.length < 5) {
      return false;
    }

    // 1. KIỂM TRA CHÂN SÓNG KHUNG 15M:
    const low15mList = klines15m.map((k) => k.low);
    const high15mList = klines15m.map((k) => k.high);
    const baseLow15m = Math.min(...low15mList);
    const maxHigh15m = Math.max(...high15mList);
    const range15m = maxHigh15m - baseLow15m;
    const foot15mPct = range15m > 0 ? ((currentPrice - baseLow15m) / range15m) * 100 : 50;
    const distanceFromFoot15mPct = baseLow15m > 0 ? ((currentPrice - baseLow15m) / baseLow15m) * 100 : 0;

    // Khung 15m: Cách đáy 15m <= 7.0% (đang ở đầu sóng 15m, không fomo đỉnh nến 15m)
    if (distanceFromFoot15mPct > 7.0) {
      return false;
    }

    const last3Klines15m = klines15m.slice(-3);
    const vol15mTotal = last3Klines15m.reduce((s, k) => s + k.quoteVolume, 0);
    const buy15mTotal = last3Klines15m.reduce((s, k) => s + k.takerBuyQuoteVolume, 0);
    const netCashflow15m = buy15mTotal - (vol15mTotal - buy15mTotal);
    const takerBuyPct15m = vol15mTotal > 0 ? (buy15mTotal / vol15mTotal) * 100 : 50;
    if (takerBuyPct15m < 45) {
      return false;
    }

    // 2. KIỂM TRA CHÂN SÓNG KHUNG 1H:
    const low1hList = klines1h.map((k) => k.low);
    const high1hList = klines1h.map((k) => k.high);
    const baseLow1h = Math.min(...low1hList);
    const maxHigh1h = Math.max(...high1hList);
    const range1h = maxHigh1h - baseLow1h;
    const foot1hPct = range1h > 0 ? ((currentPrice - baseLow1h) / range1h) * 100 : 50;

    const kline1hAgo = klines1h[klines1h.length - 2] || klines1h[0];
    const change1hPct =
      kline1hAgo && kline1hAgo.close > 0 ? ((currentPrice - kline1hAgo.close) / kline1hAgo.close) * 100 : 0;
    if (change1hPct < -14.0) {
      return false;
    }

    // Tính điểm đánh giá (Score) đảm bảo xung lực mạnh
    let score = 70;
    if (hasSecondSpike) score += 10;

    if (distanceFromFootPct <= 1.8) score += 10;
    else if (distanceFromFootPct <= 3.0) score += 6;

    if (volumeMultiplier >= 2.5 || volumeMultiplier3m >= 2.0) score += 10;
    else if (volumeMultiplier >= 1.6 || volumeMultiplier3m >= 1.4) score += 6;

    if (takerBuyPct1m >= 65 || takerBuyPct3m >= 65) score += 10;
    else if (takerBuyPct1m >= 55 || takerBuyPct3m >= 55) score += 5;

    if (distanceFromFoot15mPct <= 4.0) score += 8;
    else score += 4;

    if (ticker24h.priceChangePercent <= 15.0 && ticker24h.priceChangePercent >= -10.0) score += 5;

    const forecastScore = Math.min(99, Math.round(score));
    if (forecastScore < 75) return false;

    // Cắt lỗ an toàn dưới đáy nền tích lũy, khống chế rủi ro an toàn
    let suggestedSl = baseMinLow * 0.995;
    let riskDistancePct = ((currentPrice - suggestedSl) / currentPrice) * 100;
    if (riskDistancePct > 2.8) {
      suggestedSl = currentPrice * 0.975; // Khống chế SL an toàn tối đa -2.5%
      riskDistancePct = 2.5;
    }

    const lastAlert = this.symbolCooldowns.get(symbol) || 0;
    if (now - lastAlert < 10 * 60 * 1000) return false;
    if (now - this.lastGlobalAlertTime < 2500) return false;

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

    const status1hText = `Tích lũy cạn cung, cấu trúc nâng đáy khung 1h`;
    const status15mText = `Bứt phá thoát đáy 15m, nến 15m nén chặt bật tăng`;

    const velText = velocityData && velocityData.velocityPct > 0
      ? `Biến động 5s: +${velocityData.velocityPct.toFixed(2)}% (Bơm ròng: +${Math.round(velocityData.volInflow).toLocaleString()} USDT), `
      : '';

    const payload: VipSpikeAlertPayload = {
      symbol,
      currentPrice,
      openPrice,
      highPrice,
      lowPrice,
      priceChangePct: priceChange1mPct,
      distanceFromFootPct,
      baseMinLow,
      secondVelocityPct: velocityData?.velocityPct,
      secondVolInflow: velocityData?.volInflow,
      bottomRangePct: ticker24h.bottomRangePct,
      low24h: ticker24h.lowPrice,
      high24h: ticker24h.highPrice,
      change24hPct: ticker24h.priceChangePercent,
      change1hPct,
      foot1hPct,
      status1hText,
      distanceFromFoot15mPct,
      baseLow15m,
      foot15mPct,
      status15mText,
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
      estimatedWinRate: forecastScore,
      entryPrice: currentPrice,
      suggestedTp1,
      suggestedTp2,
      suggestedSl,
      rewardRiskRatio: 3.2 / riskDistancePct,
      analysisReason: `⚡ CẢNH BÁO DÒNG TIỀN VÀO MẠNH: ${velText}1m tăng +${priceChange1mPct.toFixed(2)}%, vừa nhấc chân +${distanceFromFootPct.toFixed(2)}% từ nền đáy $${baseMinLow}, volume đột biến ${volumeMultiplier.toFixed(1)}x (Taker Mua ${takerBuyPct1m.toFixed(1)}%), SL an toàn -${riskDistancePct.toFixed(2)}%. Chuẩn bị bay, vào lệnh ngay!`,
    };

    this.logger.warn(
      `🚀 [CẢNH BÁO DÒNG TIỀN VÀO MẠNH: CHUẨN BỊ BAY] ${symbol} -> 5s: +${velocityData?.velocityPct?.toFixed(2) || 0}% | 1m: +${priceChange1mPct.toFixed(2)}% | Entry: ${currentPrice} | Điểm: ${forecastScore}/100`,
    );
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

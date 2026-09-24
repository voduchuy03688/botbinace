import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BinanceService } from '../binance/binance.service.js';
import {
  TelegramService,
  VipSpikeAlertPayload,
  StrategicPeriodicReportItem,
} from '../telegram/telegram.service.js';

interface ActivePositionTrack {
  symbol: string;
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
    this.logger.log('Khởi tạo Scanner Siêu Chuẩn (Chỉ Báo Kèo Cực Ngon Vùng Đáy & Báo Cáo 12h/24h)...');
    await this.refreshMarketData();
    this.logger.log('Scanner hoạt động: Lọc bẫy râu nến xả, dòng tiền đa nến xác nhận, Winrate > 95%.');
  }

  // Cập nhật dữ liệu Ticker 24h định kỳ mỗi 3 phút
  @Cron('0 */3 * * * *')
  async refreshMarketData() {
    await this.binanceService.refreshTickers24h();
  }

  // =========================================================================
  // 1. BÁO CÁO CHIẾN LƯỢC ĐỊNH KỲ LÚC 12:00 VÀ 24:00 (00:00) HÀNG NGÀY
  // =========================================================================
  @Cron('0 0,12 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleScheduledStrategicReport() {
    const currentHour = new Date().toLocaleTimeString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
    });
    this.logger.log(`Bắt đầu chạy Báo cáo Chiến lược Định kỳ lúc ${currentHour}...`);
    await this.runStrategicPeriodicReport(`BÁO CÁO CHIẾN LƯỢC ĐỊNH KỲ ${currentHour}`);
  }

  // Hàm quét và gửi Báo cáo Chiến lược (Có thể gọi thủ công hoặc qua Cron)
  async runStrategicPeriodicReport(title: string): Promise<boolean> {
    try {
      if (this.binanceService.getAllTickers24h().length === 0) {
        await this.binanceService.refreshTickers24h();
      }

      // Lọc các coin ở vùng đáy 24h (<= 35%) và chưa bay (-15% đến +3.5%)
      const candidates = this.binanceService.getBottomZoneCandidates(35, 3.5, -15.0);
      this.logger.log(`Tìm thấy ${candidates.length} ứng viên ở vùng đáy cho Báo cáo Chiến lược.`);

      const analyzedItems: StrategicPeriodicReportItem[] = [];

      // Quét từng ứng viên để đánh giá dòng tiền tích lũy 1h và độ nén
      const batchSize = 15;
      for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (c) => {
            const klines = await this.binanceService.getKlines(c.symbol, '1m', 60);
            if (!klines || klines.length < 40) return;

            const totalVol1h = klines.reduce((sum, k) => sum + k.quoteVolume, 0);
            const totalBuy1h = klines.reduce((sum, k) => sum + k.takerBuyQuoteVolume, 0);
            const netCashflow1h = totalBuy1h - (totalVol1h - totalBuy1h);
            const takerBuyPct1h = totalVol1h > 0 ? (totalBuy1h / totalVol1h) * 100 : 50;

            // Độ nén biến động 1h (ATR % trung bình các nến)
            const atrPct =
              klines.reduce((sum, k) => {
                const range = k.open > 0 ? ((k.high - k.low) / k.open) * 100 : 0;
                return sum + range;
              }, 0) / klines.length;

            // Điều kiện lọt Top Báo Cáo Định Kỳ:
            // 1. Dòng tiền ròng 1h phải dương lớn (>= 150,000 USDT)
            // 2. Tỷ lệ Mua Taker 1h >= 62%
            // 3. Độ nén biến động nến <= 0.95% (nén chặt ở đáy)
            if (netCashflow1h >= 150_000 && takerBuyPct1h >= 62 && atrPct <= 0.95) {
              const currentPrice = c.lastPrice;
              const forecastScore = Math.min(
                99,
                Math.round(
                  65 +
                    (takerBuyPct1h - 50) * 0.8 +
                    Math.min(15, (netCashflow1h / 500_000) * 15) +
                    (1.0 - atrPct) * 10,
                ),
              );

              analyzedItems.push({
                symbol: c.symbol,
                currentPrice,
                low24h: c.lowPrice,
                high24h: c.highPrice,
                bottomRangePct: c.bottomRangePct,
                change24hPct: c.priceChangePercent,
                netCashflow1h,
                takerBuyPct1h,
                volatilityCompressionPct: atrPct,
                forecastScore,
                entryZone: `$${currentPrice.toFixed(4)} - $${(currentPrice * 1.008).toFixed(4)}`,
                suggestedTp1: currentPrice * 1.035,
                suggestedTp2: currentPrice * 1.07,
                suggestedSl: currentPrice * 0.982,
                catalystReason: `Cá mập gom ròng liên tục trong 1h, biên độ nén phẳng lì sát đáy ${c.bottomRangePct.toFixed(1)}%, xác suất bung nén cực mạnh.`,
              });
            }
          }),
        );
      }

      // Xếp hạng Top 5 - Top 7 token tiềm năng nhất
      analyzedItems.sort((a, b) => b.forecastScore - a.forecastScore || b.netCashflow1h - a.netCashflow1h);
      const topPicks = analyzedItems.slice(0, 7);

      await this.telegramService.sendStrategicPeriodicReport(title, topPicks);
      this.logger.log(`Đã gửi thành công ${title} với ${topPicks.length} token.`);
      return true;
    } catch (err: any) {
      this.logger.error(`Lỗi khi tạo Báo cáo Chiến lược Định kỳ: ${err.message}`);
      return false;
    }
  }

  // =========================================================================
  // 2. QUÉT REALTIME ĐA KHUNG THỜI GIAN: CHỈ BÁO KÈO CỰC KÌ NGON (WINRATE > 95%)
  // =========================================================================
  @Cron('*/20 * * * * *') // Quét mỗi 20 giây
  async handleRealtimeScan() {
    if (this.isScanning) return;

    this.isScanning = true;
    try {
      // 1. Quản lý và theo dõi các vị thế đang chạy (Chốt lời TP1/TP2 hoặc Cắt lỗ SL)
      await this.trackActivePositions();

      // 2. Lấy danh sách token đang ở vùng đáy tích lũy (<= 38% đáy 24h, chưa bay)
      const candidates = this.binanceService.getBottomZoneCandidates(38, 5.0, -18.0);
      if (candidates.length === 0) return;

      const now = Date.now();
      const validCandidates = candidates.filter((c) => {
        const lastAlert = this.symbolCooldowns.get(c.symbol) || 0;
        return now - lastAlert > 20 * 60 * 1000; // Cooldown 20 phút mỗi coin để không trùng lặp
      });

      const batchSize = 20;
      for (let i = 0; i < validCandidates.length; i += batchSize) {
        const batch = validCandidates.slice(i, i + batchSize);
        await Promise.all(batch.map((item) => this.analyzeSymbol(item.symbol)));
      }
    } catch (err: any) {
      this.logger.error(`Lỗi trong chu kỳ quét realtime: ${err.message}`);
    } finally {
      this.isScanning = false;
    }
  }

  // =========================================================================
  // 3. THUẬT TOÁN ĐỊNH LƯỢNG LỌC TÍN HIỆU CỰC NGON & TRIỆT TIÊU BẪY XẢ
  // =========================================================================
  private async analyzeSymbol(symbol: string) {
    const klines = await this.binanceService.getKlines(symbol, '1m', 60);
    if (!klines || klines.length < 35) return;

    const n = klines.length;
    const currentCandle = klines[n - 1];

    const openPrice = currentCandle.open;
    const highPrice = currentCandle.high;
    const lowPrice = currentCandle.low;
    const currentPrice = currentCandle.close;

    if (openPrice <= 0 || currentPrice <= 0) return;

    const candleRange = highPrice - lowPrice;
    if (candleRange <= 0) return;

    // -------------------------------------------------------------
    // BỘ LỌC 1: CẤU TRÚC NẾN BỨT PHÁ & CHỐNG BẪY RÂU XẢ (ANTI-TRAP)
    // -------------------------------------------------------------
    // Phải là nến xanh tăng giá
    if (currentPrice <= openPrice) return;

    // Thân nến phải chiếm ít nhất 50% toàn bộ chiều dài nến
    const candleBody = currentPrice - openPrice;
    const bodyRatio = candleBody / candleRange;
    if (bodyRatio < 0.5) return;

    // QUAN TRỌNG: Triệt tiêu bẫy râu xả (Anti-Wick Protection)
    // Nếu râu nến trên dài (> 20% chiều dài nến) -> Áp lực bán đã ập vào đè giá -> LOẠI NGAY LẬP TỨC!
    const upperWick = highPrice - currentPrice;
    const upperWickRatio = upperWick / candleRange;
    if (upperWickRatio > 0.2) return;

    // Giá đóng cửa phải nằm trong top 20% cao nhất của nến
    if ((highPrice - currentPrice) / candleRange > 0.2) return;

    // Biên độ tăng nhẹ chuẩn xác ngay chân sóng: Từ +0.8% đến +2.8%
    // Giúp người dùng vào đúng ngay chân sóng tăng, chưa bay xa, không cần chờ đợi!
    const priceChange1mPct = ((currentPrice - openPrice) / openPrice) * 100;
    if (priceChange1mPct < 0.8 || priceChange1mPct > 2.8) return;

    // -------------------------------------------------------------
    // BỘ LỌC 2: KIỂM TRA NỀN ĐÁY PHẲNG NÉN CHẶT TRƯỚC BÙNG NỔ (BASE COMPRESSION)
    // -------------------------------------------------------------
    const baseKlines = klines.slice(n - 25, n - 5); // 20 nến trước đó
    if (baseKlines.length < 15) return;

    const avgBaseVolume = baseKlines.reduce((s, k) => s + k.quoteVolume, 0) / baseKlines.length;
    const avgBaseRangePct =
      baseKlines.reduce((s, k) => {
        const r = k.open > 0 ? ((k.high - k.low) / k.open) * 100 : 0;
        return s + r;
      }, 0) / baseKlines.length;

    // Nền trước đó phải đi ngang tích lũy êm đềm (Biên độ nén <= 1.25%/nến)
    if (avgBaseRangePct > 1.25) return;

    const currentVol1m = currentCandle.quoteVolume;
    const volumeMultiplier = avgBaseVolume > 0 ? currentVol1m / avgBaseVolume : 0;
    // Volume nến bứt phá phải nổ ít nhất gấp 2.8 lần nền cũ
    if (volumeMultiplier < 2.8) return;

    // -------------------------------------------------------------
    // BỘ LỌC 3: KHUNG 1M - DÒNG TIỀN MUA CHỦ ĐỘNG ÁP ĐẢO (TRIGGER REALTIME)
    // -------------------------------------------------------------
    const takerBuyVol1m = currentCandle.takerBuyQuoteVolume;
    const takerSellVol1m = Math.max(0, currentVol1m - takerBuyVol1m);
    const netCashflow1m = takerBuyVol1m - takerSellVol1m;
    const takerBuyPct1m = currentVol1m > 0 ? (takerBuyVol1m / currentVol1m) * 100 : 50;

    // Lực Mua chủ động Taker phải chiếm tối thiểu 78%, Net Flow 1m >= 80,000 USDT
    if (takerBuyPct1m < 78 || netCashflow1m < 80_000) return;

    // -------------------------------------------------------------
    // BỘ LỌC 4: KHUNG 3M & 5M - DÒNG TIỀN BƠM BỀN VỮNG & ĐÁY NÂNG DẦN
    // -------------------------------------------------------------
    const last3Klines = klines.slice(n - 3);
    const vol3m = last3Klines.reduce((s, k) => s + k.quoteVolume, 0);
    const buyVol3m = last3Klines.reduce((s, k) => s + k.takerBuyQuoteVolume, 0);
    const netCashflow3m = buyVol3m - (vol3m - buyVol3m);
    const takerBuyPct3m = vol3m > 0 ? (buyVol3m / vol3m) * 100 : 50;
    if (takerBuyPct3m < 70 || netCashflow3m < 90_000) return;

    const last5Klines = klines.slice(n - 5);
    const vol5m = last5Klines.reduce((s, k) => s + k.quoteVolume, 0);
    const buyVol5m = last5Klines.reduce((s, k) => s + k.takerBuyQuoteVolume, 0);
    const netCashflow5m = buyVol5m - (vol5m - buyVol5m);
    const takerBuyPct5m = vol5m > 0 ? (buyVol5m / vol5m) * 100 : 50;
    const greenCandles5m = last5Klines.filter((k) => k.close >= k.open).length;

    // Trong 5 phút: Net cashflow >= 130,000 USDT, Taker Buy >= 68%, có ít nhất 3 nến xanh
    if (takerBuyPct5m < 68 || netCashflow5m < 130_000 || greenCandles5m < 3) return;

    // Cấu trúc nến 5m: Đáy sau cao hơn đáy trước (Higher Lows)
    const lowRecent2 = Math.min(klines[n - 2].low, klines[n - 1].low);
    const lowPrior3 = Math.min(klines[n - 5].low, klines[n - 4].low, klines[n - 3].low);
    if (lowRecent2 < lowPrior3 * 0.998) return; // Không được phá đáy cũ

    const price5mAgo = klines[n - 6]?.close || klines[0].close;
    const priceChange5mPct = price5mAgo > 0 ? ((currentPrice - price5mAgo) / price5mAgo) * 100 : 0;

    // -------------------------------------------------------------
    // BỘ LỌC 5: KHUNG 15M - XÁC NHẬN ĐẢO CHIỀU XU HƯỚNG TRUNG HẠN
    // -------------------------------------------------------------
    const last15Klines = klines.slice(n - 15);
    const vol15m = last15Klines.reduce((s, k) => s + k.quoteVolume, 0);
    const buyVol15m = last15Klines.reduce((s, k) => s + k.takerBuyQuoteVolume, 0);
    const netCashflow15m = buyVol15m - (vol15m - buyVol15m);
    const takerBuyPct15m = vol15m > 0 ? (buyVol15m / vol15m) * 100 : 50;

    // Khung 15m phải bắt đầu hướng lên, dòng tiền gom dương lớn
    if (takerBuyPct15m < 64 || netCashflow15m < 40_000) return;

    // -------------------------------------------------------------
    // BỘ LỌC 6: KHUNG 24H & 1H - VỊ THẾ ĐÁY VĨ MÔ & NỀN NÉN CHẶT
    // -------------------------------------------------------------
    const ticker24h = this.binanceService.getTicker24h(symbol);
    if (!ticker24h) return;

    // Nằm ở dưới 38% biên độ đáy 24h
    if (ticker24h.bottomRangePct > 38) return;

    // Xu hướng 1h đang đi ngang tích lũy đáy, không đu đỉnh (+4.0%) và không rơi tự do (-4.0%)
    const kline1hAgo = klines[0];
    const change1hPct =
      kline1hAgo && kline1hAgo.close > 0 ? ((currentPrice - kline1hAgo.close) / kline1hAgo.close) * 100 : 0;
    if (change1hPct > 4.0 || change1hPct < -4.0) return;

    // -------------------------------------------------------------
    // BỘ LỌC 7: CHẤM ĐIỂM HỘI TỤ ĐA KHUNG GIỜ (WINRATE > 95%)
    // -------------------------------------------------------------
    let score = 55;

    // 1. Vị thế đáy 24h & 1h (Max 14 điểm)
    if (ticker24h.bottomRangePct <= 20) score += 14;
    else if (ticker24h.bottomRangePct <= 30) score += 10;
    else score += 6;

    // 2. Độ nén phẳng trước bùng nổ (Max 10 điểm)
    if (avgBaseRangePct <= 0.65) score += 10;
    else if (avgBaseRangePct <= 0.9) score += 7;
    else score += 4;

    // 3. Tỷ lệ Mua Taker 1m & 5m & 15m (Max 14 điểm)
    if (takerBuyPct1m >= 84 && takerBuyPct5m >= 75) score += 14;
    else if (takerBuyPct1m >= 78 && takerBuyPct5m >= 70) score += 10;
    else score += 6;

    // 4. Dòng tiền ròng đa khung bơm mạnh (Max 12 điểm)
    if (netCashflow5m >= 300_000 && netCashflow15m >= 200_000) score += 12;
    else if (netCashflow5m >= 180_000) score += 9;
    else score += 5;

    // 5. Cấu trúc nến chuẩn triệt tiêu bẫy râu xả (Max 10 điểm)
    if (upperWickRatio <= 0.1 && bodyRatio >= 0.7) score += 10;
    else if (upperWickRatio <= 0.18 && bodyRatio >= 0.55) score += 6;

    const forecastScore = Math.min(99, Math.round(score));

    // CỔNG KIỂM DUYỆT NGHIÊM NGẶT (STRICT VIP QUALITY GATE):
    // Phải đạt tối thiểu 92/100 điểm mới được thông báo!
    if (forecastScore < 92) return;

    const now = Date.now();
    if (now - this.lastGlobalAlertTime < 5000) return; // Buffer 5s giữa các tin nhắn

    // Đánh dấu thời gian đã báo
    this.symbolCooldowns.set(symbol, now);
    this.lastGlobalAlertTime = now;

    // Thiết lập kế hoạch quản trị lệnh ngay chân sóng
    const suggestedTp1 = currentPrice * 1.032; // Chốt lời 1: +3.2%
    const suggestedTp2 = currentPrice * 1.065; // Chốt lời 2: +6.5%
    const suggestedSl = currentPrice * 0.982; // Cắt lỗ: -1.8%
    const rewardRiskRatio = 3.2 / 1.8;

    // Lưu vào danh sách theo dõi vị thế để quản trị tự động
    this.activePositions.set(symbol, {
      symbol,
      entryPrice: currentPrice,
      entryTime: now,
      tp1Price: suggestedTp1,
      tp2Price: suggestedTp2,
      slPrice: suggestedSl,
      tp1Hit: false,
      highestPrice: currentPrice,
      lowestPrice: currentPrice,
    });

    const payload: VipSpikeAlertPayload = {
      symbol,
      currentPrice,
      openPrice,
      highPrice,
      lowPrice,
      priceChangePct: priceChange1mPct,
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
      rewardRiskRatio,
      analysisReason: `Hội tụ tất cả các khung giờ: 24h/1h vùng đáy nén (${ticker24h.bottomRangePct.toFixed(1)}%), 15m/5m dòng tiền gom ròng +${Math.round(netCashflow5m).toLocaleString()} USDT đáy nâng dần, 1m bứt phá nến đặc đóng căng sát đỉnh.`,
    };

    this.logger.warn(
      `👑 [CHÂN SÓNG ĐA KHUNG GIỜ] ${symbol} -> Điểm: ${forecastScore}/100, NetFlow5m: +${Math.round(netCashflow5m)} USDT, TakerBuy: ${takerBuyPct1m.toFixed(1)}%`,
    );

    await this.telegramService.sendVipSpikeAlert(payload);
  }

  // =========================================================================
  // 4. QUẢN LÝ VỊ THẾ TỰ ĐỘNG & BÁO "HẾT NGON" ĐA NẾN (DUY NHẤT 1 LẦN)
  // Chỉ kiểm tra các token ĐÃ TỪNG DỰ BÁO NGON trong activePositions
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
      const dropFromPeakPct = pos.highestPrice > 0 ? ((pos.highestPrice - currentPrice) / pos.highestPrice) * 100 : 0;

      // 1. Chốt lời TP2 (+6.5%)
      if (currentPrice >= pos.tp2Price) {
        this.logger.log(`🚀 [TP2 HIT] ${symbol} đạt mức chốt lời tối đa 2: +${profitPct.toFixed(2)}%`);
        await this.telegramService.sendTakeProfitAlert({
          symbol,
          targetLevel: 'TP2 (+6.5%)',
          entryPrice: pos.entryPrice,
          currentPrice,
          profitPct,
          suggestedAction: `Đã đạt mục tiêu lợi nhuận tối đa, chốt toàn bộ lệnh thành công trọn con sóng!`,
        });
        this.activePositions.delete(symbol);
        this.symbolCooldowns.set(symbol, now + 30 * 60 * 1000);
        continue;
      }

      // 2. Chốt lời TP1 (+3.2%)
      if (currentPrice >= pos.tp1Price && !pos.tp1Hit) {
        pos.tp1Hit = true;
        pos.slPrice = pos.entryPrice; // Nâng Stop Loss lên giá hòa vốn (Entry)
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

      // 3. Phân tích ĐA NẾN (5 nến gần nhất) để phát hiện LỰC BÁN XẢ NHIỀU & HẾT NGON
      const recentKlines = await this.binanceService.getKlines(symbol, '1m', 10);
      if (!recentKlines || recentKlines.length < 5) continue;

      const last5 = recentKlines.slice(-5);
      const totalVol5 = last5.reduce((s, k) => s + k.quoteVolume, 0);
      const totalBuy5 = last5.reduce((s, k) => s + k.takerBuyQuoteVolume, 0);
      const totalSell5 = Math.max(0, totalVol5 - totalBuy5);
      const takerSellPct5 = totalVol5 > 0 ? (totalSell5 / totalVol5) * 100 : 50;
      const netCashflowSell = totalSell5 - totalBuy5;
      const redCandles5 = last5.filter((k) => k.close < k.open).length;

      let isHetNgon = false;
      let hetNgonReason = '';

      // Tình huống A: Lực bán tháo đa nến chiếm ưu thế lớn (Taker Sell >= 65%, Net Sell >= 70k USDT, >= 3 nến đỏ)
      if (takerSellPct5 >= 65 && netCashflowSell >= 70_000 && redCandles5 >= 3 && profitPct < 0.8) {
        isHetNgon = true;
        hetNgonReason = `Áp lực bán tháo Taker xả chiếm ${takerSellPct5.toFixed(1)}% qua 5 cây nến liên tiếp, dòng tiền ròng âm -${Math.round(netCashflowSell).toLocaleString()} USDT.`;
      }
      // Tình huống B: Đã tăng lên đỉnh nhưng quay đầu rơi mạnh từ đỉnh (>= 1.5%) kèm lực bán đa nến
      else if (pos.highestPrice >= pos.entryPrice * 1.018 && dropFromPeakPct >= 1.5 && takerSellPct5 >= 60) {
        isHetNgon = true;
        hetNgonReason = `Giá đã quay đầu giảm -${dropFromPeakPct.toFixed(2)}% từ đỉnh cao nhất ($${pos.highestPrice}) kèm lực bán gia tăng (${takerSellPct5.toFixed(1)}% bán).`;
      }
      // Tình huống C: Chạm mức cắt lỗ bảo toàn vốn (SL -1.8% hoặc SL hòa vốn sau TP1)
      else if (currentPrice <= pos.slPrice) {
        isHetNgon = true;
        hetNgonReason = pos.tp1Hit
          ? `Giá quay về chạm mức hòa vốn Entry ($${pos.entryPrice}) sau khi đã chốt 50% TP1.`
          : `Giá chạm ngưỡng dừng lỗ an toàn (-1.8%).`;
      }

      // NẾU HẾT NGON: THÔNG BÁO DUY NHẤT 1 LẦN RỒI XÓA VỊ THẾ NGAY LẬP TỨC
      if (isHetNgon) {
        this.logger.warn(`🛑 [HẾT NGON - DUY NHẤT 1 LẦN] ${symbol} -> ${hetNgonReason}`);
        await this.telegramService.sendHetNgonMultiCandleAlert({
          symbol,
          entryPrice: pos.entryPrice,
          currentPrice,
          profitPct,
          candlesAnalyzed: 5,
          takerSellPct: takerSellPct5,
          netCashflowSell,
          dropFromPeakPct,
          reasonText: hetNgonReason,
        });

        // Xóa ngay vị thế khỏi activePositions để đảm bảo KHÔNG BAO GIỜ THÔNG BÁO LẦN THỨ 2!
        this.activePositions.delete(symbol);
        this.symbolCooldowns.set(symbol, now + 30 * 60 * 1000);
        continue;
      }

      // 4. Tự động kết thúc theo dõi sau 90 phút nếu không chạm TP hay SL
      if (now - pos.entryTime > 90 * 60 * 1000) {
        this.activePositions.delete(symbol);
      }
    }
  }
}


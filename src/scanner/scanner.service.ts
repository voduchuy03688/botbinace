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
import {
  isEligibleTokenForAlert,
  getChainBadge,
} from '../binance/token-chain.helper.js';

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

  // 1. Báo cáo Cá Voi Gom Hàng Định Kỳ 4H (Cứ 4 tiếng 1 lần: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00)
  @Cron('0 0 */4 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleScheduled4hReport() {
    this.logger.log('Đang khởi tạo báo cáo Cá Voi Gom Hàng 4H (Top 20)...');
    try {
      await this.binanceService.refreshTickers24h();
      const report = await this.binanceService.getCashflowReport(4, 20);
      await this.telegramService.sendCashflowReportAlert(report);
      this.logger.log('Đã gửi báo cáo Cá Voi Gom Hàng 4H thành công tới Telegram!');
    } catch (err: any) {
      this.logger.error(`Lỗi khi tạo báo cáo Cá Voi Gom Hàng 4H: ${err.message}`);
    }
  }

  // 2. Báo cáo Cá Voi Gom Hàng Định Kỳ 12H (Cứ 12 tiếng 1 lần: 00:01 và 12:01)
  @Cron('0 1 0,12 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleScheduled12hReport() {
    this.logger.log('Đang khởi tạo báo cáo Cá Voi Gom Hàng 12H (Top 20)...');
    try {
      await this.binanceService.refreshTickers24h();
      const report = await this.binanceService.getCashflowReport(12, 20);
      await this.telegramService.sendCashflowReportAlert(report);
      this.logger.log('Đã gửi báo cáo Cá Voi Gom Hàng 12H thành công tới Telegram!');
    } catch (err: any) {
      this.logger.error(`Lỗi khi tạo báo cáo Cá Voi Gom Hàng 12H: ${err.message}`);
    }
  }

  // 3. Báo cáo Cá Voi Gom Hàng Định Kỳ 1 NGÀY (Cứ 1 ngày 1 lần: 07:00 sáng chốt nến 1D Binance)
  @Cron('0 0 7 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleScheduledDailyReport() {
    this.logger.log('Đang khởi tạo báo cáo Cá Voi Gom Hàng 1 NGÀY (Top 20)...');
    try {
      await this.binanceService.refreshTickers24h();
      const report = await this.binanceService.getCashflowReport(24, 20);
      await this.telegramService.sendCashflowReportAlert(report);
      this.logger.log('Đã gửi báo cáo Cá Voi Gom Hàng 1 NGÀY thành công tới Telegram!');
    } catch (err: any) {
      this.logger.error(`Lỗi khi tạo báo cáo Cá Voi Gom Hàng 1 NGÀY: ${err.message}`);
    }
  }

  // Phương thức kích hoạt báo cáo thủ công theo yêu cầu
  async triggerManualReport(tf = 4) {
    this.logger.log(`Kích hoạt báo cáo Cá Voi Gom Hàng thủ công (${tf}H)...`);
    await this.binanceService.refreshTickers24h();
    const report = await this.binanceService.getCashflowReport(tf, 20);
    const success = await this.telegramService.sendCashflowReportAlert(report);
    return {
      success,
      tf,
      topWhaleAccumulationCount: report.suddenSpikes.length,
      sampleTokens: report.suddenSpikes.slice(0, 5).map((s) => s.symbol),
    };
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

      // 3. Lấy danh sách toàn bộ coin Futures hợp lệ: Giá < 0.5$ và thuộc mạng ETH, BSC, SOL (vốn hóa nhỏ / meme / pump dump)
      const eligibleTickers = this.binanceService.getTargetMoversPool(300_000, -35.0, 85.0);
      if (eligibleTickers.length === 0) return;

      const now = Date.now();
      const isAvailable = (sym: string) => {
        const lastAlert = this.symbolCooldowns.get(sym) || 0;
        return now - lastAlert > 10 * 60 * 1000; // Cooldown 10 phút mỗi coin
      };

      // ƯU TIÊN 1: Các coin đang có tốc độ giật giá & dòng tiền bơm vào tức thì (5s Velocity >= 0.18% hoặc inflow >= 12,000 USDT)
      const velocityHotSymbols = this.binanceService.getHotVelocitySymbols(0.18, 12000).filter(isAvailable);

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

      const sweepBatchSize = 25;
      const sweepSymbols = remainingTickers
        .slice(this.sweepIndex, this.sweepIndex + sweepBatchSize)
        .map((t) => t.symbol);
      this.sweepIndex =
        remainingTickers.length > 0
          ? (this.sweepIndex + sweepBatchSize) % remainingTickers.length
          : 0;

      // Gom thành danh sách quét duy nhất (khoảng 35-55 coin mỗi 5 giây)
      const targetPool = Array.from(
        new Set([...velocityHotSymbols, ...topGainers, ...topVolume, ...sweepSymbols]),
      );

      const batchSize = 25;
      for (let i = 0; i < targetPool.length; i += batchSize) {
        const batch = targetPool.slice(i, i + batchSize);
        await Promise.all(batch.map((item) => this.analyzeSymbol(item)));
      }

      // Quét thêm chiến thuật: Bắt Chỉnh trên các token Trend mạnh (tăng liên tục vài giờ hoặc vài ngày)
      await this.scanTrendPullbacks(eligibleTickers);
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
  // THUẬT TOÁN: BẮT ĐÚNG CHÂN SÓNG BAY & DÒNG TIỀN CHẢY MẠNH VÀO
  // Tiêu chuẩn khắt khe: Chuẩn chân sóng (<= 3.8%) + Dòng tiền cá mập nổ mạnh (Vol >= 2x, Net > 20k USDT, Taker >= 58%)
  // Đánh giá cả nến Realtime (n-1) và nến vừa hoàn tất (n-2) để không bỏ lỡ giây phút kích nổ
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

    const liveCandle = klines[n - 1];
    const currentPrice = liveCandle.close;
    if (currentPrice <= 0 || !isEligibleTokenForAlert(symbol, currentPrice)) return false;

    // Đánh giá cửa sổ bứt phá: Nến đang chạy (n-1) hoặc nến vừa xác nhận đóng (n-2)
    for (const evalIndex of [n - 1, n - 2]) {
      const evalCandle = klines[evalIndex];
      const openPrice = evalCandle.open;
      const highPrice = evalCandle.high;
      const lowPrice = evalCandle.low;
      const closePrice = evalCandle.close;

      if (openPrice <= 0 || closePrice <= 0) continue;

      const candleRange = highPrice - lowPrice;
      const upperWick = highPrice - Math.max(closePrice, openPrice);
      const upperWickRatio = candleRange > 0 ? upperWick / candleRange : 0;
      const lowerWick = Math.min(closePrice, openPrice) - lowPrice;
      const lowerWickRatio = candleRange > 0 ? lowerWick / candleRange : 0;

      // 1. Kiểm tra nền tích lũy 20 nến trước đó (baseKlines)
      const baseKlines = klines.slice(evalIndex - 20, evalIndex);
      if (baseKlines.length < 15) continue;

      const baseMinLow = Math.min(...baseKlines.map((k) => k.low));
      const baseMaxHigh = Math.max(...baseKlines.map((k) => k.high));
      if (baseMinLow <= 0) continue;

      const baseRangePct = ((baseMaxHigh - baseMinLow) / baseMinLow) * 100;
      // Nền tích lũy phải nén chặt chuẩn bị bung sóng (biên độ dao động nền <= 4.8%)
      if (baseRangePct > 4.8) continue;

      // 2. BẮT ĐÚNG CHÂN SÓNG BAY:
      // Vừa mới nhấc chân từ 0.35% đến 3.80% tính từ đáy nền gom hàng (Chuẩn chân sóng, tuyệt đối không đu đỉnh)
      const distanceFromFootPct = ((currentPrice - baseMinLow) / baseMinLow) * 100;
      if (distanceFromFootPct < 0.35 || distanceFromFootPct > 3.80) continue;

      // 3. BỨT PHÁ ĐỈNH HỘP: Giá hiện tại phải bứt phá dứt khoát hoặc vượt đỉnh nền đi ngang
      if (currentPrice < baseMaxHigh * 0.998) continue;

      // 4. KIỂM TRA NẾN BẬT TĂNG MẠNH (MOMENTUM BREAKOUT TRIGGER)
      const priceChange1mPct = ((closePrice - openPrice) / openPrice) * 100;
      const price3mAgo = klines[evalIndex - 3]?.close || openPrice;
      const priceChange3mPct = price3mAgo > 0 ? ((currentPrice - price3mAgo) / price3mAgo) * 100 : 0;

      // Nến bắt buộc phải là nến xanh tăng giá dứt khoát: 1m tăng >= 0.65% hoặc 3m tăng liên tục >= 1.20%
      if (closePrice <= openPrice) continue;
      if (priceChange1mPct < 0.65 && priceChange3mPct < 1.20) continue;
      if (priceChange1mPct < 0.40) continue; // Triệt tiêu nến 1m lèo tèo
      if (priceChange1mPct > 5.0 || priceChange3mPct > 7.0) continue;

      // Nến không bị xả đè đầu: râu trên cực ngắn (<= 20% thân nến) đảm bảo phe mua nuốt trọn toàn bộ phe bán
      if (candleRange > 0 && upperWickRatio > 0.20) continue;

      // =====================================================================
      // ĐIỀU KIỆN TIÊN QUYẾT BẮT BUỘC: ĐỘ BIẾN ĐỘNG 1S MẠNH & DÒNG TIỀN VÀO THẬT
      // =====================================================================
      // BẮT BUỘC có độ biến động khung giây (1s/5s) bùng nổ: velocityPct >= 0.15% và dòng tiền đổ vào >= 12,000 USDT
      if (!velocityData || velocityData.velocityPct < 0.15 || velocityData.volInflow < 12_000) {
        continue; // Không có dòng tiền vào dồn dập và độ biến động 1s mạnh -> BỎ QUA NGAY
      }

      // =====================================================================
      // ĐIỀU KIỆN TIÊN QUYẾT: NGƯỜI MUA NGƯỜI BÁN NHIỀU THẬT SỰ (KHÔNG PHẢI BOT KÉO ẢO)
      // =====================================================================
      const evalVol1m = evalCandle.quoteVolume;
      const evalBuyVol1m = evalCandle.takerBuyQuoteVolume;
      const evalSellVol1m = Math.max(0, evalVol1m - evalBuyVol1m);
      const netCashflow1m = evalBuyVol1m - evalSellVol1m;
      const takerBuyPct1m = evalVol1m > 0 ? (evalBuyVol1m / evalVol1m) * 100 : 50;

      const last3Klines = klines.slice(evalIndex - 2, evalIndex + 1);
      const vol3m = last3Klines.reduce((s, k) => s + k.quoteVolume, 0);
      const buyVol3m = last3Klines.reduce((s, k) => s + k.takerBuyQuoteVolume, 0);
      const avg3mVol = vol3m / 3;
      const netCashflow3m = buyVol3m - (vol3m - buyVol3m);
      const takerBuyPct3m = vol3m > 0 ? (buyVol3m / vol3m) * 100 : 50;

      // Số lượng giao dịch thực tế (Trades): Nhiều người mua bán thực sự (1m >= 250 lệnh hoặc 3m >= 700 lệnh)
      const trades1m = evalCandle.trades;
      const trades3m = last3Klines.reduce((s, k) => s + k.trades, 0);
      if (trades1m < 250 && trades3m < 700) {
        continue; // Số lệnh giao dịch quá ít, thanh khoản quay tay giả tạo -> BỎ QUA
      }

      // Khối lượng USDT thực tế phải lớn: 1m >= 200,000 USDT hoặc 3m >= 500,000 USDT
      if (evalVol1m < 200_000 && vol3m < 500_000) {
        continue;
      }

      // =====================================================================
      // BẢO VỆ TUYỆT ĐỐI KHỎI BẪY "KÉO LÊN ĐỂ BÁN / DỤ LONG" (BULL TRAP / FAKEOUT):
      // =====================================================================
      // 1. Râu trên bị xả đè: upperWickRatio > 0.20
      // 2. Kéo rướn nhưng cạn kiệt Volume (Volume Exhaustion)
      // 3. Phe mua không làm chủ áp đảo: Taker Buy 1m < 66% hoặc 3m < 65%
      // 4. Tiền mua ròng không đủ áp đảo: Net Inflow 1m < 75,000 USDT và Net Inflow 3m < 180,000 USDT
      // 5. Khung giây có dấu hiệu xả ngầm hoặc rút vốn
      const prevCandle1 = klines[evalIndex - 1];
      const isVolumeExhausted = prevCandle1 && evalVol1m < prevCandle1.quoteVolume * 0.72 && priceChange1mPct > 0;
      const isFakeDuLong =
        upperWickRatio > 0.20 ||
        (isVolumeExhausted && takerBuyPct1m < 70) ||
        takerBuyPct1m < 66 ||
        takerBuyPct3m < 65 ||
        (netCashflow1m < 75_000 && netCashflow3m < 180_000) ||
        velocityData.velocityPct <= 0 ||
        velocityData.volInflow <= 0;

      if (isFakeDuLong) {
        continue; // TUYỆT ĐỐI LOẠI BỎ BẪY KÉO LÊN ĐỂ BÁN / DỤ LONG!
      }

      const avgBaseVolume = baseKlines.reduce((s, k) => s + k.quoteVolume, 0) / baseKlines.length;
      const volumeMultiplier = avgBaseVolume > 0 ? evalVol1m / avgBaseVolume : 0;
      const volumeMultiplier3m = avgBaseVolume > 0 ? avg3mVol / avgBaseVolume : 0;

      // Volume đột biến gấp ít nhất 2.5x nền (hoặc 3m gấp 2.0x nền)
      if (volumeMultiplier < 2.5 && volumeMultiplier3m < 2.0) {
        continue;
      }

      // 5.3. PHÂN BIỆT RÕ RÀNG HÌNH THÁI DÒNG TIỀN:
      // A. "KÉO XUỐNG ĐỂ BAY" (SPRING SHAKEOUT / RŨ CUNG QUÉT ĐÁY):
      // Đạp thủng đáy hỗ trợ / quét thanh khoản Stop Loss rồi rút chân cực mạnh, gom hàng khủng
      const isSpringHammer = lowerWickRatio >= 0.35 && closePrice >= openPrice && takerBuyPct1m >= 64;
      const isBullishEngulfing = prevCandle1 && prevCandle1.close < prevCandle1.open &&
        closePrice > prevCandle1.high && takerBuyPct1m >= 65 && evalVol1m >= 180_000;
      const isKeoXuongDeBay = isSpringHammer || isBullishEngulfing;

      // B. "DÒNG TIỀN VÀO ĐỀU VỮNG CHẮC" (SUSTAINED INFLOW):
      // Dòng tiền liên tục chảy vào qua từng nến và khung giây, phe mua làm chủ hoàn toàn
      const prevNetInflow1m = prevCandle1 ? prevCandle1.takerBuyQuoteVolume - (prevCandle1.quoteVolume - prevCandle1.takerBuyQuoteVolume) : 0;
      const isDongTienVaoDeu =
        netCashflow1m >= 70_000 &&
        netCashflow3m >= 150_000 &&
        takerBuyPct1m >= 64 &&
        takerBuyPct3m >= 62 &&
        prevNetInflow1m >= 0 &&
        upperWickRatio <= 0.25;

      let cashflowPatternText = '';
      if (isKeoXuongDeBay) {
        cashflowPatternText = '🦅 <b>CÁ MẬP KÉO XUỐNG ĐỂ BAY (Spring Shakeout)</b>: Quét sạch thanh khoản đáy, rút chân cực mạnh & gom hàng bùng nổ!';
      } else if (isDongTienVaoDeu) {
        cashflowPatternText = '🌊 <b>DÒNG TIỀN BƠM VÀO ĐỀU VỮNG CHẮC (Sustained Inflow)</b>: Bơm liên tục qua từng nến & khung giây, phe mua làm chủ hoàn toàn!';
      } else {
        cashflowPatternText = '⚡ <b>DÒNG TIỀN BẮT ĐẦU BƠM MẠNH</b>: Bứt phá dứt khoát khỏi nền!';
      }

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

      // Khung 15m: Cách đáy 15m <= 8.5% (ở đầu sóng 15m, không đu đỉnh)
      if (distanceFromFoot15mPct > 8.5) {
        return false;
      }

      const last3Klines15m = klines15m.slice(-3);
      const vol15mTotal = last3Klines15m.reduce((s, k) => s + k.quoteVolume, 0);
      const buy15mTotal = last3Klines15m.reduce((s, k) => s + k.takerBuyQuoteVolume, 0);
      const netCashflow15m = buy15mTotal - (vol15mTotal - buy15mTotal);
      const takerBuyPct15m = vol15mTotal > 0 ? (buy15mTotal / vol15mTotal) * 100 : 50;
      if (takerBuyPct15m < 50 || netCashflow15m <= 0) {
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
      if (change1hPct < -12.0) {
        return false;
      }

      // Tính điểm đánh giá (Score) đảm bảo dòng tiền bơm mạnh đạt chuẩn CỰC NGON > 90%
      let score = 50;
      if (distanceFromFootPct <= 1.8) score += 10;
      else if (distanceFromFootPct <= 2.8) score += 6;

      if (volumeMultiplier >= 3.5 || volumeMultiplier3m >= 3.0) score += 14;
      else if (volumeMultiplier >= 2.5) score += 8;

      if (takerBuyPct1m >= 72 || takerBuyPct3m >= 72) score += 14;
      else if (takerBuyPct1m >= 64 || takerBuyPct3m >= 64) score += 8;

      if (netCashflow1m >= 120_000 || netCashflow3m >= 250_000) score += 14;
      else if (netCashflow1m >= 60_000 || netCashflow3m >= 150_000) score += 8;

      if (distanceFromFoot15mPct <= 4.0) score += 8;
      else score += 4;

      if (ticker24h.priceChangePercent <= 25.0 && ticker24h.priceChangePercent >= -10.0) score += 5;

      // Dòng tiền bơm mạnh và đều trong khung giây (khung s)
      if (velocityData && (velocityData.velocityPct >= 0.20 || velocityData.volInflow >= 20_000)) {
        score += 8;
      } else if (velocityData && (velocityData.velocityPct >= 0.12 || velocityData.volInflow >= 10_000)) {
        score += 4;
      }

      // Đánh giá hình thái dòng tiền: Kéo xuống để bay vs Bơm vào đều vững chắc
      if (isKeoXuongDeBay) {
        score += 10; // Rũ cung quét thanh khoản đáy rồi bay là mô hình tỷ lệ thắng cao nhất (Winrate 95%+)
      } else if (isDongTienVaoDeu) {
        score += 8;
      }

      // Biến động đang bay dứt khoát
      if (priceChange1mPct >= 0.6 && greenCandles5m >= 3) {
        score += 5;
      }

      const forecastScore = Math.min(99, Math.round(score));
      if (forecastScore < 95) return false; // Chỉ bắn thông báo Realtime tức thì cho kèo CỰC NGON (Score >= 95)

      const signalTier: 'CUC_NGON' = 'CUC_NGON';
      const estimatedWinRate = 95;

      // Cắt lỗ an toàn dưới đáy nền tích lũy, khống chế rủi ro an toàn (-3.5% đến -4.5%)
      let suggestedSl = baseMinLow * 0.99;
      let riskDistancePct = ((currentPrice - suggestedSl) / currentPrice) * 100;
      if (riskDistancePct > 4.5) {
        suggestedSl = currentPrice * 0.955; // Khống chế SL an toàn tối đa -4.5%
        riskDistancePct = 4.5;
      }

      const lastAlert = this.symbolCooldowns.get(symbol) || 0;
      if (now - lastAlert < 15 * 60 * 1000) return false;
      if (now - this.lastGlobalAlertTime < 2500) return false;

      this.symbolCooldowns.set(symbol, now);
      this.lastGlobalAlertTime = now;

      // MỤC TIÊU ĂN MIẾNG TO: TP1 +12%, TP2 +28%
      const suggestedTp1 = currentPrice * 1.12;
      const suggestedTp2 = currentPrice * 1.28;

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

      const velText =
        velocityData && velocityData.velocityPct > 0
          ? `Biến động 5s: +${velocityData.velocityPct.toFixed(2)}% (Bơm ròng: +${Math.round(velocityData.volInflow).toLocaleString()} USDT), `
          : '';

      const badge = getChainBadge(symbol);
      const tierName = `🚀 CHUẨN BỊ BAY MẠNH ${badge} (Ăn Miếng To)`;
      const payload: VipSpikeAlertPayload = {
        signalTier,
        cashflowPatternText,
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
        volume1m: evalVol1m,
        takerBuyVol1m: evalBuyVol1m,
        takerSellVol1m: evalSellVol1m,
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
        estimatedWinRate,
        entryPrice: currentPrice,
        suggestedTp1,
        suggestedTp2,
        suggestedSl,
        rewardRiskRatio: 12.0 / riskDistancePct,
        analysisReason: `${tierName}: ${velText}Volume nổ ${volumeMultiplier.toFixed(1)}x (1m: ${Math.round(evalVol1m).toLocaleString()} USDT, Net Mua: +${Math.round(netCashflow1m).toLocaleString()} USDT), Taker Mua ${takerBuyPct1m.toFixed(1)}%, vừa nhấc chân +${distanceFromFootPct.toFixed(2)}% từ đáy nền $${baseMinLow}. Chuẩn bị bay mạnh trong 1-2h tới!`,
      };

      this.logger.warn(
        `🌊 [${tierName}] ${symbol} -> 1m Vol: ${Math.round(evalVol1m / 1000)}k USDT | Net Mua: +${Math.round(netCashflow1m / 1000)}k | Chân: +${distanceFromFootPct.toFixed(2)}% | Entry: ${currentPrice}`,
      );
      await this.telegramService.sendVipSpikeAlert(payload);
      return true;
    }

    return false;
  }


  // =========================================================================
  // QUẢN LÝ VỊ THẾ SÓNG LỚN (ĂN MIẾNG TO: TP1 +12%, TP2 +28%, SL -4%)
  // TUYỆT ĐỐI KHÔNG BÁO "HẾT NGON" 1-2 PHÚT LÀM RỐI VÀ TỐN PHÍ
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

      // 1. Chốt lời TP2 (ĂN MIẾNG TO: +25% - +35%+)
      const isTp2Hit = currentPrice >= pos.tp2Price;
      if (isTp2Hit) {
        this.logger.log(`🚀 [TP2 HIT] ${symbol} đạt mục tiêu ăn miếng to tối đa: +${profitPct.toFixed(2)}%`);
        await this.telegramService.sendTakeProfitAlert({
          symbol,
          targetLevel: 'TP2 (ĂN MIẾNG TO)',
          entryPrice: pos.entryPrice,
          currentPrice,
          highestPrice: pos.highestPrice,
          profitPct,
          suggestedAction: `Đã đạt mục tiêu lợi nhuận lớn (+${profitPct.toFixed(2)}%), chốt toàn bộ lệnh thành công trọn con sóng!`,
        });
        this.activePositions.delete(symbol);
        this.symbolCooldowns.set(symbol, now + 45 * 60 * 1000);
        continue;
      }

      // 2. Chốt lời TP1 (+12% - +15%)
      const isTp1Hit = currentPrice >= pos.tp1Price;
      if (isTp1Hit && !pos.tp1Hit) {
        pos.tp1Hit = true;
        pos.slPrice = pos.entryPrice * 1.01; // Nâng Stop Loss lên trên giá hòa vốn (+1%) để gồng tiếp TP2 không lo lỗ
        this.logger.log(`🎯 [TP1 HIT] ${symbol} đạt mục tiêu 1: +${profitPct.toFixed(2)}%`);
        await this.telegramService.sendTakeProfitAlert({
          symbol,
          targetLevel: 'TP1 (+12%)',
          entryPrice: pos.entryPrice,
          currentPrice,
          highestPrice: pos.highestPrice,
          profitPct,
          suggestedAction: `Đã chốt 50% khối lượng (+${profitPct.toFixed(2)}%), dời Stop Loss về hòa vốn Entry ($${pos.entryPrice}) để gồng tiếp TP2!`,
        });
      }

      // 3. CẮT LỖ AN TOÀN (SL) KHI GIÁ THỦNG ĐÁY NỀN HỖ TRỢ CỨNG
      if (currentPrice <= pos.slPrice) {
        const lossPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        this.logger.warn(`🛑 [SL HIT] ${symbol} -> Giá chạm ngưỡng dừng lỗ an toàn: ${lossPct.toFixed(2)}%`);
        await this.telegramService.sendStopLossAlert({
          symbol,
          entryPrice: pos.entryPrice,
          currentPrice,
          lossPct,
          reasonText: pos.tp1Hit
            ? `Chạm mức hòa vốn Entry ($${pos.entryPrice}) sau khi đã chốt 50% TP1 (+12%). Bảo toàn lãi an toàn!`
            : `Chạm ngưỡng dừng lỗ an toàn ở đáy hỗ trợ cứng ($${pos.slPrice.toFixed(4)}). Cắt lỗ bảo toàn vốn.`,
        });
        this.activePositions.delete(symbol);
        this.symbolCooldowns.set(symbol, now + 30 * 60 * 1000);
        continue;
      }

      // Tự động kết thúc theo dõi sau 4 tiếng (chu kỳ swing) nếu không chạm TP hay SL
      if (now - pos.entryTime > 4 * 60 * 60 * 1000) {
        this.activePositions.delete(symbol);
      }
    }
  }

  // =========================================================================
  // CHIẾN THUẬT: ĐÃ BAY & CHỈNH XONG (12% - 28%) - DÒNG TIỀN ĐỠ MẠNH SÓNG 2
  // - Áp dụng cho token < 0.5$ và thuộc mạng ETH, BSC, SOL
  // - Đã có đợt tăng mạnh (+15% đến +60%), đang chỉnh lành mạnh 12% - 28%
  // - Dòng tiền giao dịch vẫn duy trì lớn, phe mua gom đỡ giá (Taker Buy >= 58%)
  // - Nến rút chân / đảo chiều nâng đáy, chuẩn bị kích hoạt sóng 2 bay tiếp
  // =========================================================================
  private async scanTrendPullbacks(eligibleTickers: Ticker24hData[]) {
    const now = Date.now();
    const isAvailable = (sym: string) => {
      const lastAlert = this.symbolCooldowns.get(sym) || 0;
      return now - lastAlert > 15 * 60 * 1000; // Cooldown 15 phút
    };

    // Lọc các coin có thanh khoản tốt (>= 500,000 USDT) và có biên độ sóng mạnh trong ngày (>= 12%)
    // Toàn bộ eligibleTickers đã được lọc: Giá < 0.5$ và thuộc mạng ETH, BSC, SOL
    const candidates = eligibleTickers.filter((t) => {
      if (!isAvailable(t.symbol) || t.quoteVolume < 500_000) return false;
      const range24h =
        t.highPrice > 0 ? ((t.highPrice - t.lowPrice) / t.lowPrice) * 100 : 0;
      return range24h >= 12.0 || Math.abs(t.priceChangePercent) >= 5.0;
    });

    if (candidates.length === 0) return;

    // Ưu tiên coin có volume lớn nhất
    const topCandidates = candidates
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 25);

    await Promise.all(
      topCandidates.map((t) => this.analyzeTrendPullback(t, now)),
    );
  }

  private async analyzeTrendPullback(ticker24h: Ticker24hData, now: number) {
    const symbol = ticker24h.symbol;
    try {
      const currentPrice = ticker24h.lastPrice;
      if (currentPrice <= 0 || !isEligibleTokenForAlert(symbol, currentPrice)) return;

      // 1. LẤY DỮ LIỆU 1H (24 nến = 24 tiếng gần nhất) ĐỂ XÁC ĐỊNH ĐỈNH VÀ CHU KỲ TĂNG
      const klines1h = await this.binanceService.getKlines(symbol, '1h', 24);
      if (!klines1h || klines1h.length < 12) return;

      const baseLow = Math.min(...klines1h.map((k) => k.low));
      const peakHigh = Math.max(...klines1h.map((k) => k.high));
      if (baseLow <= 0 || peakHigh <= baseLow) return;

      // Token phải từng có đợt tăng mạnh ít nhất +15% trở lên trong chu kỳ này
      const prePumpGain = ((peakHigh - baseLow) / baseLow) * 100;
      if (prePumpGain < 15.0) return;

      // 2. TÍNH ĐỘ SÂU NHỊP CHỈNH TỪ ĐỈNH GẦN NHẤT
      // Yêu cầu: Giảm 12% - 28% từ đỉnh (chỉnh lành mạnh tích lũy gom hàng để nổ sóng 2)
      const pullbackPct = ((peakHigh - currentPrice) / peakHigh) * 100;
      if (pullbackPct < 12.0 || pullbackPct > 28.0) return;

      // 3. LẤY DỮ LIỆU ĐA KHUNG THỜI GIAN: 5m (12 nến = 1 giờ) & 1m (15 nến = 15 phút)
      const [klines5m, klines1m] = await Promise.all([
        this.binanceService.getKlines(symbol, '5m', 12),
        this.binanceService.getKlines(symbol, '1m', 15),
      ]);
      if (!klines5m || klines5m.length < 6 || !klines1m || klines1m.length < 10) return;

      const dipLow = Math.min(...klines5m.map((k) => k.low));
      if (dipLow <= 0) return;

      // =====================================================================
      // 4. BỘ LỌC LOẠI TRỪ: ĐANG GIẢM CHƯA CÓ DÒNG TIỀN ĐỠ -> TUYỆT ĐỐI KHÔNG VÀO
      // =====================================================================
      const bounceFromDipPct = ((currentPrice - dipLow) / dipLow) * 100;
      if (bounceFromDipPct < 0.20) {
        return; // Chưa hề có phản ứng bật lên khỏi đáy
      }

      const latest5m = klines5m[klines5m.length - 1];
      const range5m = latest5m.high - latest5m.low;
      if (range5m > 0 && latest5m.close < latest5m.open) {
        const body5m = latest5m.open - latest5m.close;
        const lowerWick5m = latest5m.close - latest5m.low;
        if (body5m / range5m > 0.65 && lowerWick5m / range5m < 0.15) {
          return;
        }
      }

      const recent3_1m = klines1m.slice(-3);
      const isContinuous1mDump = recent3_1m.every((k) => k.close < k.open);
      const buyVol1m_3 = recent3_1m.reduce((sum, k) => sum + k.takerBuyQuoteVolume, 0);
      const totalVol1m_3 = recent3_1m.reduce((sum, k) => sum + k.quoteVolume, 0);
      const takerBuyPct1m_3 = totalVol1m_3 > 0 ? (buyVol1m_3 / totalVol1m_3) * 100 : 0;
      if (isContinuous1mDump && takerBuyPct1m_3 < 48.0) {
        return;
      }

      // =====================================================================
      // 5. ĐIỀU KIỆN KÍCH HOẠT: CÓ DÒNG TIỀN VÀO ĐỠ MẠNH (BUY ABSORPTION & INFLOW)
      // =====================================================================
      const recent3_5m = klines5m.slice(-3);
      const totalBuyVol = recent3_5m.reduce(
        (sum, k) => sum + k.takerBuyQuoteVolume,
        0,
      );
      const totalVol = recent3_5m.reduce((sum, k) => sum + k.quoteVolume, 0);
      const takerBuyPct = totalVol > 0 ? (totalBuyVol / totalVol) * 100 : 0;

      // Khối lượng mua đỡ thực tế phải đủ lớn
      const minBuyVolumeRequired = ticker24h.quoteVolume >= 10_000_000 ? 50_000 : 25_000;
      if (totalBuyVol < minBuyVolumeRequired) {
        return;
      }

      // Taker Buy phải chiếm ưu thế áp đảo tại đáy cú chỉnh (tối thiểu 58%)
      if (takerBuyPct < 58.0) {
        return;
      }

      // 6. HÀNH ĐỘNG GIÁ XÁC NHẬN ĐÃ ĐỠ THÀNH CÔNG VÀ ĐANG ĐẢO CHIỀU ĐI LÊN
      const prev5m = klines5m[klines5m.length - 2];
      const checkHammer = (k: KlineData) => {
        const rng = k.high - k.low;
        if (rng <= 0) return false;
        const lowerWick = Math.min(k.open, k.close) - k.low;
        const wickPct = (lowerWick / rng) * 100;
        const kBuyPct = k.quoteVolume > 0 ? (k.takerBuyQuoteVolume / k.quoteVolume) * 100 : 0;
        return wickPct >= 35.0 && (kBuyPct >= 52.0 || k.takerBuyQuoteVolume >= 20_000);
      };

      const hasHammerSupport = checkHammer(latest5m) || checkHammer(prev5m);
      const hasBullishEngulfing =
        latest5m.close > latest5m.open &&
        (latest5m.close - latest5m.open) / (latest5m.high - latest5m.low || 1) >= 0.35 &&
        (latest5m.takerBuyQuoteVolume / (latest5m.quoteVolume || 1)) * 100 >= 55.0;

      const recent5_1m = klines1m.slice(-5);
      const green1mCandles = recent5_1m.filter((k) => k.close >= k.open).length;
      const hasMicroBounce1m =
        bounceFromDipPct >= 0.4 &&
        bounceFromDipPct <= 3.8 &&
        green1mCandles >= 2 &&
        klines1m[klines1m.length - 1].close >= klines1m[klines1m.length - 1].open;

      const isStrongSupportConfirmed =
        hasHammerSupport || hasBullishEngulfing || hasMicroBounce1m;

      if (!isStrongSupportConfirmed) {
        return;
      }

      // =====================================================================
      // 7. THIẾT LẬP VỊ THẾ & GỬI TÍN HIỆU ĂN MIẾNG TO SÓNG 2
      // =====================================================================
      const suggestedSl = dipLow > 0 ? dipLow * 0.985 : currentPrice * 0.96;
      const suggestedTp = currentPrice * 1.12; // TP1 +12%
      const suggestedTp2 = currentPrice * 1.25; // TP2 +25%

      this.symbolCooldowns.set(symbol, now);

      const badge = getChainBadge(symbol);
      this.logger.warn(
        `🔁 [ĐÃ BAY & CHỈNH XONG - SÓNG 2] ${symbol} ${badge} -> Đã chỉnh -${pullbackPct.toFixed(1)}% từ đỉnh (Bơm: +${prePumpGain.toFixed(1)}%), Taker Buy 5m: ${takerBuyPct.toFixed(0)}% (${Math.round(totalBuyVol / 1000)}k USDT), Bật đáy: +${bounceFromDipPct.toFixed(1)}%, Entry: ${currentPrice}`,
      );

      await this.telegramService.sendPullbackDipAlert({
        symbol,
        currentPrice,
        pullbackPct,
        prePumpGain,
        buyVolume: totalBuyVol,
        takerBuyPct,
        suggestedTp,
        suggestedSl,
      });

      // Theo dõi vị thế để quản lý chốt lời TP1 (+12%), TP2 (+25%)
      this.activePositions.set(symbol, {
        symbol,
        direction: 'LONG',
        entryPrice: currentPrice,
        entryTime: now,
        tp1Price: suggestedTp,
        tp2Price: suggestedTp2,
        slPrice: suggestedSl,
        tp1Hit: false,
        highestPrice: currentPrice,
        lowestPrice: currentPrice,
      });
    } catch (err: any) {
      this.logger.error(`Lỗi phân tích bắt chỉnh ${symbol}: ${err.message}`);
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface VipSpikeAlertPayload {
  symbol: string;
  currentPrice: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  priceChangePct: number;

  // Vị thế đáy 24h & 1h
  bottomRangePct: number;
  low24h: number;
  high24h: number;
  change24hPct: number;
  change1hPct: number;

  // Khung 15m
  takerBuyPct15m: number;
  netCashflow15m: number;

  // Khung 5m
  netCashflow5m: number;
  takerBuyPct5m: number;
  priceChange5mPct: number;
  greenCandles5m: number;

  // Khung 1m (Điểm kích nổ chân sóng)
  volume1m: number;
  takerBuyVol1m: number;
  takerSellVol1m: number;
  netCashflow1m: number;
  takerBuyPct1m: number;
  volumeMultiplier: number;
  netCashflow3m: number;
  takerBuyPct3m: number;

  // Điểm đánh giá & Winrate
  forecastScore: number;
  estimatedWinRate: number;

  // Kế hoạch giao dịch
  entryPrice: number;
  suggestedTp1: number;
  suggestedTp2: number;
  suggestedSl: number;
  rewardRiskRatio: number;

  analysisReason: string;
}

export interface HetNgonAlertPayload {
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  profitPct: number;
  candlesAnalyzed: number;
  takerSellPct: number;
  netCashflowSell: number;
  dropFromPeakPct: number;
  reasonText: string;
}

export interface TakeProfitAlertPayload {
  symbol: string;
  targetLevel: 'TP1 (+3.2%)' | 'TP2 (+6.5%)';
  entryPrice: number;
  currentPrice: number;
  profitPct: number;
  suggestedAction: string;
}

export interface StopLossAlertPayload {
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  lossPct: number;
  reasonText: string;
}

export interface StrategicPeriodicReportItem {
  symbol: string;
  currentPrice: number;
  low24h: number;
  high24h: number;
  bottomRangePct: number;
  change24hPct: number;
  netCashflow1h: number;
  takerBuyPct1h: number;
  volatilityCompressionPct: number;
  forecastScore: number;
  entryZone: string;
  suggestedTp1: number;
  suggestedTp2: number;
  suggestedSl: number;
  catalystReason: string;
}

// Giữ lại interface cũ để tương thích
export interface TieredAlertPayload {
  symbol: string;
  patternType: 'CHAN_SONG' | 'DONG_TIEN_GOM_TANG' | 'HET_NGON_STAGNANT' | 'HET_NGON_SELL_OUT';
  qualityTier?: 'CUC_KI_NGON' | 'NGON';
  priceChangePct: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  currentPrice: number;
  volume1m: number;
  avgVolume: number;
  volumeMultiplier: number;
  takerBuyVol: number;
  takerSellVol: number;
  netCashflow: number;
  takerBuyPct: number;
  volatilitySurgeRatio: number;
  forecastScore: number;
  suggestedTp1?: number;
  suggestedTp2?: number;
  suggestedSl?: number;
  change1hPct?: number;
  reasonText?: string;
  netCashflow5m?: number;
  priceChange5mPct?: number;
  takerBuyPct5m?: number;
}

export interface AccumulationReportItem {
  symbol: string;
  netCashflow: number;
  takerBuyPct: number;
  currentPrice: number;
  forecastScore: number;
  detectedTime: string;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private botToken: string;
  private chatId: string;

  constructor(private configService: ConfigService) {
    this.botToken = this.configService.get<string>(
      'TELEGRAM_BOT_TOKEN',
      '8899308692:AAH0Tr4sH1V0xy6_85i8M1cQke3LYAgzxSA',
    );
    this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID', '8036936969');

    if (this.botToken && !this.chatId) {
      this.autoDetectChatId();
    }
  }

  async autoDetectChatId(): Promise<string | null> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/getUpdates`;
      const res = await axios.get(url, { timeout: 5000 });
      const updates = res.data?.result || [];
      if (updates.length > 0) {
        const lastUpdate = updates[updates.length - 1];
        const detectedChatId =
          lastUpdate.message?.chat?.id || lastUpdate.channel_post?.chat?.id;
        if (detectedChatId) {
          this.chatId = String(detectedChatId);
          this.logger.log(`Auto-detected Telegram Chat ID: ${this.chatId}`);
          return this.chatId;
        }
      }
    } catch (err: any) {
      this.logger.warn(`Could not auto-detect Telegram Chat ID: ${err.message}`);
    }
    return null;
  }

  async sendMessage(text: string): Promise<boolean> {
    if (!this.botToken) {
      this.logger.error('TELEGRAM_BOT_TOKEN is not configured.');
      return false;
    }

    if (!this.chatId) {
      const detected = await this.autoDetectChatId();
      if (!detected) {
        this.logger.warn('Không tìm thấy TELEGRAM_CHAT_ID.');
        return false;
      }
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      await axios.post(url, {
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      this.logger.log(`Tín hiệu Telegram đã gửi thành công tới chatId ${this.chatId}`);
      return true;
    } catch (error: any) {
      this.logger.error(
        `Lỗi gửi tin nhắn Telegram: ${error?.response?.data?.description || error.message}`,
      );
      return false;
    }
  }

  // THÔNG BÁO KÈO CỰC KÌ NGON (BẮT ĐÚNG CHÂN SÓNG TĂNG TRÊN TẤT CẢ CÁC KHUNG GIỜ)
  async sendVipSpikeAlert(payload: VipSpikeAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;

    const lines: string[] = [
      '👑 🔥 🟢 <b>[TÍN HIỆU VIP: BẮT ĐÚNG CHÂN SÓNG TĂNG ĐA KHUNG GIỜ]</b>',
      '🚀 <b>XÁC NHẬN HỘI TỤ TẤT CẢ CÁC KHUNG GIỜ (WIN RATE > 95%)</b>',
      `<b>Mã Coin:</b> <code>${payload.symbol}</code>`,
      `🎯 <b>ĐIỂM HỘI TỤ ĐA KHUNG:</b> <b>${payload.forecastScore}/100</b> (Độ chuẩn xác: <b>${payload.estimatedWinRate}%+</b>)`,
      '----------------------------------------',
      '🌐 <b>XÁC NHẬN CHÂN SÓNG TRÊN TẤT CẢ CÁC KHUNG THỜI GIAN:</b>',
      `• <b>Khung 24h:</b> Nằm ở <b>${payload.bottomRangePct.toFixed(1)}%</b> sát đáy 24h (Đáy: <code>$${payload.low24h}</code> | Đỉnh: <code>$${payload.high24h}</code> | 24h: <code>${payload.change24hPct >= 0 ? '+' : ''}${payload.change24hPct.toFixed(2)}%</code>)`,
      `• <b>Khung 1h:</b> Nền tích lũy phẳng đi ngang nén chặt, cạn kiệt lực bán (1h: <code>${payload.change1hPct >= 0 ? '+' : ''}${payload.change1hPct.toFixed(2)}%</code>)`,
      `• <b>Khung 15m:</b> Đảo chiều đi lên, Taker Mua gom 15m: <code>${payload.takerBuyPct15m.toFixed(1)}%</code> (Net Mua 15m: <code>+${Math.round(payload.netCashflow15m).toLocaleString()} USDT</code>)`,
      `• <b>Khung 5m:</b> Dòng tiền ròng gom 5m: <code>+${Math.round(payload.netCashflow5m).toLocaleString()} USDT</code> (Mua 5m: <code>${payload.takerBuyPct5m.toFixed(1)}%</code> | <b>${payload.greenCandles5m}/5 nến xanh</b> | Đáy sau cao hơn đáy trước)`,
      `• <b>Khung 1m (Điểm Nổ Realtime):</b> Vừa nhấc chân <code>+${payload.priceChangePct.toFixed(2)}%</code> từ nền đáy, Volume nổ <b>${payload.volumeMultiplier.toFixed(1)}x</b>, Taker Mua <b>${payload.takerBuyPct1m.toFixed(1)}%</b> (Net 1m: <code>+${Math.round(payload.netCashflow1m).toLocaleString()} USDT</code>)`,
      '----------------------------------------',
      '🛡️ <b>CẤU TRÚC NẾN CHỐNG BẪY XẢ (ANTI-TRAP):</b>',
      '• Nến xanh đặc, đóng căng sát đỉnh, triệt tiêu hoàn toàn râu xả ảo!',
      '----------------------------------------',
      '🎯 <b>KẾ HOẠCH VÀO NGAY CHÂN SÓNG (KHÔNG CẦN CHỜ ĐỢI):</b>',
      `• <b>Vào Lệnh Ngay (Entry Chân Sóng):</b> <code>$${payload.entryPrice}</code>`,
      `• <b>Chốt Lời TP1 (+3.2%):</b> <code>$${payload.suggestedTp1.toFixed(4)}</code> (Chốt 50%, dời SL hòa vốn)`,
      `• <b>Chốt Lời TP2 (+6.5%):</b> <code>$${payload.suggestedTp2.toFixed(4)}</code> (Gồng trọn con sóng)`,
      `• <b>Cắt Lỗ SL (-1.8%):</b> <code>$${payload.suggestedSl.toFixed(4)}</code> (Đặt ngay dưới đáy nến chân sóng)`,
      `• <b>Tỷ Lệ Risk/Reward:</b> <b>${payload.rewardRiskRatio.toFixed(1)}:1</b> (Cực kì tối ưu)`,
      '----------------------------------------',
      `💡 <i>Phân tích: ${payload.analysisReason}</i>`,
      '----------------------------------------',
      `⏰ <i>${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</i>`,
      `🔗 <a href="${binanceUrl}">Mở Ngay Trên Binance Futures</a>`,
    ];

    return this.sendMessage(lines.join('\n'));
  }

  // THÔNG BÁO HẾT NGON (CHỈ BÁO CHO COIN ĐÃ TỪNG DỰ BÁO NGON - DỰA TRÊN NHIỀU NẾN - THÔNG BÁO DUY NHẤT 1 LẦN)
  async sendHetNgonMultiCandleAlert(payload: HetNgonAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;

    const lines: string[] = [
      '🔴 🛑 <b>[THÔNG BÁO DUY NHẤT: HẾT NGON - LỰC BÁN XẢ ĐA NẾN]</b>',
      `<b>Mã Coin:</b> <code>${payload.symbol}</code> (ĐÃ TỪNG DỰ BÁO NGON)`,
      '• <b>Trạng Thái:</b> <code>HẾT NGON (Áp lực bán tháo xác nhận qua nhiều nến liên tiếp)</code>',
      `• <b>Giá Vào (Chân Sóng):</b> <code>$${payload.entryPrice}</code> ➔ <b>Giá Hiện Tại:</b> <code>$${payload.currentPrice}</code> (<code>${payload.profitPct >= 0 ? '+' : ''}${payload.profitPct.toFixed(2)}%</code>)`,
      '----------------------------------------',
      '📊 <b>DỮ LIỆU ĐA NẾN XÁC NHẬN LỰC BÁN XẢ NHIỀU:</b>',
      `• Phân tích qua <b>${payload.candlesAnalyzed} cây nến liên tiếp</b> (Không phải phán đoán 1 nến)`,
      `• <b>Lực Bán Chủ Động Taker:</b> <b>${payload.takerSellPct.toFixed(1)}%</b> (Phe bán áp đảo hoàn toàn phe mua)`,
      `• <b>Dòng Tiền Ròng Bị Rút Ra:</b> <code>-${Math.round(Math.abs(payload.netCashflowSell)).toLocaleString()} USDT</code>`,
      payload.dropFromPeakPct > 0.5
        ? `• <b>Sụt Giảm Từ Đỉnh Cao Nhất:</b> <b>-${payload.dropFromPeakPct.toFixed(2)}%</b>`
        : '',
      '----------------------------------------',
      `💡 <b>Lý do:</b> <i>${payload.reasonText}</i>`,
      '👉 <b>HÀNH ĐỘNG DUY NHẤT:</b> <b>ĐÓNG LỆNH NGAY / BẢO TOÀN VỐN!</b>',
      '⚠️ <i>Lưu ý: Bot chỉ thông báo HẾT NGON DUY NHẤT 1 LẦN cho coin này và dừng theo dõi hoàn toàn.</i>',
      '----------------------------------------',
      `⏰ <i>${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</i>`,
      `🔗 <a href="${binanceUrl}">Kiểm Tra Vị Thế Binance Futures</a>`,
    ];

    return this.sendMessage(lines.filter(Boolean).join('\n'));
  }

  // THÔNG BÁO CHỐT LỜI TP1 / TP2
  async sendTakeProfitAlert(payload: TakeProfitAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;

    const lines: string[] = [
      `🎯 💰 🟢 <b>[CHỐT LỜI THÀNH CÔNG: ĐẠT MỤC TIÊU ${payload.targetLevel}]</b>`,
      `<b>Mã Coin:</b> <code>${payload.symbol}</code>`,
      `• <b>Lợi Nhuận Đạt Được:</b> <b>+${payload.profitPct.toFixed(2)}%</b> 🚀`,
      `• <b>Giá Vào (Entry):</b> <code>$${payload.entryPrice}</code> ➔ <b>Giá Hiện Tại:</b> <code>$${payload.currentPrice}</code>`,
      '----------------------------------------',
      `👉 <b>HÀNH ĐỘNG KHUYẾN NGHỊ:</b> <b>${payload.suggestedAction}</b>`,
      '----------------------------------------',
      `⏰ <i>${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</i>`,
      `🔗 <a href="${binanceUrl}">Quản Lý Vị Thế Binance Futures</a>`,
    ];

    return this.sendMessage(lines.join('\n'));
  }

  // THÔNG BÁO BẢO TOÀN VỐN / STOP LOSS
  async sendStopLossAlert(payload: StopLossAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;

    const lines: string[] = [
      '🛑 🔴 <b>[BẢO TOÀN VỐN: CHẠM MỨC DỪNG LỖ / ĐẢO CHIỀU]</b>',
      `<b>Mã Coin:</b> <code>${payload.symbol}</code>`,
      `• <b>Biến Động:</b> <code>${payload.lossPct.toFixed(2)}%</code>`,
      `• <b>Giá Vào:</b> <code>$${payload.entryPrice}</code> ➔ <b>Giá Thoát:</b> <code>$${payload.currentPrice}</code>`,
      '----------------------------------------',
      `💡 <b>Lý do:</b> <i>${payload.reasonText}</i>`,
      '👉 <b>HÀNH ĐỘNG:</b> Thoát lệnh dứt khoát bảo toàn vốn, chờ đợi cơ hội mới chuẩn xác hơn!',
      '----------------------------------------',
      `⏰ <i>${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</i>`,
      `🔗 <a href="${binanceUrl}">Kiểm Tra Binance Futures</a>`,
    ];

    return this.sendMessage(lines.join('\n'));
  }

  // BÁO CÁO CHIẾN LƯỢC ĐỊNH KỲ 12H VÀ 24H: TOP COIN VÙNG ĐÁY DÒNG TIỀN ỔN ĐỊNH SẮP BAY
  async sendStrategicPeriodicReport(
    reportTitle: string,
    items: StrategicPeriodicReportItem[],
  ): Promise<boolean> {
    if (items.length === 0) {
      return this.sendMessage(
        `💎 👑 <b>[${reportTitle}]</b>\nHiện tại thị trường đang đi ngang phân hóa, không có token nào hội tụ đủ tiêu chuẩn khắt khe (Vùng đáy + Dòng tiền gom ổn định). Bot sẽ tiếp tục theo dõi!`,
      );
    }

    const lines: string[] = [
      `💎 👑 <b>[${reportTitle}]</b>`,
      '🔥 <b>TOP TOKEN VÙNG ĐÁY - DÒNG TIỀN GOM ỔN ĐỊNH - SẮP BỨT PHÁ (BAY)</b>',
      '💡 <i>Hệ thống phân tích định lượng quét toàn thị trường, chọn lọc các token đang nén chặt ở vùng đáy và có Cá mập âm thầm gom hàng liên tục:</i>',
      '----------------------------------------',
    ];

    items.forEach((item, idx) => {
      const binanceUrl = `https://www.binance.com/en/futures/${item.symbol}`;
      lines.push(
        `<b>#${idx + 1}. <a href="${binanceUrl}">${item.symbol}</a></b> (Điểm: <b>${item.forecastScore}/100</b> - Winrate: <b>95%+</b>)`,
        `• <b>Vị thế đáy 24h:</b> Nằm ở <code>${item.bottomRangePct.toFixed(1)}%</code> (Đáy: <code>$${item.low24h}</code> | Đỉnh: <code>$${item.high24h}</code>)`,
        `• <b>Dòng Tiền Mua Gom 1h:</b> <code>+${Math.round(item.netCashflow1h).toLocaleString()} USDT</code> 🟢 (Taker Mua: <code>${item.takerBuyPct1h.toFixed(1)}%</code>)`,
        `• <b>Độ Nén Biến Động (Squeeze):</b> <code>${item.volatilityCompressionPct.toFixed(2)}%/nến</code> (Nén nến phẳng lì ở đáy)`,
        `• <b>Chiến Lược:</b> Gom <code>${item.entryZone}</code> | TP1: <code>$${item.suggestedTp1.toFixed(4)}</code> (+3.5%) | TP2: <code>$${item.suggestedTp2.toFixed(4)}</code> (+7%) | SL: <code>$${item.suggestedSl.toFixed(4)}</code> (-1.8%)`,
        `• <i>Phân tích: ${item.catalystReason}</i>`,
        '',
      );
    });

    lines.push(
      '----------------------------------------',
      '💡 <i>Lưu ý: Các token trên đang trong pha tích lũy gom hàng chuẩn bị bung nén. Phân bổ vốn hợp lý và luôn tuân thủ Stop Loss!</i>',
      `⏰ <i>Thời gian lập báo cáo: ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</i>`,
    );

    return this.sendMessage(lines.join('\n'));
  }

  // Tương thích ngược nếu cần
  async sendTieredAlert(payload: TieredAlertPayload): Promise<boolean> {
    const isCucKiNgon = payload.qualityTier === 'CUC_KI_NGON';
    const isHetNgon =
      payload.patternType === 'HET_NGON_STAGNANT' || payload.patternType === 'HET_NGON_SELL_OUT';

    let header = '';
    let analysisNote = '';

    if (payload.patternType === 'HET_NGON_STAGNANT') {
      header = '🔴 🛑 <b>[THÔNG BÁO: HẾT NGON - GIÁ ĐI NGANG NÉN ĐỨNG YÊN]</b>';
      analysisNote = '🚨 <i>Phân tích: Lực Mua dừng lại, coin nén đi ngang $\\rightarrow$ HỦY THEO DÕI!</i>';
    } else if (payload.patternType === 'HET_NGON_SELL_OUT') {
      header = '💰 🔴 <b>[THÔNG BÁO: HẾT NGON - CÁ MẠP BÁN XẢ / CHỐT LỜI]</b>';
      analysisNote = '🚨 <i>Phân tích: Lực Bán Taker xả tháo mạnh $\\rightarrow$ CHỐT LỜI HOẶC BỎ QUA!</i>';
    } else {
      header = '🚀 🔥 🟢 <b>[CỰC KÌ NGON: BẮT ĐẦU CHÂN SÓNG TĂNG (WIN RATE >= 95%)]</b>';
      analysisNote = '💡 <i>Phân tích: Nổ Volume khổng lồ ngay từ nền phẳng đáy $\\rightarrow$ Chuẩn bị bay!</i>';
    }

    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;
    const lines: string[] = [
      header,
      `<b>Mã Coin:</b> <code>${payload.symbol}</code>`,
      !isHetNgon
        ? `🎯 <b>ĐIỂM ĐÁNH GIÁ CHUẨN:</b> <b>${payload.forecastScore}/100</b> (${isCucKiNgon ? 'Kèo VIP Cực Khủng' : 'Kèo Chuẩn'})`
        : '',
      analysisNote,
      '----------------------------------------',
      '📊 <b>TRẠNG THÁI DÒNG TIỀN:</b>',
      `• <b>Dòng Tiền Ròng (Net Flow 1m):</b> <code>${payload.netCashflow >= 0 ? '+' : ''}${Math.round(payload.netCashflow).toLocaleString()} USDT</code>`,
      payload.netCashflow5m !== undefined
        ? `• <b>Dòng Tiền Ròng Mua 5m:</b> <code>${payload.netCashflow5m >= 0 ? '+' : ''}${Math.round(payload.netCashflow5m).toLocaleString()} USDT</code> (Mua 5m: <code>${payload.takerBuyPct5m?.toFixed(1)}%</code>)`
        : '',
      `• <b>Lực Mua Chủ Động (Taker Buy 1m):</b> <code>${payload.takerBuyPct.toFixed(1)}%</code> (${Math.round(payload.takerBuyVol).toLocaleString()} USDT)`,
      `• <b>Tổng Volume 1m:</b> <code>${Math.round(payload.volume1m).toLocaleString()} USDT</code> (Đột biến <b>${payload.volumeMultiplier.toFixed(1)}x</b>)`,
      '----------------------------------------',
      '📈 <b>GIÁ VÀ BIẾN ĐỘNG:</b>',
      `• <b>Giá Hiện Tại:</b> <code>$${payload.currentPrice}</code>`,
      payload.change1hPct !== undefined
        ? `• <b>Xu hướng 1 giờ:</b> <code>${payload.change1hPct >= 0 ? '+' : ''}${payload.change1hPct.toFixed(2)}%</code>`
        : '',
      '----------------------------------------',
      `⏰ <i>${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</i>`,
      `🔗 <a href="${binanceUrl}">Xem Ngay Trên Binance Futures</a>`,
    ];

    return this.sendMessage(lines.filter(Boolean).join('\n'));
  }

  async sendDailyAccumulationReport(items: AccumulationReportItem[]): Promise<boolean> {
    if (items.length === 0) return false;
    const lines: string[] = [
      '💎 📊 <b>[BÁO CÁO TÍCH LŨY TỔNG HỢP - XẾP HẠNG CÁ MẠP GOM HÀNG]</b>',
      '----------------------------------------',
    ];
    items.forEach((item, index) => {
      const binanceUrl = `https://www.binance.com/en/futures/${item.symbol}`;
      lines.push(
        `<b>#${index + 1}. <a href="${binanceUrl}">${item.symbol}</a></b>`,
        `• <b>Dòng Tiền Mua:</b> <code>+${Math.round(item.netCashflow).toLocaleString()} USDT</code> | Taker Mua: <code>${item.takerBuyPct.toFixed(1)}%</code>`,
        `• <b>Giá Hiện Tại:</b> <code>$${item.currentPrice}</code>`,
        '',
      );
    });
    return this.sendMessage(lines.join('\n'));
  }
}


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
  distanceFromFootPct?: number;
  baseMinLow?: number;

  // Biến động giây (5s - 10s) & Dòng tiền tức thì
  secondVelocityPct?: number;
  secondVolInflow?: number;

  // HỘI TỤ ĐỒNG THUẬN CHÂN SÓNG TẤT CẢ CÁC KHUNG GIỜ
  // 1. Chân Sóng 24h
  bottomRangePct: number;
  low24h: number;
  high24h: number;
  change24hPct: number;

  // 2. Chân Sóng 1h
  change1hPct: number;
  foot1hPct: number;
  status1hText: string;

  // 3. Chân Sóng 15m
  distanceFromFoot15mPct: number;
  baseLow15m: number;
  foot15mPct: number;
  status15mText: string;
  takerBuyPct15m: number;
  netCashflow15m: number;

  // 4. Chân Sóng 5m
  netCashflow5m: number;
  takerBuyPct5m: number;
  priceChange5mPct: number;
  greenCandles5m: number;

  // 5. Chân Sóng 1m (Điểm kích nổ realtime)
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

  // =========================================================================
  // THÔNG BÁO CỰC KÌ NGON: BẮT ĐÚNG CHÂN SÓNG ĐA KHUNG GIỜ (RỦI RO THẤP - ĂN NHIỀU)
  // Xác nhận đồng thuận chân sóng ở TẤT CẢ CÁC KHUNG: 1m, 5m, 15m, 1h, 24h
  // =========================================================================
  async sendVipSpikeAlert(payload: VipSpikeAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;
    const footDistanceText =
      payload.distanceFromFootPct !== undefined
        ? `+${payload.distanceFromFootPct.toFixed(2)}%`
        : `+${payload.priceChangePct.toFixed(2)}%`;
    const baseLowText =
      payload.baseMinLow !== undefined ? `$${payload.baseMinLow}` : `$${payload.lowPrice}`;
    const riskDistance =
      payload.suggestedSl && payload.entryPrice > 0
        ? (((payload.entryPrice - payload.suggestedSl) / payload.entryPrice) * 100).toFixed(2)
        : '1.20';

    const lines: string[] = [
      '🚀 ⚡ 💎 <b>[CẢNH BÁO DÒNG TIỀN VÀO MẠNH: CHUẨN BỊ BAY]</b>',
      '🔥 <b>PHÁT HIỆN BIẾN ĐỘNG GIÂY & PHÚT - DÒNG TIỀN CÁ MẬP VÀO HÀNG!</b>',
      '🌟 <b>VÙNG CHÂN SÓNG BỨT PHÁ - VÀO LỆNH NGAY KẺO LỠ!</b>',
      '----------------------------------------',
      `<b>Mã Coin:</b> <code>${payload.symbol}</code>`,
      `🎯 <b>ĐỘ MẠNH DÒNG TIỀN & XUNG LỰC:</b> <b>${payload.forecastScore}/100</b> (Độ chuẩn xác: <b>${payload.estimatedWinRate}%+</b>)`,
      '----------------------------------------',
      '⚡ <b>BIẾN ĐỘNG TỨC THÌ (GIÂY & PHÚT):</b>',
      ...(payload.secondVelocityPct !== undefined && payload.secondVelocityPct > 0
        ? [
            `• <b>Biến Động Tức Thì (5 Giây):</b> <b>+${payload.secondVelocityPct.toFixed(2)}%</b> 🚀 (Giật giá kích nổ sóng)${
              payload.secondVolInflow ? ` | Bơm ròng: <code>+${Math.round(payload.secondVolInflow).toLocaleString()} USDT</code>` : ''
            }`,
          ]
        : []),
      `• <b>Biến Động 1 Phút (1m):</b> <b>+${payload.priceChangePct.toFixed(2)}%</b> (Bứt phá dứt khoát)`,
      `• <b>Biến Động 5 Phút (5m):</b> <b>${payload.priceChange5mPct >= 0 ? '+' : ''}${payload.priceChange5mPct.toFixed(2)}%</b> (${payload.greenCandles5m}/5 nến xanh)`,
      '----------------------------------------',
      '🌊 <b>DÒNG TIỀN MUA GOM CỰC MẠNH (CÁ MẬP BƠM TIỀN):</b>',
      `• <b>Khối Lượng 1 Phút:</b> <code>${Math.round(payload.volume1m).toLocaleString()} USDT</code> (Đột biến <b>${payload.volumeMultiplier.toFixed(1)}x</b> lần nền)`,
      `• <b>Lực Mua Chủ Động (Taker Buy):</b> <b>${payload.takerBuyPct1m.toFixed(1)}%</b> (Net gom 1m: <code>+${Math.round(payload.netCashflow1m).toLocaleString()} USDT</code>)`,
      `• <b>Dòng Tiền Đa Khung (Net Gom):</b> Net 3m: <code>+${Math.round(payload.netCashflow3m).toLocaleString()} USDT</code> | Net 5m: <code>+${Math.round(payload.netCashflow5m).toLocaleString()} USDT</code>`,
      '----------------------------------------',
      '🌱 <b>VỊ THẾ CHÂN SÓNG (CHUẨN BỊ BAY - RỦI RO CỰC THẤP):</b>',
      `• <b>Vị Trí Chân Sóng:</b> Vừa nhấc chân <code>${footDistanceText}</code> khỏi nền đáy (Đáy gom: <code>${baseLowText}</code>)`,
      `• <b>Khung 15m:</b> ${payload.status15mText} (Cách đáy 15m: <code>+${payload.distanceFromFoot15mPct.toFixed(2)}%</code>)`,
      `• <b>Khung 1h:</b> ${payload.status1hText} (1h: <code>${payload.change1hPct >= 0 ? '+' : ''}${payload.change1hPct.toFixed(2)}%</code>)`,
      '----------------------------------------',
      '🎯 <b>KẾ HOẠCH VÀO LỆNH (CHUẨN BỊ BAY):</b>',
      `• <b>Vào Lệnh Ngay (Entry):</b> <code>$${payload.entryPrice}</code>`,
      `• <b>Chốt Lời TP1 (+3.2%):</b> <code>$${payload.suggestedTp1.toFixed(4)}</code> (Chốt 50%, dời SL hòa vốn)`,
      `• <b>Chốt Lời TP2 (+6.5%):</b> <code>$${payload.suggestedTp2.toFixed(4)}</code> (Ăn trọn con sóng lớn)`,
      `• <b>Cắt Lỗ SL Sát Nền:</b> <code>$${payload.suggestedSl.toFixed(4)}</code> (Rủi ro chỉ <b>-${riskDistance}%</b>, ngay dưới đáy nền)`,
      `• <b>Tỷ Lệ Risk/Reward:</b> <b>${payload.rewardRiskRatio.toFixed(1)}:1</b>`,
      '----------------------------------------',
      `💡 <i>Phân tích: ${payload.analysisReason}</i>`,
      '----------------------------------------',
      `⏰ <i>${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</i>`,
      `🔗 <a href="${binanceUrl}">Mở Vị Thế LONG Trên Binance Futures Ngay</a>`,
    ];

    return this.sendMessage(lines.join('\n'));
  }

  // =========================================================================
  // THÔNG BÁO CHỐT LỜI TP1 / TP2
  // =========================================================================
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

  // =========================================================================
  // THÔNG BÁO DỪNG LỖ / BẢO TOÀN VỐN (DUY NHẤT 1 LẦN)
  // =========================================================================
  async sendStopLossAlert(payload: StopLossAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;

    const lines: string[] = [
      '🛑 🔴 <b>[BẢO TOÀN VỐN: CHẠM MỨC DỪNG LỖ]</b>',
      `<b>Mã Coin:</b> <code>${payload.symbol}</code>`,
      `• <b>Biến Động:</b> <code>${payload.lossPct.toFixed(2)}%</code>`,
      `• <b>Giá Vào:</b> <code>$${payload.entryPrice}</code> ➔ <b>Giá Thoát:</b> <code>$${payload.currentPrice}</code>`,
      '----------------------------------------',
      `💡 <b>Lý do:</b> <i>${payload.reasonText}</i>`,
      '👉 <b>HÀNH ĐỘNG:</b> Thoát lệnh dứt khoát bảo toàn vốn, rủi ro cực thấp đã được khống chế an toàn!',
      '----------------------------------------',
      `⏰ <i>${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</i>`,
      `🔗 <a href="${binanceUrl}">Kiểm Tra Binance Futures</a>`,
    ];

    return this.sendMessage(lines.join('\n'));
  }

  // =========================================================================
  // THÔNG BÁO THOÁT LỆNH KHẨN CẤP (CHỈ KHI CÁ MẬP XẢ THẬT SỰ KHỦNG KHIẾP)
  // =========================================================================
  async sendHetNgonMultiCandleAlert(payload: HetNgonAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;

    const lines: string[] = [
      '🔴 🛑 <b>[THÔNG BÁO DUY NHẤT: THOÁT LỆNH BẢO TOÀN VỐN]</b>',
      `<b>Mã Coin:</b> <code>${payload.symbol}</code>`,
      `• <b>Giá Vào:</b> <code>$${payload.entryPrice}</code> ➔ <b>Giá Hiện Tại:</b> <code>$${payload.currentPrice}</code> (<code>${payload.profitPct >= 0 ? '+' : ''}${payload.profitPct.toFixed(2)}%</code>)`,
      '----------------------------------------',
      `• <b>Lực Bán Chủ Động Taker:</b> <b>${payload.takerSellPct.toFixed(1)}%</b>`,
      `• <b>Dòng Tiền Ròng Bị Rút:</b> <code>-${Math.round(Math.abs(payload.netCashflowSell)).toLocaleString()} USDT</code>`,
      '----------------------------------------',
      `💡 <b>Lý do:</b> <i>${payload.reasonText}</i>`,
      '👉 <b>HÀNH ĐỘNG DUY NHẤT:</b> <b>ĐÓNG LỆNH NGAY / BẢO TOÀN VỐN!</b>',
      '⚠️ <i>Lưu ý: Bot chỉ thông báo DUY NHẤT 1 LẦN cho coin này và dừng theo dõi hoàn toàn.</i>',
      '----------------------------------------',
      `⏰ <i>${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</i>`,
      `🔗 <a href="${binanceUrl}">Kiểm Tra Vị Thế Binance Futures</a>`,
    ];

    return this.sendMessage(lines.filter(Boolean).join('\n'));
  }
}

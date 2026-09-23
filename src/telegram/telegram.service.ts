import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface TieredAlertPayload {
  symbol: string;
  qualityTier: 'CUC_KI_NGON' | 'TIN_HIEU_NGON';
  priceChangePct: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  currentPrice: number;
  
  volume1m: number;              // Tổng volume 1m (USDT)
  avgVolume: number;             // Volume trung bình (USDT)
  volumeMultiplier: number;      // Hệ số đột biến volume
  
  takerBuyVol: number;           // Volume Mua chủ động (USDT)
  takerSellVol: number;          // Volume Bán chủ động (USDT)
  netCashflow: number;           // Dòng tiền ròng = BuyVol - SellVol (USDT)
  takerBuyPct: number;           // Tỷ lệ % Mua chủ động
  
  volatilitySurgeRatio: number;
  forecastScore: number;         // 82 - 100 điểm tin cậy

  suggestedTp1: number;
  suggestedTp2: number;
  suggestedSl: number;
  change1hPct?: number;
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
    this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID', '');
    
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
        this.logger.warn(
          'Không tìm thấy TELEGRAM_CHAT_ID. Vui lòng gửi tin nhắn (ví dụ: /start) tới @smart_patrol_123_bot',
        );
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

  async sendTieredAlert(payload: TieredAlertPayload): Promise<boolean> {
    const isCucKiNgon = payload.qualityTier === 'CUC_KI_NGON';

    const header = isCucKiNgon
      ? '🔥 🟢 <b>[TÍN HIỆU CỰC KÌ NGON - DỰ BÁO WIN RATE >= 90%]</b>'
      : '⚡ 🟢 <b>[TÍN HIỆU NGON - CHUẨN ĐẦU CHÂN SÓNG]</b>';

    const note = isCucKiNgon
      ? '🚀 <i>Dòng tiền Cá mập bơm cực lớn + Lực Mua áp đảo $\\rightarrow$ Cơ hội bứt phá ăn trọn sóng cực cao!</i>'
      : '💎 <i>Dòng tiền ròng vừa bơm vào đầu chân sóng $\\rightarrow$ Vị thế vào lệnh đẹp an toàn!</i>';

    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;

    const lines: string[] = [
      header,
      `<b>Mã Coin:</b> <code>${payload.symbol}</code>`,
      `🎯 <b>ĐIỂM ĐÁNH GIÁ CHUẨN:</b> <b>${payload.forecastScore}/100</b> (${isCucKiNgon ? 'Hàng Cực VIP' : 'Hàng Chuẩn'})`,
      note,
      `----------------------------------------`,
      `📊 <b>DÒNG TIỀN MUA TAKER (1 PHÚT):</b>`,
      `• <b>Dòng Tiền Ròng (Net Flow):</b> <code>+${Math.round(payload.netCashflow).toLocaleString()} USDT</code> 🟢`,
      `• <b>Lực Mua Chủ Động:</b> <code>${payload.takerBuyPct.toFixed(1)}%</code> (${Math.round(payload.takerBuyVol).toLocaleString()} USDT)`,
      `• <b>Tổng Volume 1m:</b> <code>${Math.round(payload.volume1m).toLocaleString()} USDT</code> (Đột biến <b>${payload.volumeMultiplier.toFixed(1)}x</b>)`,
      `----------------------------------------`,
      `📈 <b>GIÁ VÀ MỤC TIÊU VÀO LỆNH:</b>`,
      `• <b>Giá Entry Hiện Tại:</b> <code>$${payload.currentPrice}</code>`,
      payload.change1hPct !== undefined ? `• <b>Xu hướng 1 giờ:</b> <code>${payload.change1hPct >= 0 ? '+' : ''}${payload.change1hPct.toFixed(2)}%</code>` : '',
      `----------------------------------------`,
      `🎯 <b>GỢI Ý QUẢN TRỊ LỆNH:</b>`,
      `• <b>Chốt lời TP1 (+3%):</b> <code>$${payload.suggestedTp1.toFixed(4)}</code>`,
      `• <b>Chốt lời TP2 (+6%):</b> <code>$${payload.suggestedTp2.toFixed(4)}</code>`,
      `• <b>Cắt lỗ SL (-1.5%):</b> <code>$${payload.suggestedSl.toFixed(4)}</code>`,
      `----------------------------------------`,
      `⏰ <i>${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</i>`,
      `🔗 <a href="${binanceUrl}">Mở Vị Thế Ngay Trên Binance Futures</a>`,
    ];

    return this.sendMessage(lines.filter(Boolean).join('\n'));
  }
}

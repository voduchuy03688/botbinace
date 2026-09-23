import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface CashflowAlertPayload {
  symbol: string;
  action: 'ENTRY_BUY' | 'ENTRY_SELL' | 'EXIT_TAKE_PROFIT' | 'EXIT_STOP_WARNING';
  priceChangePct: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  currentPrice: number;
  volume1m: number;
  avgVolume: number;
  volumeMultiplier: number;
  volatilitySurgeRatio: number;
  forecastScore: number;         // 0 - 100
  forecastLabel: string;          // e.g. "BẮT ĐẦU NGỌN SÓNG (ENTRY ĐẦU SÓNG)"
  suggestedTp1?: number;
  suggestedTp2?: number;
  suggestedSl?: number;
  change1hPct?: number;
  takerBuyRatio?: number;
  reasonText?: string;
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
          'No TELEGRAM_CHAT_ID found. Please send a message (e.g. /start) to @smart_patrol_123_bot or set TELEGRAM_CHAT_ID in .env',
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
      this.logger.log(`Telegram alert sent successfully for chatId ${this.chatId}`);
      return true;
    } catch (error: any) {
      this.logger.error(
        `Failed to send Telegram message: ${error?.response?.data?.description || error.message}`,
      );
      return false;
    }
  }

  async sendCashflowAlert(payload: CashflowAlertPayload): Promise<boolean> {
    const isEntryBuy = payload.action === 'ENTRY_BUY';
    const isExit = payload.action === 'EXIT_TAKE_PROFIT' || payload.action === 'EXIT_STOP_WARNING';
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;

    let header = '';
    if (payload.action === 'ENTRY_BUY') {
      header = '💵 🟢 <b>[DÒNG TIỀN VÀO MẠNH - CƠ HỘI VÀO ĐẦU SÓNG]</b>';
    } else if (payload.action === 'ENTRY_SELL') {
      header = '🔴 📉 <b>[DÒNG TIỀN BÁN THOÁT - CƠ HỘI SHORT ĐẦU SÓNG GIẢM]</b>';
    } else if (payload.action === 'EXIT_TAKE_PROFIT') {
      header = '💰 🌟 <b>[DÒNG TIỀN THOÁT RA - CẢNH BÁO CHỐT LỜI/EXIT]</b>';
    } else {
      header = '⚠️ 🔴 <b>[DÒNG TIỀN KIỆT SỨC - NÊN THOÁT LỆNH/DỜI SL]</b>';
    }

    const directionEmoji = isEntryBuy ? '📈' : '📉';
    const takerStr = payload.takerBuyRatio !== undefined
      ? isEntryBuy
        ? `<b>Tỷ lệ Mua chủ động:</b> <code>${(payload.takerBuyRatio * 100).toFixed(1)}%</code> 🟢`
        : `<b>Tỷ lệ Bán chủ động:</b> <code>${((1 - payload.takerBuyRatio) * 100).toFixed(1)}%</code> 🔴`
      : '';

    const lines: string[] = [
      header,
      `<b>Symbol:</b> <code>${payload.symbol}</code>`,
      `🎯 <b>DỰ ĐOÁN XÁC SUẤT:</b> <code>${payload.forecastLabel}</code> (Độ tin cậy: <b>${payload.forecastScore}/100</b>)`,
      `<b>Nến 1m Biến động:</b> <code>${payload.priceChangePct >= 0 ? '+' : ''}${payload.priceChangePct.toFixed(2)}%</code> ${directionEmoji} (Nến nổ <b>${payload.volatilitySurgeRatio.toFixed(1)}x</b> so với nền)`,
      payload.change1hPct !== undefined ? `<b>Xu hướng 1h:</b> <code>${payload.change1hPct >= 0 ? '+' : ''}${payload.change1hPct.toFixed(2)}%</code>` : '',
      `<b>Giá Hiện Tại:</b> <code>$${payload.currentPrice}</code> (Open: <code>$${payload.openPrice}</code> | High: <code>$${payload.highPrice}</code>)`,
      `<b>Dòng Tiền (1m Volume):</b> <code>${payload.volume1m.toLocaleString()} USDT</code> (Đột biến <b>${payload.volumeMultiplier.toFixed(1)}x</b>)`,
      takerStr,
    ];

    if (!isExit && payload.suggestedTp1 && payload.suggestedSl) {
      lines.push(
        `--------------`,
        `🎯 <b>Gợi ý Chốt lời TP1 (+3%):</b> <code>$${payload.suggestedTp1.toFixed(4)}</code>`,
        payload.suggestedTp2 ? `🎯 <b>Gợi ý Chốt lời TP2 (+6%):</b> <code>$${payload.suggestedTp2.toFixed(4)}</code>` : '',
        `🛑 <b>Gợi ý Cắt lỗ SL (-1.5%):</b> <code>$${payload.suggestedSl.toFixed(4)}</code>`,
      );
    }

    if (isExit && payload.reasonText) {
      lines.push(
        `--------------`,
        `💡 <b>Lý do cảnh báo:</b> <i>${payload.reasonText}</i>`,
        `👉 <b>Hành động khuyến nghị:</b> Chốt lời một phần hoặc dời Stoploss về Entry để bảo vệ lợi nhuận!`,
      );
    }

    lines.push(
      `⏰ <i>${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</i>`,
      `🔗 <a href="${binanceUrl}">Giao dịch ngay trên Binance Futures</a>`,
    );

    return this.sendMessage(lines.filter(Boolean).join('\n'));
  }
}

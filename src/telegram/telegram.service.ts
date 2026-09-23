import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface SpikeAlertPayload {
  symbol: string;
  direction: 'PUMP' | 'DUMP';
  type: 'EARLY_WAVE_BREAKOUT' | 'CONTINUOUS_WAVE' | 'VOLUME_SURGE';
  priceChangePct: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  currentPrice: number;
  volume1m: number;
  avgVolume: number;
  volumeMultiplier: number;
  volatilitySurgeRatio: number;
  forecastScore: number;       // 0 - 100
  forecastLabel: string;        // e.g. "BẮT ĐẦU SÓNG TĂNG CỰC MẠNH"
  change1hPct?: number;
  takerBuyRatio?: number;
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

  async sendSpikeAlert(payload: SpikeAlertPayload): Promise<boolean> {
    const isPump = payload.direction === 'PUMP';

    // Distinct Header & Emojis based on direction
    let header = '';
    if (isPump) {
      header = payload.type === 'CONTINUOUS_WAVE'
        ? '🚀 🟢 <b>[SÓNG TĂNG LIÊN TỤC] CONTINUOUS PUMP</b>'
        : '🟢 🌊 <b>[TĂNG - BẮT ĐẦU CON SÓNG] BULLISH BREAKOUT</b>';
    } else {
      header = payload.type === 'CONTINUOUS_WAVE'
        ? '🔻 🔴 <b>[SÓNG GIẢM LIÊN TỤC] CONTINUOUS DUMP</b>'
        : '🔴 ⚠️ <b>[GIẢM - XẢ SẢNH / ĐẦU SÓNG GIẢM] BEARISH BREAKDOWN</b>';
    }

    const directionEmoji = isPump ? '📈' : '📉';
    const arrowSymbol = isPump ? '▲ +' : '▼ ';
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;

    const takerBuyStr = payload.takerBuyRatio !== undefined
      ? isPump
        ? `<b>Phe Mua Áp Đảo (Taker Buy):</b> <code>${(payload.takerBuyRatio * 100).toFixed(1)}%</code>`
        : `<b>Phe Bán Áp Đảo (Taker Sell):</b> <code>${((1 - payload.takerBuyRatio) * 100).toFixed(1)}%</code>`
      : '';

    const message = [
      header,
      `<b>Symbol:</b> <code>${payload.symbol}</code>`,
      `🎯 <b>DỰ ĐOÁN:</b> <code>${payload.forecastLabel}</code> (Đánh giá: <b>${payload.forecastScore}/100</b>)`,
      `<b>Nến 1m Biến động:</b> <code>${arrowSymbol}${payload.priceChangePct.toFixed(2)}%</code> ${directionEmoji} (Gấp <b>${payload.volatilitySurgeRatio.toFixed(1)}x</b> so với nền)`,
      payload.change1hPct !== undefined ? `<b>Xu hướng 1h:</b> <code>${payload.change1hPct >= 0 ? '+' : ''}${payload.change1hPct.toFixed(2)}%</code>` : '',
      `<b>Open:</b> <code>$${payload.openPrice}</code> | <b>High:</b> <code>$${payload.highPrice}</code> | <b>Low:</b> <code>$${payload.lowPrice}</code> | <b>Now:</b> <code>$${payload.currentPrice}</code>`,
      `<b>Volume nến 1m:</b> <code>${payload.volume1m.toLocaleString()} USDT</code> (Đột biến <b>${payload.volumeMultiplier.toFixed(1)}x</b>)`,
      takerBuyStr,
      `⏰ <i>${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</i>`,
      `🔗 <a href="${binanceUrl}">Vào lệnh ngay trên Binance Futures</a>`,
    ]
      .filter(Boolean)
      .join('\n');

    return this.sendMessage(message);
  }
}

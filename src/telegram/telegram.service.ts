import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface SpikeAlertPayload {
  symbol: string;
  type: 'PRICE_PUMP' | 'VOLUME_SPIKE';
  priceChangePct: number;
  openPrice: number;
  highPrice: number;
  currentPrice: number;
  volume1m: number;
  avgVolume: number;
  volumeMultiplier: number;
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

  setChatId(id: string) {
    this.chatId = id;
  }

  getChatId(): string {
    return this.chatId;
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
    const isPump = payload.type === 'PRICE_PUMP';
    const titleEmoji = isPump ? '🚀 🚀 🚀 <b>PUMP ALERT (+5% in 1m)</b>' : '📊 🔥 <b>VOLUME SURGE ALERT</b>';
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;
    
    const message = [
      titleEmoji,
      `<b>Symbol:</b> <code>${payload.symbol}</code>`,
      `<b>Price Jump (1m):</b> <code>+${payload.priceChangePct.toFixed(2)}%</code>`,
      `<b>Open:</b> <code>$${payload.openPrice}</code> | <b>High:</b> <code>$${payload.highPrice}</code> | <b>Now:</b> <code>$${payload.currentPrice}</code>`,
      `<b>1m Volume:</b> <code>${payload.volume1m.toLocaleString()} USDT</code>`,
      `<b>Volume Spike:</b> <code>${payload.volumeMultiplier.toFixed(1)}x</code> avg (${payload.avgVolume.toLocaleString()} USDT)`,
      payload.takerBuyRatio ? `<b>Taker Buy Ratio:</b> <code>${(payload.takerBuyRatio * 100).toFixed(1)}%</code>` : '',
      `⏰ <i>${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</i>`,
      `🔗 <a href="${binanceUrl}">Trade on Binance Futures</a>`,
    ]
      .filter(Boolean)
      .join('\n');

    return this.sendMessage(message);
  }
}

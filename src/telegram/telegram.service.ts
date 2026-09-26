import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface VipSpikeAlertPayload {
  signalTier?: 'CUC_NGON' | 'NGON';
  cashflowPatternText?: string;
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
  highestPrice?: number;
  profitPct: number;
  candlesAnalyzed: number;
  takerSellPct: number;
  netCashflowSell: number;
  dropFromPeakPct: number;
  reasonText: string;
}

export interface TakeProfitAlertPayload {
  symbol: string;
  targetLevel: string;
  entryPrice: number;
  currentPrice: number;
  highestPrice?: number;
  profitPct: number;
  suggestedAction: string;
  reasonDetail?: string;
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
  // THÔNG BÁO TÍN HIỆU REALTIME (SIÊU RÚT GỌN - 3 DÒNG TỐI GIẢN)
  // =========================================================================
  async sendVipSpikeAlert(payload: VipSpikeAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;
    const vol1mStr =
      payload.volume1m >= 1_000_000
        ? `${(payload.volume1m / 1_000_000).toFixed(1)}M`
        : `${Math.round(payload.volume1m / 1000)}k`;
    const net1mStr =
      payload.netCashflow1m >= 1_000_000
        ? `+${(payload.netCashflow1m / 1_000_000).toFixed(1)}M`
        : `+${Math.round(payload.netCashflow1m / 1000)}k`;
    const change1mStr = `${payload.priceChangePct >= 0 ? '+' : ''}${payload.priceChangePct.toFixed(2)}%`;

    const lines: string[] = [
      `🚀 <b>#${payload.symbol}</b> | <code>$${payload.currentPrice}</code> (<b>${change1mStr}</b>)`,
      `🌊 Vol <code>${vol1mStr}</code> (<b>${payload.volumeMultiplier.toFixed(1)}x</b>) | Mua: <code>${net1mStr}</code> (<b>${payload.takerBuyPct1m.toFixed(0)}%</b>)`,
      `🎯 TP: <code>$${payload.suggestedTp1.toFixed(4)}</code> | SL: <code>$${payload.suggestedSl.toFixed(4)}</code> | <a href="${binanceUrl}">Binance ↗</a>`,
    ];

    return this.sendMessage(lines.join('\n'));
  }

  // =========================================================================
  // THÔNG BÁO CHỐT LỜI TP1 / TP2 (SIÊU RÚT GỌN)
  // =========================================================================
  async sendTakeProfitAlert(payload: TakeProfitAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;
    return this.sendMessage(
      `💰 <b>[TP ${payload.targetLevel}] #${payload.symbol} (+${payload.profitPct.toFixed(2)}%)</b>\n• Giá: <code>$${payload.entryPrice}</code> ➔ <code>$${payload.currentPrice}</code> | ${payload.suggestedAction} | <a href="${binanceUrl}">Binance ↗</a>`,
    );
  }

  // =========================================================================
  // THÔNG BÁO DỪNG LỖ / BẢO TOÀN VỐN (SIÊU RÚT GỌN)
  // =========================================================================
  async sendStopLossAlert(payload: StopLossAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;
    return this.sendMessage(
      `🛑 <b>[SL] #${payload.symbol} (${payload.lossPct.toFixed(2)}%)</b>\n• Giá: <code>$${payload.entryPrice}</code> ➔ <code>$${payload.currentPrice}</code> | <a href="${binanceUrl}">Binance ↗</a>`,
    );
  }

  // =========================================================================
  // THÔNG BÁO CẢNH BÁO: SUY YẾU DÒNG TIỀN - THOÁT LỆNH (SIÊU RÚT GỌN)
  // =========================================================================
  async sendHetNgonMultiCandleAlert(payload: HetNgonAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;
    const pnlSign = payload.profitPct >= 0 ? '+' : '';
    return this.sendMessage(
      `⚠️ <b>[THOÁT LỆNH] #${payload.symbol} (${pnlSign}${payload.profitPct.toFixed(2)}%)</b>\n• Giá: <code>$${payload.entryPrice}</code> ➔ <code>$${payload.currentPrice}</code> | Sell: <b>${payload.takerSellPct.toFixed(0)}%</b> | <a href="${binanceUrl}">Binance ↗</a>`,
    );
  }

  // =========================================================================
  // THÔNG BÁO BÁO CÁO DÒNG TIỀN (RÚT GỌN TOP 7)
  // =========================================================================
  async sendCashflowReportAlert(data: {
    inflow: Array<{ symbol: string; netInflowUsdt: number; volumeUsdt: number; priceChangePct: number; takerBuyPct: number }>;
    outflow: Array<{ symbol: string; netOutflowUsdt: number; volumeUsdt: number; priceChangePct: number; takerSellPct: number }>;
    strongDailyBuys?: Array<{ symbol: string; takerBuyUsdt: number; priceChangePct: number; takerBuyPct: number }>;
  }): Promise<boolean> {
    const timeString = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

    const lines: string[] = [
      `📊 <b>[BÁO CÁO DÒNG TIỀN FUTURES]</b> <i>${timeString}</i>`,
      '🟢 <b>TOP DÒNG TIỀN VÀO (INFLOW):</b>',
    ];

    data.inflow.slice(0, 7).forEach((item, idx) => {
      const netStr = `+${Math.round(item.netInflowUsdt / 1000)}k`;
      const changeStr = `${item.priceChangePct >= 0 ? '+' : ''}${item.priceChangePct.toFixed(1)}%`;
      lines.push(`${idx + 1}. <b>#${item.symbol}</b>: <code>${netStr}</code> (${changeStr}) | Buy: <b>${item.takerBuyPct.toFixed(0)}%</b>`);
    });

    lines.push('🔴 <b>TOP DÒNG TIỀN RA (OUTFLOW):</b>');
    data.outflow.slice(0, 7).forEach((item, idx) => {
      const netStr = `-${Math.round(item.netOutflowUsdt / 1000)}k`;
      const changeStr = `${item.priceChangePct >= 0 ? '+' : ''}${item.priceChangePct.toFixed(1)}%`;
      lines.push(`${idx + 1}. <b>#${item.symbol}</b>: <code>${netStr}</code> (${changeStr}) | Sell: <b>${item.takerSellPct.toFixed(0)}%</b>`);
    });

    if (data.strongDailyBuys && data.strongDailyBuys.length > 0) {
      lines.push('🚀 <b>LỰC MUA KHUNG 1D MẠNH:</b>');
      data.strongDailyBuys.slice(0, 5).forEach((item, idx) => {
        const buyVolStr = `${(item.takerBuyUsdt / 1_000_000).toFixed(1)}M`;
        const changeStr = `${item.priceChangePct >= 0 ? '+' : ''}${item.priceChangePct.toFixed(1)}%`;
        lines.push(`${idx + 1}. <b>#${item.symbol}</b>: <code>${buyVolStr}</code> (${changeStr}) | Buy: <b>${item.takerBuyPct.toFixed(0)}%</b>`);
      });
    }

    return this.sendMessage(lines.join('\n'));
  }
}



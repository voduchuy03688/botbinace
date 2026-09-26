import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { DetectorOutput } from '../detector/types/detector-output.types.js';

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
  // THÔNG BÁO CHÂN SÓNG SỚM (EARLY EXPANSION - SIÊU NGẮN 2 DÒNG)
  // =========================================================================
  async sendEarlyExpansionAlert(
    output: DetectorOutput,
    currentPrice: number,
  ): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${output.symbol}`;
    const suggestedTp = currentPrice * 1.032;
    const suggestedSl = currentPrice * 0.975;

    const lines: string[] = [
      `⚡ <b>[CHÂN SÓNG] #${output.symbol}</b> | Giá: <code>$${currentPrice}</code>`,
      `🎯 TP: <code>$${suggestedTp.toFixed(4)}</code> (+3.2%) | SL: <code>$${suggestedSl.toFixed(4)}</code> (-2.5%) | <a href="${binanceUrl}">Binance ↗</a>`,
    ];

    return this.sendMessage(lines.join('\n'));
  }

  // =========================================================================
  // THÔNG BÁO TÍN HIỆU REALTIME (SIÊU NGẮN 2 DÒNG)
  // =========================================================================
  async sendVipSpikeAlert(payload: VipSpikeAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;
    const change1mStr = `${payload.priceChangePct >= 0 ? '+' : ''}${payload.priceChangePct.toFixed(2)}%`;

    const lines: string[] = [
      `🚀 <b>#${payload.symbol}</b> | Giá: <code>$${payload.currentPrice}</code> (${change1mStr})`,
      `🎯 TP: <code>$${payload.suggestedTp1.toFixed(4)}</code> | SL: <code>$${payload.suggestedSl.toFixed(4)}</code> | <a href="${binanceUrl}">Binance ↗</a>`,
    ];

    return this.sendMessage(lines.join('\n'));
  }

  // =========================================================================
  // THÔNG BÁO CHỐT LỜI TP1 / TP2 (1 DÒNG TỐI GIẢN)
  // =========================================================================
  async sendTakeProfitAlert(payload: TakeProfitAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;
    return this.sendMessage(
      `💰 <b>[${payload.targetLevel}] #${payload.symbol} (+${payload.profitPct.toFixed(2)}%)</b> | Giá: <code>$${payload.currentPrice}</code> | <a href="${binanceUrl}">Binance ↗</a>`,
    );
  }

  // =========================================================================
  // THÔNG BÁO DỪNG LỖ / BẢO TOÀN VỐN (1 DÒNG TỐI GIẢN)
  // =========================================================================
  async sendStopLossAlert(payload: StopLossAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;
    return this.sendMessage(
      `🛑 <b>[SL] #${payload.symbol} (${payload.lossPct.toFixed(2)}%)</b> | Giá: <code>$${payload.currentPrice}</code> | <a href="${binanceUrl}">Binance ↗</a>`,
    );
  }

  // =========================================================================
  // THÔNG BÁO CẢNH BÁO: THOÁT LỆNH (1 DÒNG TỐI GIẢN)
  // =========================================================================
  async sendHetNgonMultiCandleAlert(payload: HetNgonAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;
    const pnlSign = payload.profitPct >= 0 ? '+' : '';
    return this.sendMessage(
      `⚠️ <b>[THOÁT] #${payload.symbol} (${pnlSign}${payload.profitPct.toFixed(2)}%)</b> | Giá: <code>$${payload.currentPrice}</code> | <a href="${binanceUrl}">Binance ↗</a>`,
    );
  }

  // =========================================================================
  // THÔNG BÁO BÁO CÁO DÒNG TIỀN (3 DÒNG TỐI GIẢN)
  // =========================================================================
  async sendCashflowReportAlert(data: {
    inflow: Array<{ symbol: string; netInflowUsdt: number; volumeUsdt: number; priceChangePct: number; takerBuyPct: number }>;
    outflow: Array<{ symbol: string; netOutflowUsdt: number; volumeUsdt: number; priceChangePct: number; takerSellPct: number }>;
    strongDailyBuys?: Array<{ symbol: string; takerBuyUsdt: number; priceChangePct: number; takerBuyPct: number }>;
  }): Promise<boolean> {
    const lines: string[] = [
      `📊 <b>BÁO CÁO DÒNG TIỀN FUTURES</b>`,
      `🟢 Inflow: ` + data.inflow.slice(0, 4).map(i => `#${i.symbol} (+${Math.round(i.netInflowUsdt / 1000)}k)`).join(', '),
      `🔴 Outflow: ` + data.outflow.slice(0, 4).map(i => `#${i.symbol} (-${Math.round(i.netOutflowUsdt / 1000)}k)`).join(', '),
    ];

    return this.sendMessage(lines.join('\n'));
  }
}



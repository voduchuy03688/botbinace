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
  // THÔNG BÁO TÍN HIỆU REALTIME (RÚT GỌN - CHỈ BÁO COIN BƠM DÒNG TIỀN & BẬT TĂNG MẠNH)
  // =========================================================================
  async sendVipSpikeAlert(payload: VipSpikeAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;
    const vol1mStr = payload.volume1m >= 1_000_000
      ? `${(payload.volume1m / 1_000_000).toFixed(2)}M`
      : `${Math.round(payload.volume1m / 1000)}k`;
    const net1mStr = payload.netCashflow1m >= 1_000_000
      ? `+${(payload.netCashflow1m / 1_000_000).toFixed(2)}M`
      : `+${Math.round(payload.netCashflow1m / 1000)}k`;
    const change1mStr = `${payload.priceChangePct >= 0 ? '+' : ''}${payload.priceChangePct.toFixed(2)}%`;
    const change24hStr = `${payload.change24hPct >= 0 ? '+' : ''}${payload.change24hPct.toFixed(1)}%`;

    const lines: string[] = [
      `🚀 <b>${payload.symbol}</b> | <b>BƠM MẠNH DÒNG TIỀN VÀO</b>`,
      `💵 <b>Giá:</b> <code>$${payload.currentPrice}</code> (1m: <b>${change1mStr}</b> | 24h: <b>${change24hStr}</b>)`,
      `🌊 <b>Dòng tiền:</b> Vol <code>${vol1mStr}</code> (<b>${payload.volumeMultiplier.toFixed(1)}x</b>) | Mua ròng: <code>${net1mStr}</code> (<b>${payload.takerBuyPct1m.toFixed(0)}%</b>)`,
      `🎯 <b>Entry:</b> <code>$${payload.entryPrice}</code> | <b>TP:</b> <code>$${payload.suggestedTp1.toFixed(4)}</code> (+3.2%) | <b>SL:</b> <code>$${payload.suggestedSl.toFixed(4)}</code>`,
      `🔗 <a href="${binanceUrl}">Binance Futures</a>`,
    ];

    return this.sendMessage(lines.join('\n'));
  }

  // =========================================================================
  // THÔNG BÁO CHỐT LỜI TP1 / TP2 (RÚT GỌN)
  // =========================================================================
  async sendTakeProfitAlert(payload: TakeProfitAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;
    const highestText = payload.highestPrice ? ` | Đỉnh: <code>$${payload.highestPrice}</code>` : '';

    const lines: string[] = [
      `💰 <b>[CHỐT LỜI ${payload.targetLevel}] ${payload.symbol} (+${payload.profitPct.toFixed(2)}%)</b>${highestText}`,
      `• <b>Giá:</b> Entry <code>$${payload.entryPrice}</code> ➔ Chốt <code>$${payload.currentPrice}</code>`,
      `• <b>Hành động:</b> <b>${payload.suggestedAction}</b>`,
      ...(payload.reasonDetail ? [`• <i>${payload.reasonDetail}</i>`] : []),
      `🔗 <a href="${binanceUrl}">Binance Futures</a>`,
    ];

    return this.sendMessage(lines.join('\n'));
  }

  // =========================================================================
  // THÔNG BÁO DỪNG LỖ / BẢO TOÀN VỐN (RÚT GỌN)
  // =========================================================================
  async sendStopLossAlert(payload: StopLossAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;

    const lines: string[] = [
      `🛑 <b>[CẮT LỖ BẢO TOÀN VỐN] ${payload.symbol} (${payload.lossPct.toFixed(2)}%)</b>`,
      `• <b>Giá:</b> Entry <code>$${payload.entryPrice}</code> ➔ Thoát <code>$${payload.currentPrice}</code>`,
      `• <b>Lý do:</b> <i>${payload.reasonText}</i>`,
      `🔗 <a href="${binanceUrl}">Binance Futures</a>`,
    ];

    return this.sendMessage(lines.join('\n'));
  }

  // =========================================================================
  // THÔNG BÁO CẢNH BÁO: SUY YẾU DÒNG TIỀN - THOÁT LỆNH (RÚT GỌN)
  // =========================================================================
  async sendHetNgonMultiCandleAlert(payload: HetNgonAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;
    const pnlSign = payload.profitPct >= 0 ? '+' : '';

    const lines: string[] = [
      `⚠️ <b>[DÒNG TIỀN SUY YẾU - THOÁT LỆNH] ${payload.symbol}</b>`,
      `• <b>Vị thế:</b> <b>${pnlSign}${payload.profitPct.toFixed(2)}%</b> (Entry: <code>$${payload.entryPrice}</code> ➔ Thoát: <code>$${payload.currentPrice}</code>)`,
      `• <b>Dòng tiền bán:</b> Taker Sell <b>${payload.takerSellPct.toFixed(1)}%</b> | Rút ròng: <code>-${Math.round(Math.abs(payload.netCashflowSell)).toLocaleString()} USDT</code>`,
      `• <b>Lý do:</b> <i>${payload.reasonText}</i>`,
      `🔗 <a href="${binanceUrl}">Binance Futures</a>`,
    ];

    return this.sendMessage(lines.filter(Boolean).join('\n'));
  }

  // =========================================================================
  // THÔNG BÁO BÁO CÁO DÒNG TIỀN VÀO, DÒNG TIỀN RA & COIN LỰC MUA MẠNH KHUNG 1D (GỬI LÚC 00:00 VÀ 12:00)
  // =========================================================================
  async sendCashflowReportAlert(data: {
    inflow: Array<{ symbol: string; netInflowUsdt: number; volumeUsdt: number; priceChangePct: number; takerBuyPct: number }>;
    outflow: Array<{ symbol: string; netOutflowUsdt: number; volumeUsdt: number; priceChangePct: number; takerSellPct: number }>;
    strongDailyBuys?: Array<{ symbol: string; takerBuyUsdt: number; priceChangePct: number; takerBuyPct: number }>;
  }): Promise<boolean> {
    const timeString = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

    const lines: string[] = [
      '📊 🌊 <b>[BÁO CÁO DÒNG TIỀN & LỰC MUA MẠNH KHUNG 1D BINANCE FUTURES]</b>',
      `⏰ <b>Thời gian:</b> <i>${timeString}</i>`,
      '----------------------------------------',
      '🟢 <b>TOP 15 COIN DÒNG TIỀN VÀO MẠNH NHẤT (NET INFLOW):</b>',
    ];

    if (data.inflow.length === 0) {
      lines.push('<i>Khởi tạo chưa ghi nhận coin đạt tiêu chuẩn dòng tiền vào.</i>');
    } else {
      data.inflow.forEach((item, idx) => {
        const netStr = `+${Math.round(item.netInflowUsdt / 1000).toLocaleString()}k USDT`;
        const changeStr = `${item.priceChangePct >= 0 ? '+' : ''}${item.priceChangePct.toFixed(1)}%`;
        lines.push(
          `${idx + 1}. <b>${item.symbol}</b> | Mua ròng: <code>${netStr}</code> | 24h: <b>${changeStr}</b> | Buy: <b>${item.takerBuyPct.toFixed(0)}%</b>`,
        );
      });
    }

    lines.push('----------------------------------------');
    lines.push('🔴 <b>TOP 15 COIN DÒNG TIỀN RA MẠNH NHẤT (NET OUTFLOW):</b>');

    if (data.outflow.length === 0) {
      lines.push('<i>Khởi tạo chưa ghi nhận coin đạt tiêu chuẩn dòng tiền ra.</i>');
    } else {
      data.outflow.forEach((item, idx) => {
        const netStr = `-${Math.round(item.netOutflowUsdt / 1000).toLocaleString()}k USDT`;
        const changeStr = `${item.priceChangePct >= 0 ? '+' : ''}${item.priceChangePct.toFixed(1)}%`;
        lines.push(
          `${idx + 1}. <b>${item.symbol}</b> | Bán ròng: <code>${netStr}</code> | 24h: <b>${changeStr}</b> | Sell: <b>${item.takerSellPct.toFixed(0)}%</b>`,
        );
      });
    }

    if (data.strongDailyBuys && data.strongDailyBuys.length > 0) {
      lines.push('----------------------------------------');
      lines.push('🚀 🚀 <b>TOP COIN CÓ LỰC MUA MẠNH TRONG NẾN 1 NGÀY (KHUNG 1D):</b>');
      data.strongDailyBuys.forEach((item, idx) => {
        const buyVolStr = `${Math.round(item.takerBuyUsdt / 1_000_000).toFixed(1)}M USDT`;
        const changeStr = `${item.priceChangePct >= 0 ? '+' : ''}${item.priceChangePct.toFixed(1)}%`;
        lines.push(
          `${idx + 1}. <b>${item.symbol}</b> | Mua 1D: <code>${buyVolStr}</code> | 24h: <b>${changeStr}</b> | Buy: <b>${item.takerBuyPct.toFixed(0)}%</b>`,
        );
      });
    }

    lines.push('----------------------------------------');
    lines.push('💡 <i>Tự động cập nhật 2 lần/ngày (lúc 12:00 và 00:00).</i>');

    return this.sendMessage(lines.join('\n'));
  }
}



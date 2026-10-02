import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { DetectorOutput } from '../detector/types/detector-output.types.js';
import { CashflowReportData } from '../binance/binance.service.js';

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

    // Nếu tin nhắn vượt quá giới hạn 4096 ký tự của Telegram, tự động chia nhỏ theo dòng
    if (text.length > 4000) {
      const lines = text.split('\n');
      const chunks: string[] = [];
      let currentChunk = '';
      for (const line of lines) {
        if ((currentChunk + '\n' + line).length > 3900) {
          if (currentChunk) chunks.push(currentChunk);
          currentChunk = line;
        } else {
          currentChunk = currentChunk ? currentChunk + '\n' + line : line;
        }
      }
      if (currentChunk) chunks.push(currentChunk);

      let success = true;
      for (const chunk of chunks) {
        const ok = await this.sendDirect(chunk);
        if (!ok) success = false;
        await new Promise((r) => setTimeout(r, 300));
      }
      return success;
    }

    return this.sendDirect(text);
  }

  private async sendDirect(text: string): Promise<boolean> {
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
  // THÔNG BÁO CỰC NGON (KÈM KHỐI LƯỢNG MUA) - SIÊU GỌN 2 DÒNG
  // =========================================================================
  async sendEarlyExpansionAlert(
    output: DetectorOutput,
    currentPrice: number,
    buyVol = 0,
  ): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${output.symbol}`;
    const suggestedTp = currentPrice * 1.032;
    const suggestedSl = currentPrice * 0.975;
    const buyPct = Math.round(output.buyPressure * 100);
    const buyVolStr =
      buyVol >= 1_000_000
        ? `$${(buyVol / 1_000_000).toFixed(2)}M`
        : buyVol > 0
          ? `$${Math.round(buyVol / 1000)}k`
          : '';

    const lines: string[] = [
      `💎 <b>[CỰC NGON] #${output.symbol}</b> | Giá: <code>$${currentPrice}</code>`,
      `🟢 Mua: <b>${buyVolStr ? buyVolStr + ' ' : ''}(${buyPct}%)</b> | TP: <code>$${suggestedTp.toFixed(4)}</code> | SL: <code>$${suggestedSl.toFixed(4)}</code> | <a href="${binanceUrl}">Binance ↗</a>`,
    ];

    return this.sendMessage(lines.join('\n'));
  }

  // =========================================================================
  // THÔNG BÁO TÍN HIỆU CỰC NGON (KÈM KHỐI LƯỢNG MUA) - SIÊU GỌN 2 DÒNG
  // =========================================================================
  async sendVipSpikeAlert(payload: VipSpikeAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;
    const buyVol = payload.takerBuyVol1m || payload.netCashflow1m || 0;
    const buyVolStr =
      buyVol >= 1_000_000
        ? `$${(buyVol / 1_000_000).toFixed(2)}M`
        : `$${Math.round(buyVol / 1000)}k`;

    const lines: string[] = [
      `💎 <b>[CỰC NGON] #${payload.symbol}</b> | Giá: <code>$${payload.currentPrice}</code>`,
      `🟢 Mua: <b>${buyVolStr}</b> (${payload.takerBuyPct1m.toFixed(0)}%) | TP: <code>$${payload.suggestedTp1.toFixed(4)}</code> | SL: <code>$${payload.suggestedSl.toFixed(4)}</code> | <a href="${binanceUrl}">Binance ↗</a>`,
    ];

    return this.sendMessage(lines.join('\n'));
  }

  // =========================================================================
  // THÔNG BÁO CỰC NGON - BẮT CHỈNH (KÈM KHỐI LƯỢNG MUA) - SIÊU GỌN 2 DÒNG
  // =========================================================================
  async sendPullbackDipAlert(data: {
    symbol: string;
    currentPrice: number;
    pullbackPct: number;
    buyVolume: number;
    takerBuyPct: number;
    suggestedTp: number;
    suggestedSl: number;
  }): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${data.symbol}`;
    const buyVolStr =
      data.buyVolume >= 1_000_000
        ? `$${(data.buyVolume / 1_000_000).toFixed(2)}M`
        : `$${Math.round(data.buyVolume / 1000)}k`;

    const lines: string[] = [
      `💎 <b>[CỰC NGON - BẮT CHỈNH] #${data.symbol}</b> | Giá: <code>$${data.currentPrice}</code>`,
      `🟢 Mua: <b>${buyVolStr}</b> (${data.takerBuyPct.toFixed(0)}%) | Chỉnh <b>-${data.pullbackPct.toFixed(1)}%</b> | TP: <code>$${data.suggestedTp.toFixed(4)}</code> | SL: <code>$${data.suggestedSl.toFixed(4)}</code> | <a href="${binanceUrl}">Binance ↗</a>`,
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
  // THÔNG BÁO HẾT NGON (KÈM KHỐI LƯỢNG BÁN) - SIÊU GỌN 2 DÒNG
  // =========================================================================
  async sendHetNgonMultiCandleAlert(payload: HetNgonAlertPayload): Promise<boolean> {
    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;
    const pnlSign = payload.profitPct >= 0 ? '+' : '';
    const sellVol = payload.netCashflowSell || 0;
    const sellVolStr =
      sellVol >= 1_000_000
        ? `$${(sellVol / 1_000_000).toFixed(2)}M`
        : `$${Math.round(sellVol / 1000)}k`;

    const lines: string[] = [
      `🛑 <b>[HẾT NGON] #${payload.symbol}</b> | Giá: <code>$${payload.currentPrice}</code> (${pnlSign}${payload.profitPct.toFixed(2)}%)`,
      `🔴 Bán: <b>${sellVolStr}</b> (${payload.takerSellPct.toFixed(0)}%) | <a href="${binanceUrl}">Binance ↗</a>`,
    ];

    return this.sendMessage(lines.join('\n'));
  }

  // =========================================================================
  // THÔNG BÁO BÁO CÁO DÒNG TIỀN & ĐỘT BIẾN THANH KHOẢN (TOP 20)
  // =========================================================================
  async sendCashflowReportAlert(data: CashflowReportData): Promise<boolean> {
    const tf = data.timeframeHours || 4;
    const topLimit = data.topLimit || 20;
    const tfLabel = tf === 24 ? '1 NGÀY' : `${tf}H`;

    const formatMoney = (val: number): string => {
      const abs = Math.abs(val);
      if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
      if (abs >= 1_000) return `$${Math.round(abs / 1_000)}k`;
      return `$${Math.round(abs)}`;
    };

    // PHẦN 1: DẤU HIỆU CÁ VOI GOM HÀNG, ANH CẢ BTC & TOP TOKEN GOM HÀNG
    const part1Lines: string[] = [
      `🐋 <b>BÁO CÁO CÁ VOI GOM HÀNG & DÒNG TIỀN (${tfLabel})</b>`,
      `⏰ <i>Chu kỳ: ${tfLabel} / lần | Quét toàn bộ Futures Binance</i>`,
      '',
      `🔍 <b>DẤU HIỆU NHẬN BIẾT CÁ VOI GOM HÀNG:</b>`,
      `1️⃣ <b>Nền thanh khoản cạn</b>: Trước đó 1-5 ngày volume rất nhỏ, đi ngang nén chặt.`,
      `2️⃣ <b>Volume bùng nổ</b>: Khối lượng ${tfLabel} đột biến gấp <b>1.8x - 10x+</b> so với nền.`,
      `3️⃣ <b>Phe Mua gom áp đảo</b>: Taker Mua &gt;= 53%, Tiền gom ròng (Net Inflow) dương lớn.`,
      `4️⃣ <b>Giá giữ vững nền</b>: Không bị xả đè đầu, gom âm thầm hoặc rút chân quét đáy / bứt phá.`,
      '━━━━━━━━━━━━━━━━━━━━━',
    ];

    if (data.btc) {
      const btc = data.btc;
      const btcTfSign = (btc.priceChangePctTf ?? btc.priceChangePct) >= 0 ? '+' : '';
      const btc24hSign = btc.priceChangePct24h >= 0 ? '+' : '';
      const netTf = btc.netInflowTf ?? btc.netInflowUsdt;
      const flowSignTf = netTf >= 0 ? '+' : '-';
      const flowSign24h = btc.netInflow24h >= 0 ? '+' : '-';
      const takerBuyPctTf = btc.takerBuyPctTf ?? btc.takerBuyPct;
      const btcState =
        netTf > 0
          ? '🟢 Gom ròng (Inflow)'
          : '🔴 Xả ròng (Outflow)';
      const btcUrl = `https://www.binance.com/en/futures/BTCUSDT`;

      part1Lines.push(
        `👑 <b>ANH CẢ BITCOIN (#BTCUSDT):</b>`,
        `• Giá: <code>$${btc.currentPrice.toLocaleString('en-US')}</code> (${tfLabel}: ${btcTfSign}${(btc.priceChangePctTf ?? btc.priceChangePct).toFixed(2)}% | 24h: ${btc24hSign}${btc.priceChangePct24h.toFixed(2)}%)`,
        `• Dòng tiền ${tfLabel}: <b>${flowSignTf}${formatMoney(netTf)}</b> (Mua: ${takerBuyPctTf.toFixed(1)}%)`,
        `• Dòng tiền 24h: <b>${flowSign24h}${formatMoney(btc.netInflow24h)}</b> (Mua: ${btc.takerBuyPct24h.toFixed(1)}%)`,
        `• Trạng thái: ${btcState} | <a href="${btcUrl}">Binance ↗</a>`,
        '━━━━━━━━━━━━━━━━━━━━━',
      );
    }

    const spikes = data.suddenSpikes || data.sudden1hSpikes || [];
    part1Lines.push(`⚡ <b>TOP TOKEN CÓ DẤU HIỆU CÁ VOI GOM HÀNG (${tfLabel}):</b>`);
    part1Lines.push(`<i>(Các token thanh khoản nhỏ nhiều ngày trước, đột nhiên bùng nổ volume gom mua)</i>`);
    if (!spikes || spikes.length === 0) {
      part1Lines.push('<i>Chưa ghi nhận coin có dấu hiệu cá voi gom đột biến trong chu kỳ này.</i>');
    } else {
      spikes.slice(0, topLimit).forEach((item, index) => {
        const sign = item.priceChangePct >= 0 ? '+' : '';
        const url = `https://www.binance.com/en/futures/${item.symbol}`;
        const pattern = item.accumulationPattern ? ` [<b>${item.accumulationPattern}</b>]` : '';
        part1Lines.push(
          `${index + 1}. <b>#${item.symbol}</b>: <b>x${item.spikeRatio.toFixed(1)} Vol</b>${pattern}`,
          `   • Vol: <b>${formatMoney(item.currentVol)}</b> (Nền cũ: ${formatMoney(item.prevAvgVol)}) | Mua: <b>${item.takerBuyPct.toFixed(0)}%</b> (+<b>${formatMoney(item.netInflowUsdt)}</b>) | Giá: <b>${sign}${item.priceChangePct.toFixed(1)}%</b> | <a href="${url}">Xem ↗</a>`,
        );
      });
    }

    // PHẦN 2: BẢNG XẾP HẠNG DÒNG TIỀN GOM RÒNG & XẢ RÒNG (TOP 20)
    const part2Lines: string[] = [
      `📊 <b>BẢNG XẾP HẠNG DÒNG TIỀN (${tfLabel}) - PHẦN 2</b>`,
      '━━━━━━━━━━━━━━━━━━━━━',
      `🟢 <b>TOP ${topLimit} DÒNG TIỀN GOM RÒNG (${tfLabel}):</b>`,
    ];

    if (!data.inflow || data.inflow.length === 0) {
      part2Lines.push('<i>Chưa ghi nhận coin có dòng tiền gom mạnh.</i>');
    } else {
      data.inflow.slice(0, topLimit).forEach((item, index) => {
        const sign = item.priceChangePct >= 0 ? '+' : '';
        const url = `https://www.binance.com/en/futures/${item.symbol}`;
        part2Lines.push(
          `${index + 1}. <b>#${item.symbol}</b>: <b>+${formatMoney(item.netInflowUsdt)}</b> (Mua: ${item.takerBuyPct.toFixed(0)}%) | Vol: ${formatMoney(item.volumeUsdt)} | ${tfLabel}: <b>${sign}${item.priceChangePct.toFixed(1)}%</b> | <a href="${url}">Xem ↗</a>`,
        );
      });
    }

    part2Lines.push('━━━━━━━━━━━━━━━━━━━━━');
    part2Lines.push(`🔴 <b>TOP ${topLimit} DÒNG TIỀN XẢ RÒNG (${tfLabel} - CẢNH BÁO RÚT VỐN):</b>`);
    if (!data.outflow || data.outflow.length === 0) {
      part2Lines.push('<i>Chưa ghi nhận coin có dòng tiền xả mạnh đột biến.</i>');
    } else {
      data.outflow.slice(0, topLimit).forEach((item, index) => {
        const sign = item.priceChangePct >= 0 ? '+' : '';
        const url = `https://www.binance.com/en/futures/${item.symbol}`;
        const sellPct = 100 - item.takerBuyPct;
        part2Lines.push(
          `${index + 1}. <b>#${item.symbol}</b>: <b>-${formatMoney(item.netInflowUsdt)}</b> (Bán: ${sellPct.toFixed(0)}%) | Vol: ${formatMoney(item.volumeUsdt)} | ${tfLabel}: <b>${sign}${item.priceChangePct.toFixed(1)}%</b> | <a href="${url}">Xem ↗</a>`,
        );
      });
    }

    // Gửi tin nhắn phần 1, sau đó gửi phần 2 để không bao giờ bị nghẽn giới hạn 4096 ký tự
    const res1 = await this.sendMessage(part1Lines.join('\n'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const res2 = await this.sendMessage(part2Lines.join('\n'));

    return res1 && res2;
  }
}



import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface OrderflowAlertPayload {
  symbol: string;
  patternType:
    | 'NET_INFLOW_PUMP'       // Dòng tiền mua dồn dập + Giá tăng -> ĐẦU SÓNG TĂNG
    | 'ACCUMULATION_DIP'     // Giá giảm/đi ngang nhưng Dòng tiền mua gom âm thầm -> TÍCH LŨY DƯỚI ĐÁY
    | 'DISTRIBUTION_TRAP'    // Giá tăng nhưng Dòng tiền bán xả chèn ép -> BẪY TĂNG GIẢ (BẮT ĐẦU XẢ)
    | 'NET_OUTFLOW_DUMP'     // Dòng tiền bán tháo + Giá giảm mạnh -> ĐẦU SÓNG GIẢM / CHỐT LỜI
    | 'EXIT_TAKE_PROFIT';    // Dòng tiền mua kiệt sức -> CẢNH BÁO CHỐT LỜI

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
  forecastScore: number;         // 0 - 100 điểm tin cậy
  forecastLabel: string;         // Nhãn dự đoán tiếng Việt

  suggestedTp1?: number;
  suggestedTp2?: number;
  suggestedSl?: number;
  change1hPct?: number;
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

  async sendOrderflowAlert(payload: OrderflowAlertPayload): Promise<boolean> {
    let header = '';
    let patternNote = '';

    switch (payload.patternType) {
      case 'NET_INFLOW_PUMP':
        header = '🟢 🚀 <b>[DÒNG TIỀN MUA VÀO ẠT - BẮT ĐẦU SÓNG TĂNG]</b>';
        patternNote = '🔥 <i>Dòng tiền ròng Mua vào bùng nổ, phe Mua làm chủ hoàn toàn thị trường!</i>';
        break;
      case 'ACCUMULATION_DIP':
        header = '🟢 💎 <b>[TÍCH LŨY ÂM THẦM - GIÁ GIẢM NHƯNG CÁ MẠP DỒN TIỀN MUA]</b>';
        patternNote = '💡 <i>Giá đang giảm nhẹ/đi ngang nhưng Volume Mua Taker áp đảo $\\rightarrow$ Cá mập âm thầm gom hàng dưới đáy!</i>';
        break;
      case 'DISTRIBUTION_TRAP':
        header = '⚠️ 🔴 <b>[CẢNH BÁO BẪY TĂNG GIẢ - GIÁ TĂNG NHƯNG DÒNG TIỀN ĐANG XẢ]</b>';
        patternNote = '🚨 <i>Giá đẩy tăng nhẹ nhưng Lực Bán Taker xả cực mạnh $\\rightarrow$ Bẫy dụ nhỏ lẻ vào để xả hàng!</i>';
        break;
      case 'NET_OUTFLOW_DUMP':
        header = '🔴 🔻 <b>[DÒNG TIỀN BÁN XẢ THÁO - BẮT ĐẦU SÓNG GIẢM]</b>';
        patternNote = '💥 <i>Lực Bán chủ động xả tháo ạt, dòng tiền rút khỏi thị trường mạnh mẽ!</i>';
        break;
      case 'EXIT_TAKE_PROFIT':
        header = '💰 🌟 <b>[DÒNG TIỀN MUA KIỆT SỨC - KHUYẾN NGHỊ CHỐT LỜI]</b>';
        patternNote = '💡 <i>Lực Mua dừng lại và Lực Bán gia tăng $\\rightarrow$ Hãy chốt lời hoặc dời SL bảo vệ lợi nhuận!</i>';
        break;
    }

    const netCashflowStr = payload.netCashflow >= 0
      ? `+${Math.round(payload.netCashflow).toLocaleString()} USDT (DÒNG TIỀN VÀO 🟢)`
      : `${Math.round(payload.netCashflow).toLocaleString()} USDT (DÒNG TIỀN RÚT 🔴)`;

    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;

    const lines: string[] = [
      header,
      `<b>Mã Coin:</b> <code>${payload.symbol}</code>`,
      `🎯 <b>DỰ ĐOÁN XÁC SUẤT:</b> <code>${payload.forecastLabel}</code> (Độ tin cậy: <b>${payload.forecastScore}/100</b>)`,
      patternNote,
      `----------------------------------------`,
      `📊 <b>PHÂN TÍCH DÒNG TIỀN MUA / BÁN (1 PHÚT):</b>`,
      `• <b>Dòng Tiền Ròng (Net Flow):</b> <code>${netCashflowStr}</code>`,
      `• <b>Volume Mua Chủ Động (Taker Buy):</b> <code>${Math.round(payload.takerBuyVol).toLocaleString()} USDT</code> (<b>${payload.takerBuyPct.toFixed(1)}%</b>)`,
      `• <b>Volume Bán Chủ Động (Taker Sell):</b> <code>${Math.round(payload.takerSellVol).toLocaleString()} USDT</code> (<b>${(100 - payload.takerBuyPct).toFixed(1)}%</b>)`,
      `• <b>Tổng Volume 1m:</b> <code>${Math.round(payload.volume1m).toLocaleString()} USDT</code> (Đột biến <b>${payload.volumeMultiplier.toFixed(1)}x</b>)`,
      `----------------------------------------`,
      `📈 <b>BIẾN ĐỘNG GIÁ & XU HƯỚNG:</b>`,
      `• <b>Nến 1 phút:</b> <code>${payload.priceChangePct >= 0 ? '+' : ''}${payload.priceChangePct.toFixed(2)}%</code> (Nổ biên độ <b>${payload.volatilitySurgeRatio.toFixed(1)}x</b>)`,
      payload.change1hPct !== undefined ? `• <b>Xu hướng 1 giờ:</b> <code>${payload.change1hPct >= 0 ? '+' : ''}${payload.change1hPct.toFixed(2)}%</code>` : '',
      `• <b>Giá Hiện Tại:</b> <code>$${payload.currentPrice}</code> (Mở: <code>$${payload.openPrice}</code> | Cao nhất: <code>$${payload.highPrice}</code> | Thấp nhất: <code>$${payload.lowPrice}</code>)`,
    ];

    if (payload.patternType !== 'EXIT_TAKE_PROFIT' && payload.suggestedTp1 && payload.suggestedSl) {
      lines.push(
        `----------------------------------------`,
        `🎯 <b>KHUYẾN NGHỊ VÀO LỆNH & QUẢN TRỊ RỦI RO:</b>`,
        `• <b>Mục tiêu Chốt lời 1 (TP1 +3%):</b> <code>$${payload.suggestedTp1.toFixed(4)}</code>`,
        payload.suggestedTp2 ? `• <b>Mục tiêu Chốt lời 2 (TP2 +6%):</b> <code>$${payload.suggestedTp2.toFixed(4)}</code>` : '',
        `• <b>Mức Cắt lỗ (SL -1.5%):</b> <code>$${payload.suggestedSl.toFixed(4)}</code>`,
      );
    }

    if (payload.reasonText) {
      lines.push(
        `----------------------------------------`,
        `💡 <b>Chi tiết lý do:</b> <i>${payload.reasonText}</i>`,
      );
    }

    lines.push(
      `----------------------------------------`,
      `⏰ <i>Thời gian: ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</i>`,
      `🔗 <a href="${binanceUrl}">Giao dịch ngay trên Binance Futures</a>`,
    );

    return this.sendMessage(lines.filter(Boolean).join('\n'));
  }
}

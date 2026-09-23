import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface TieredAlertPayload {
  symbol: string;
  patternType: 'TICH_LUY' | 'CHAN_SONG' | 'HET_NGON_STAGNANT' | 'HET_NGON_SELL_OUT';
  qualityTier?: 'CUC_KI_NGON' | 'NGON';
  
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
  forecastScore: number;         // Điểm tin cậy

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

  async sendTieredAlert(payload: TieredAlertPayload): Promise<boolean> {
    const isCucKiNgon = payload.qualityTier === 'CUC_KI_NGON';
    const isTichLuy = payload.patternType === 'TICH_LUY';
    const isHetNgon = payload.patternType === 'HET_NGON_STAGNANT' || payload.patternType === 'HET_NGON_SELL_OUT';

    let header = '';
    let analysisNote = '';

    if (payload.patternType === 'HET_NGON_STAGNANT') {
      header = '🔴 🛑 <b>[THÔNG BÁO: HẾT NGON - GIÁ ĐI NGANG NÉN ĐỨNG YÊN]</b>';
      analysisNote = '🚨 <i>Phân tích: Lực Mua dừng lại sau 10-15 phút, coin nén đi ngang không bùng nổ $\\rightarrow$ HỦY THEO DÕI, KHÔNG VÀO NỮA!</i>';
    } else if (payload.patternType === 'HET_NGON_SELL_OUT') {
      header = '💰 🔴 <b>[THÔNG BÁO: HẾT NGON - CÁ MẠP BÁN XẢ / CHỐT LỜI LẬP TỨC]</b>';
      analysisNote = '🚨 <i>Phân tích: Lực Bán Taker xả tháo mạnh hoặc giá rút chân khỏi đỉnh $\\rightarrow$ CHỐT LỜI NGAY HOẶC HỦY THEO DÕI, KHÔNG VÀO NỮA!</i>';
    } else if (isTichLuy) {
      if (isCucKiNgon) {
        header = '💎 🔥 🟢 <b>[CỰC KÌ NGON: TÍCH LŨY CÁ MẠP DỒN TIỀN MUA (WIN RATE >= 90%)]</b>';
        analysisNote = '💡 <i>Phân tích: Giá đi ngang nén chặt dưới đáy nhưng Cá mập dồn dòng tiền Mua Taker khổng lồ $\\rightarrow$ Chuẩn bị bùng nổ chân sóng!</i>';
      } else {
        header = '💎 ⚡ 🟢 <b>[TÍN HIỆU NGON: TÍCH LŨY GOM HÀNG CHUẨN ĐÁY]</b>';
        analysisNote = '💡 <i>Phân tích: Lực Mua gom âm thầm áp đảo phe bán tại vùng hỗ trợ $\\rightarrow$ Vị thế gom hàng an toàn!</i>';
      }
    } else {
      if (isCucKiNgon) {
        header = '🚀 🔥 🟢 <b>[CỰC KÌ NGON: BẮT ĐẦU CHÂN SÓNG TĂNG (WIN RATE >= 90%)]</b>';
        analysisNote = '💡 <i>Phân tích: Cây nến bứt phá nổ Volume khổng lồ ngay từ nền phẳng $\\rightarrow$ Ăn trọn sóng tăng cực mạnh!</i>';
      } else {
        header = '🚀 ⚡ 🟢 <b>[TÍN HIỆU NGON: BẮT ĐẦU CHÂN SÓNG TĂNG]</b>';
        analysisNote = '💡 <i>Phân tích: Dòng tiền Mua vừa bơm vào kích hoạt đà tăng $\\rightarrow$ Entry chuẩn ngay đầu chân sóng!</i>';
      }
    }

    const binanceUrl = `https://www.binance.com/en/futures/${payload.symbol}`;

    const lines: string[] = [
      header,
      `<b>Mã Coin:</b> <code>${payload.symbol}</code>`,
      !isHetNgon ? `🎯 <b>ĐIỂM ĐÁNH GIÁ CHUẨN:</b> <b>${payload.forecastScore}/100</b> (${isCucKiNgon ? 'Kèo VIP Cực Khủng' : 'Kèo Chuẩn'})` : '',
      analysisNote,
      `----------------------------------------`,
      `📊 <b>TRẠNG THÁI DÒNG TIỀN (1 PHÚT):</b>`,
      `• <b>Dòng Tiền Ròng (Net Flow):</b> <code>${payload.netCashflow >= 0 ? '+' : ''}${Math.round(payload.netCashflow).toLocaleString()} USDT</code>`,
      `• <b>Lực Mua Chủ Động (Taker Buy):</b> <code>${payload.takerBuyPct.toFixed(1)}%</code> (${Math.round(payload.takerBuyVol).toLocaleString()} USDT)`,
      `• <b>Lực Bán Chủ Động (Taker Sell):</b> <code>${(100 - payload.takerBuyPct).toFixed(1)}%</code> (${Math.round(payload.takerSellVol).toLocaleString()} USDT)`,
      `• <b>Tổng Volume 1m:</b> <code>${Math.round(payload.volume1m).toLocaleString()} USDT</code> (Đột biến <b>${payload.volumeMultiplier.toFixed(1)}x</b>)`,
      `----------------------------------------`,
      `📈 <b>GIÁ VÀ BIẾN ĐỘNG:</b>`,
      `• <b>Giá Hiện Tại:</b> <code>$${payload.currentPrice}</code> (Mở: <code>$${payload.openPrice}</code> | Cao nhất: <code>$${payload.highPrice}</code>)`,
      payload.change1hPct !== undefined ? `• <b>Xu hướng 1 giờ:</b> <code>${payload.change1hPct >= 0 ? '+' : ''}${payload.change1hPct.toFixed(2)}%</code>` : '',
    ];

    if (!isHetNgon && payload.suggestedTp1 && payload.suggestedSl) {
      lines.push(
        `----------------------------------------`,
        `🎯 <b>GỢI Ý QUẢN TRỊ LỆNH:</b>`,
        `• <b>Chốt lời TP1 (+3%):</b> <code>$${payload.suggestedTp1.toFixed(4)}</code>`,
        payload.suggestedTp2 ? `• <b>Chốt lời TP2 (+6%):</b> <code>$${payload.suggestedTp2.toFixed(4)}</code>` : '',
        `• <b>Cắt lỗ SL (-1.5%):</b> <code>$${payload.suggestedSl.toFixed(4)}</code>`,
      );
    }

    if (isHetNgon && payload.reasonText) {
      lines.push(
        `----------------------------------------`,
        `💡 <b>Lý do hủy tín hiệu:</b> <i>${payload.reasonText}</i>`,
        `👉 <b>HÀNH ĐỘNG:</b> Chốt lời ngay nếu đã có lời, hoặc bỏ qua coin này không vào lệnh nữa!`,
      );
    }

    lines.push(
      `----------------------------------------`,
      `⏰ <i>${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</i>`,
      `🔗 <a href="${binanceUrl}">Xem Ngay Trên Binance Futures</a>`,
    );

    return this.sendMessage(lines.filter(Boolean).join('\n'));
  }
}

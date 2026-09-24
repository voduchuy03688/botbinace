import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface KlineData {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
  takerBuyBaseVolume: number;
  takerBuyQuoteVolume: number;
}

export interface Ticker24hData {
  symbol: string;
  lastPrice: number;
  highPrice: number;
  lowPrice: number;
  priceChangePercent: number;
  quoteVolume: number;
  bottomRangePct: number; // ((lastPrice - lowPrice) / (highPrice - lowPrice)) * 100
}

@Injectable()
export class BinanceService {
  private readonly logger = new Logger(BinanceService.name);
  private readonly fapiBase = 'https://fapi.binance.com';

  private readonly httpHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'application/json',
  };

  // Lọc các coin Futures có thanh khoản 24h >= 3,000,000 USDT (loại bỏ coin rác kém thanh khoản, tránh bẫy giật ảo)
  private readonly MIN_VOLUME_24H_USDT = 3_000_000;

  private ticker24hMap: Map<string, Ticker24hData> = new Map();

  async refreshTickers24h(): Promise<Map<string, Ticker24hData>> {
    try {
      const url = `${this.fapiBase}/fapi/v1/ticker/24hr`;
      const res = await axios.get(url, { headers: this.httpHeaders, timeout: 8000 });
      const rawList = res.data || [];

      this.ticker24hMap.clear();

      for (const item of rawList) {
        if (!item.symbol || !item.symbol.endsWith('USDT')) continue;

        const quoteVol = parseFloat(item.quoteVolume || '0');
        if (quoteVol < this.MIN_VOLUME_24H_USDT) continue;

        const lastPrice = parseFloat(item.lastPrice || '0');
        const highPrice = parseFloat(item.highPrice || '0');
        const lowPrice = parseFloat(item.lowPrice || '0');
        const priceChangePercent = parseFloat(item.priceChangePercent || '0');

        if (lastPrice <= 0 || highPrice <= 0 || lowPrice <= 0) continue;

        const range = highPrice - lowPrice;
        const bottomRangePct = range > 0 ? Math.max(0, Math.min(100, ((lastPrice - lowPrice) / range) * 100)) : 50;

        this.ticker24hMap.set(item.symbol, {
          symbol: item.symbol,
          lastPrice,
          highPrice,
          lowPrice,
          priceChangePercent,
          quoteVolume: quoteVol,
          bottomRangePct,
        });
      }

      this.logger.log(
        `Cap nhat 24h Ticker: ${this.ticker24hMap.size} coin Futures thanh khoan >= ${this.MIN_VOLUME_24H_USDT.toLocaleString()} USDT`,
      );
      return this.ticker24hMap;
    } catch (err: any) {
      this.logger.error(`Loi khi cap nhat 24h Ticker: ${err.message}`);
      return this.ticker24hMap;
    }
  }

  getTicker24h(symbol: string): Ticker24hData | undefined {
    return this.ticker24hMap.get(symbol);
  }

  getAllTickers24h(): Ticker24hData[] {
    return Array.from(this.ticker24hMap.values());
  }

  // Lọc nhanh các token đang nằm trong VÙNG ĐÁY TÍCH LŨY (Bottom Zone)
  getBottomZoneCandidates(
    maxBottomPct = 38,
    max24hChange = 5.0,
    min24hChange = -18.0,
  ): Ticker24hData[] {
    return Array.from(this.ticker24hMap.values()).filter((t) => {
      return (
        t.bottomRangePct <= maxBottomPct &&
        t.priceChangePercent <= max24hChange &&
        t.priceChangePercent >= min24hChange
      );
    });
  }

  // Lọc nhanh các token đang nằm trong VÙNG ĐỈNH PHÂN PHỐI (Top/Resistance Zone - Chuẩn bị chân sóng giảm)
  getTopZoneCandidates(
    minBottomPct = 58,
    min24hChange = -3.0,
    max24hChange = 25.0,
  ): Ticker24hData[] {
    return Array.from(this.ticker24hMap.values()).filter((t) => {
      return (
        t.bottomRangePct >= minBottomPct &&
        t.priceChangePercent >= min24hChange &&
        t.priceChangePercent <= max24hChange
      );
    });
  }

  async getActiveSymbolsByVolume(): Promise<string[]> {
    if (this.ticker24hMap.size === 0) {
      await this.refreshTickers24h();
    }
    return Array.from(this.ticker24hMap.keys());
  }

  async getUsdtFuturesSymbols(): Promise<string[]> {
    try {
      const url = `${this.fapiBase}/fapi/v1/exchangeInfo`;
      const res = await axios.get(url, { headers: this.httpHeaders, timeout: 8000 });
      const symbols: string[] = [];

      for (const s of res.data.symbols || []) {
        if (s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.contractType === 'PERPETUAL') {
          symbols.push(s.symbol);
        }
      }

      this.logger.log(`Found ${symbols.length} active USDT perpetual futures symbols on Binance`);
      return symbols;
    } catch (err: any) {
      this.logger.error(`Error fetching exchange info: ${err.message}`);
      return [];
    }
  }

  async getKlines(symbol: string, interval = '1m', limit = 60): Promise<KlineData[]> {
    try {
      const url = `${this.fapiBase}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const res = await axios.get(url, { headers: this.httpHeaders, timeout: 5000 });

      return res.data.map((k: any[]) => ({
        openTime: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: Number(k[6]),
        quoteVolume: parseFloat(k[7]),
        trades: Number(k[8]),
        takerBuyBaseVolume: parseFloat(k[9]),
        takerBuyQuoteVolume: parseFloat(k[10]),
      }));
    } catch {
      return [];
    }
  }
}


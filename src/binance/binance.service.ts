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

@Injectable()
export class BinanceService {
  private readonly logger = new Logger(BinanceService.name);
  private readonly fapiBase = 'https://fapi.binance.com';

  private readonly httpHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'application/json',
  };

  // MIN_VOLUME_24H: Chi lay cac coin co klgd Futures 24h >= 1,000,000 USDT
  private readonly MIN_VOLUME_24H_USDT = 1_000_000;

  async getActiveSymbolsByVolume(): Promise<string[]> {
    try {
      const url = `${this.fapiBase}/fapi/v1/ticker/24hr`;
      const res = await axios.get(url, { headers: this.httpHeaders, timeout: 8000 });
      const symbols = (res.data || [])
        .filter((s: any) =>
          s.symbol.endsWith('USDT') &&
          parseFloat(s.quoteVolume) >= this.MIN_VOLUME_24H_USDT,
        )
        .map((s: any) => s.symbol);

      this.logger.log(
        `Loc duoc ${symbols.length} coin Futures co KLGD 24h >= ${this.MIN_VOLUME_24H_USDT.toLocaleString()} USDT (1 request duy nhat)`,
      );
      return symbols;
    } catch (err: any) {
      this.logger.error(`Loi khi lay ticker 24h: ${err.message}`);
      return [];
    }
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
    } catch (err: any) {
      return [];
    }
  }
}

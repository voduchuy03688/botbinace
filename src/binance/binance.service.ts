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

export interface TickerVelocityData {
  symbol: string;
  velocityPct: number; // % biến động giá trong 5 giây gần nhất
  volInflow: number;   // Dòng tiền USDT bơm vào trong 5 giây gần nhất
  timestamp: number;
}

export interface CashflowReportItem {
  symbol: string;
  netInflowUsdt: number;
  volumeUsdt: number;
  priceChangePct: number;
  takerBuyPct: number;
  currentPrice: number;
}

export interface BtcCashflowSummary {
  symbol: string;
  currentPrice: number;
  timeframeHours?: number;
  priceChangePct: number;
  priceChangePctTf?: number;
  priceChangePct1h?: number;
  priceChangePct24h: number;
  netInflowUsdt: number;
  netInflowTf?: number;
  netInflow1h?: number;
  volumeUsdt: number;
  volumeTf?: number;
  volume1h?: number;
  takerBuyPct: number;
  takerBuyPctTf?: number;
  takerBuyPct1h?: number;
  netInflow24h: number;
  volume24h: number;
  takerBuyPct24h: number;
}

export interface VolumeSpikeItem {
  symbol: string;
  currentPrice: number;
  spikeRatio: number;      // Tỷ lệ tăng đột biến (ví dụ x5.2 lần)
  currentVol: number;      // Khối lượng USDT chu kỳ hiện tại
  prevAvgVol: number;      // Khối lượng trung bình USDT các chu kỳ trước đó
  takerBuyPct: number;     // % Khối lượng mua chủ động
  netInflowUsdt: number;   // Dòng tiền ròng USDT (Mua - Bán)
  priceChangePct: number;  // % Biến động giá
  accumulationPattern?: string; // Dấu hiệu gom: Gom âm thầm / Quét đáy rút chân / Bứt phá nền
  prevDaysConsolidated?: number; // Số ngày thanh khoản thấp trước đó
}

export interface CashflowReportData {
  timeframeHours: number;
  topLimit: number;
  btc: BtcCashflowSummary | null;
  suddenSpikes: VolumeSpikeItem[];
  inflow: CashflowReportItem[];
  outflow: CashflowReportItem[];
  sudden1hSpikes?: VolumeSpikeItem[];
  sudden1dSpikes?: VolumeSpikeItem[];
  strongDailyBuys?: Array<{ symbol: string; takerBuyUsdt: number; priceChangePct: number; takerBuyPct: number }>;
}

// Danh sách token vốn hóa lớn, vừa, chứng khoán và stablecoin cần loại trừ
// CHỈ GIỮ LẠI: Bitcoin (BTCUSDT) và toàn bộ các coin rác (shitcoins), vốn hóa nhỏ (low-cap), meme coin
export const EXCLUDED_MAJOR_MID_CAPS = new Set([
  // Vốn hóa lớn (Major Caps)
  'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT',
  'DOGEUSDT', 'DOTUSDT', 'LINKUSDT', 'NEARUSDT', 'SUIUSDT', 'TONUSDT',
  'TRXUSDT', 'LTCUSDT', 'BCHUSDT', 'POLUSDT', 'MATICUSDT',
  // Vốn hóa vừa (Mid Caps)
  'APTUSDT', 'ARBUSDT', 'OPUSDT', 'ATOMUSDT', 'ETCUSDT', 'FILUSDT',
  'ICPUSDT', 'XLMUSDT', 'HBARUSDT', 'TIAUSDT', 'RENDERUSDT', 'INJUSDT',
  'FETUSDT', 'STXUSDT', 'UNIUSDT', 'AAVEUSDT', 'MKRUSDT', 'CRVUSDT',
  'LDOUSDT', 'ALGOUSDT', 'VETUSDT', 'SANDUSDT', 'MANAUSDT', 'AXSUSDT',
  'THETAUSDT', 'FTMUSDT', 'DYDXUSDT', 'SEIUSDT', 'FLOWUSDT', 'EOSUSDT',
  'KAVAUSDT', 'GALAUSDT', 'QNTUSDT', 'CHZUSDT', 'APEUSDT', 'PYTHUSDT',
  'JUPUSDT', 'STRKUSDT', 'WLDUSDT', 'TAOUSDT', 'PENDLEUSDT', 'OMUSDT',
  'ENAUSDT', 'RUNEUSDT', 'SNXUSDT', 'GRTUSDT', 'DYMUSDT', 'RONINUSDT',
  'EGLDUSDT', 'IMXUSDT', 'ZECUSDT', 'DASHUSDT', 'NEOUSDT', 'IOTAUSDT',
  'XTZUSDT', 'KAIAUSDT', 'CFXUSDT', 'MINAUSDT', 'ENSUSDT', 'ORDIUSDT',
  // Cổ phiếu & ETF phái sinh (Equities / Stocks / ETFs)
  'TSLAUSDT', 'INTCUSDT', 'HOODUSDT', 'MSTRUSDT', 'AMZNUSDT', 'COINUSDT',
  'PLTRUSDT', 'METAUSDT', 'NVDAUSDT', 'GOOGLUSDT', 'QQQUSDT', 'SPYUSDT',
  'AAPLUSDT', 'MUUSDT', 'MSFTUSDT', 'AVGOUSDT', 'BABAUSDT', 'AMDUSDT',
  'SOXLUSDT', 'ARMUSDT', 'SKHYNIXUSDT',
  // Stablecoins & Chỉ số tổng hợp
  'USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'EURUSDT', 'BTCDOMUSDT', 'DEFIUSDT',
  'FOOTBALLUSDT',
]);

// Danh sách các cặp không phải crypto phái sinh thông thường (Stablecoin, Chỉ số, Cổ phiếu)
export const EXCLUDED_NON_CRYPTO_SYMBOLS = new Set([
  'BTCUSDT',
  'USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'EURUSDT',
  'BTCDOMUSDT', 'DEFIUSDT', 'FOOTBALLUSDT',
  'TSLAUSDT', 'INTCUSDT', 'HOODUSDT', 'MSTRUSDT', 'AMZNUSDT', 'COINUSDT',
  'PLTRUSDT', 'METAUSDT', 'NVDAUSDT', 'GOOGLUSDT', 'QQQUSDT', 'SPYUSDT',
  'AAPLUSDT', 'MUUSDT', 'MSFTUSDT', 'AVGOUSDT', 'BABAUSDT', 'AMDUSDT',
  'SOXLUSDT', 'ARMUSDT', 'SKHYNIXUSDT', 'SAMSUNGUSDT', 'SKHYUSDT',
]);

@Injectable()
export class BinanceService {
  private readonly logger = new Logger(BinanceService.name);
  private readonly fapiBase = 'https://fapi.binance.com';

  private readonly httpHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'application/json',
  };

  // Giữ lại các cặp Futures có thanh khoản 24h >= 200,000 USDT để không bỏ sót coin vừa thức giấc
  private readonly MIN_VOLUME_24H_USDT = 200_000;

  private ticker24hMap: Map<string, Ticker24hData> = new Map();
  private previousPriceMap: Map<string, { price: number; quoteVol: number; timestamp: number }> = new Map();
  private velocityMap: Map<string, TickerVelocityData> = new Map();

  async refreshTickers24h(): Promise<Map<string, Ticker24hData>> {
    try {
      const url = `${this.fapiBase}/fapi/v1/ticker/24hr`;
      const res = await axios.get(url, { headers: this.httpHeaders, timeout: 8000 });
      const rawList = res.data || [];

      this.ticker24hMap.clear();
      const now = Date.now();

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

        // Tính toán tốc độ biến động giá & dòng tiền tức thì giữa các chu kỳ quét (5 giây)
        const prev = this.previousPriceMap.get(item.symbol);
        if (prev && prev.price > 0) {
          const velocity = ((lastPrice - prev.price) / prev.price) * 100;
          const volInflow = Math.max(0, quoteVol - prev.quoteVol);
          this.velocityMap.set(item.symbol, {
            symbol: item.symbol,
            velocityPct: velocity,
            volInflow,
            timestamp: now,
          });
        }
        this.previousPriceMap.set(item.symbol, { price: lastPrice, quoteVol, timestamp: now });

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

  // Danh sách coin có tốc độ giá tăng vọt & dòng tiền đổ vào tức thì (Realtime 5s Price & Cashflow Velocity)
  getHotVelocitySymbols(minVelocityPct = 0.15, minInflow = 8_000): string[] {
    const hotList: { symbol: string; score: number }[] = [];
    for (const [symbol, data] of this.velocityMap.entries()) {
      if (
        (data.velocityPct >= minVelocityPct || (data.velocityPct >= 0.10 && data.volInflow >= minInflow)) &&
        this.ticker24hMap.has(symbol)
      ) {
        hotList.push({ symbol, score: data.velocityPct * 10 + data.volInflow / 10_000 });
      }
    }
    return hotList.sort((a, b) => b.score - a.score).map((item) => item.symbol);
  }

  getVelocityData(symbol: string): TickerVelocityData | undefined {
    return this.velocityMap.get(symbol);
  }

  // Lấy toàn bộ danh sách coin hợp lệ cho quét sóng tăng (Loại trừ coin sập quá sâu hoặc đã bay quá xa đu đỉnh)
  getEligibleMoversPool(minVol = 3_000_000, min24hChange = -25.0, max24hChange = 65.0): Ticker24hData[] {
    return Array.from(this.ticker24hMap.values()).filter((t) => {
      return (
        t.quoteVolume >= minVol &&
        t.priceChangePercent >= min24hChange &&
        t.priceChangePercent <= max24hChange
      );
    });
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


  // Lấy báo cáo dòng tiền định kỳ theo khung giờ tùy biến (4h, 12h, 24h) và số lượng Top (mặc định Top 20)
  async getCashflowReport(timeframeHours = 4, topLimit = 20): Promise<CashflowReportData> {
    const tf = Math.max(1, timeframeHours);
    // Lấy đủ nến lịch sử từ 4 - 6 ngày trước (tương đương 96 - 144 nến 1H)
    // để tính toán chính xác nền thanh khoản thấp/vừa nhiều ngày trước đó
    const limitKlines = Math.max(120, tf * 4);

    // 1. Phân tích chi tiết Bitcoin (#BTCUSDT) trong khung thời gian tf và 24h
    let btcItem: BtcCashflowSummary | null = null;
    try {
      const btcKlines = await this.getKlines('BTCUSDT', '1h', limitKlines);
      if (btcKlines && btcKlines.length >= tf) {
        const recentBtc = btcKlines.slice(btcKlines.length - tf);
        const last1h = btcKlines[btcKlines.length - 1];

        const volTf = recentBtc.reduce((s, k) => s + k.quoteVolume, 0);
        const buyTf = recentBtc.reduce((s, k) => s + k.takerBuyQuoteVolume, 0);
        const sellTf = Math.max(0, volTf - buyTf);
        const netInflowTf = buyTf - sellTf;
        const takerBuyPctTf = volTf > 0 ? (buyTf / volTf) * 100 : 50;
        const firstTf = recentBtc[0];
        const priceChangePctTf =
          firstTf.open > 0 ? ((last1h.close - firstTf.open) / firstTf.open) * 100 : 0;

        const last24hBtc = btcKlines.slice(Math.max(0, btcKlines.length - 24));
        const vol24h = last24hBtc.reduce((s, k) => s + k.quoteVolume, 0);
        const buy24h = last24hBtc.reduce((s, k) => s + k.takerBuyQuoteVolume, 0);
        const sell24h = Math.max(0, vol24h - buy24h);
        const netInflow24h = buy24h - sell24h;
        const takerBuyPct24h = vol24h > 0 ? (buy24h / vol24h) * 100 : 50;
        const first24h = last24hBtc[0];
        const priceChangePct24h =
          first24h.open > 0 ? ((last1h.close - first24h.open) / first24h.open) * 100 : 0;

        btcItem = {
          symbol: 'BTCUSDT',
          currentPrice: last1h.close,
          timeframeHours: tf,
          priceChangePct: priceChangePctTf,
          priceChangePctTf,
          priceChangePct1h: priceChangePctTf,
          priceChangePct24h,
          netInflowUsdt: netInflowTf,
          netInflowTf,
          netInflow1h: netInflowTf,
          volumeUsdt: volTf,
          volumeTf: volTf,
          volume1h: volTf,
          takerBuyPct: takerBuyPctTf,
          takerBuyPctTf,
          takerBuyPct1h: takerBuyPctTf,
          netInflow24h,
          volume24h: vol24h,
          takerBuyPct24h,
        };
      }
    } catch (err: any) {
      this.logger.error(`Lỗi lấy dữ liệu BTC (${tf}h): ${err.message}`);
    }

    // 2. Lấy danh sách toàn bộ altcoins hợp lệ để quét đột biến thanh khoản & gom hàng
    const candidates = Array.from(this.ticker24hMap.values()).filter((t) => {
      if (!t.symbol || !t.symbol.endsWith('USDT')) return false;
      if (EXCLUDED_NON_CRYPTO_SYMBOLS.has(t.symbol)) return false;
      return t.quoteVolume >= 150_000 && t.quoteVolume <= 600_000_000;
    });

    const suddenSpikes: VolumeSpikeItem[] = [];
    const allTfItems: CashflowReportItem[] = [];

    // Lấy song song theo từng batch 30 coin
    const batchSize = 30;
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (c) => {
          try {
            const klines = await this.getKlines(c.symbol, '1h', limitKlines);
            if (!klines || klines.length < tf + 12) return;

            const recentKlines = klines.slice(klines.length - tf);
            const prevKlines = klines.slice(0, klines.length - tf);
            const prevDays = Number((prevKlines.length / 24).toFixed(1));

            const volTf = recentKlines.reduce((s, k) => s + k.quoteVolume, 0);
            if (volTf < tf * 20_000) return; // Bỏ qua token không có giao dịch đáng kể

            const buyTf = recentKlines.reduce((s, k) => s + k.takerBuyQuoteVolume, 0);
            const sellTf = Math.max(0, volTf - buyTf);
            const netInflowTf = buyTf - sellTf;
            const takerBuyPctTf = volTf > 0 ? (buyTf / volTf) * 100 : 50;

            const firstK = recentKlines[0];
            const lastK = recentKlines[recentKlines.length - 1];
            const priceChangePctTf =
              firstK.open > 0 ? ((lastK.close - firstK.open) / firstK.open) * 100 : 0;

            allTfItems.push({
              symbol: c.symbol,
              netInflowUsdt: netInflowTf,
              volumeUsdt: volTf,
              priceChangePct: priceChangePctTf,
              takerBuyPct: takerBuyPctTf,
              currentPrice: lastK.close,
            });

            // Tính toán Volume cơ sở chu kỳ trước (Baseline) chuẩn hóa theo tf giờ từ nhiều ngày trước
            const avgPrevVolPerHour =
              prevKlines.length > 0
                ? prevKlines.reduce((s, k) => s + k.quoteVolume, 0) / prevKlines.length
                : 0;
            const avgPrevVolTf = avgPrevVolPerHour * tf;
            const spikeRatio = avgPrevVolTf > 0 ? volTf / avgPrevVolTf : 1;

            // ĐIỀU KIỆN NHẬN DIỆN TOKEN CÓ DẤU HIỆU CÁ VOI GOM HÀNG:
            // 1. Trước đó 1-5 ngày thanh khoản nhỏ / vừa (TB mỗi giờ < $1.5M USDT)
            // 2. Chu kỳ hiện tại volume đạt chuẩn (tối thiểu >= tf * $80,000 USDT)
            // 3. Tỷ lệ tăng đột biến volume >= 1.65x so với nền trung bình nhiều ngày trước
            // 4. Có dấu hiệu MUA RÕ RỆT: Taker Buy % >= 52.5% và Net Inflow > 0
            // 5. Giá giữ nền hoặc tăng, không bị xả sập (priceChangePctTf >= -2.5%)
            if (
              avgPrevVolPerHour < 1_500_000 &&
              volTf >= tf * 80_000 &&
              spikeRatio >= 1.65 &&
              takerBuyPctTf >= 52.5 &&
              netInflowTf > 0 &&
              priceChangePctTf >= -2.5
            ) {
              // Phân loại hình thái gom hàng của cá voi:
              let pattern = '🌊 Bơm Gom Mạnh';
              if (spikeRatio >= 1.8 && Math.abs(priceChangePctTf) <= 3.5) {
                pattern = '🤫 Gom Âm Thầm (Nén Chặt)';
              } else if (firstK.open > lastK.close * 0.98 && takerBuyPctTf >= 58 && priceChangePctTf >= -1.0) {
                pattern = '🦅 Quét Đáy Rút Chân';
              } else if (priceChangePctTf > 3.5 && spikeRatio >= 2.0) {
                pattern = '🚀 Bứt Phá Nền Tích Lũy';
              }

              suddenSpikes.push({
                symbol: c.symbol,
                currentPrice: lastK.close,
                spikeRatio,
                currentVol: volTf,
                prevAvgVol: avgPrevVolTf,
                takerBuyPct: takerBuyPctTf,
                netInflowUsdt: netInflowTf,
                priceChangePct: priceChangePctTf,
                accumulationPattern: pattern,
                prevDaysConsolidated: prevDays,
              });
            }
          } catch {
            // Bỏ qua lỗi 1 symbol riêng lẻ
          }
        }),
      );
    }

    // Sắp xếp Đột biến theo tỷ lệ tăng vọt volume cao nhất, lấy đúng topLimit (20)
    suddenSpikes.sort((a, b) => b.spikeRatio - a.spikeRatio);
    const topSpikes = suddenSpikes.slice(0, topLimit);

    // Top Dòng tiền vào (Gom ròng: Net Inflow > 0 và Taker Buy >= 51%), lấy đúng topLimit (20)
    const inflow = [...allTfItems]
      .filter((r) => r.netInflowUsdt > 0 && r.takerBuyPct >= 51)
      .sort((a, b) => b.netInflowUsdt - a.netInflowUsdt)
      .slice(0, topLimit);

    // Top Dòng tiền ra (Xả ròng: Net Inflow < 0 và Taker Buy <= 49%), lấy đúng topLimit (20)
    const outflow = [...allTfItems]
      .filter((r) => r.netInflowUsdt < 0 && r.takerBuyPct <= 49)
      .sort((a, b) => a.netInflowUsdt - b.netInflowUsdt) // Âm nhiều nhất xếp đầu
      .slice(0, topLimit);

    return {
      timeframeHours: tf,
      topLimit,
      btc: btcItem,
      suddenSpikes: topSpikes,
      inflow,
      outflow,
      sudden1hSpikes: tf === 1 ? topSpikes : [],
      sudden1dSpikes: tf >= 24 ? topSpikes : [],
    };
  }
}





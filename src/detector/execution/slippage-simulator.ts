import { NormalizedDepthSnapshot } from '../types/market-event.types.js';

export interface SlippageSimulationResult {
  orderSizeUsdt: number;
  bestAsk: number;
  expectedVwap: number;
  slippagePct: number; // ((vwap - bestAsk) / bestAsk) * 100
  levelsConsumed: number;
  isFilled: boolean;
  executionStatus: 'PASS' | 'HIGH_SLIPPAGE' | 'INSUFFICIENT_DEPTH';
}

export class SlippageSimulator {
  /**
   * Simulates executing a market buy order of orderSizeUsdt against the order book asks.
   */
  simulateMarketBuy(
    depth: NormalizedDepthSnapshot,
    orderSizeUsdt = 10_000,
    maxAllowedSlippagePct = 0.35,
  ): SlippageSimulationResult {
    if (!depth || depth.asks.length === 0) {
      return {
        orderSizeUsdt,
        bestAsk: 0,
        expectedVwap: 0,
        slippagePct: 99.9,
        levelsConsumed: 0,
        isFilled: false,
        executionStatus: 'INSUFFICIENT_DEPTH',
      };
    }

    const bestAsk = depth.asks[0][0];
    let remainingUsdt = orderSizeUsdt;
    let totalBaseFilled = 0;
    let totalUsdtSpent = 0;
    let levelsConsumed = 0;

    for (const [price, qty] of depth.asks) {
      if (remainingUsdt <= 0) break;
      levelsConsumed++;

      const levelUsdt = price * qty;
      if (levelUsdt <= remainingUsdt) {
        totalBaseFilled += qty;
        totalUsdtSpent += levelUsdt;
        remainingUsdt -= levelUsdt;
      } else {
        const partialQty = remainingUsdt / price;
        totalBaseFilled += partialQty;
        totalUsdtSpent += remainingUsdt;
        remainingUsdt = 0;
        break;
      }
    }

    if (remainingUsdt > 0) {
      return {
        orderSizeUsdt,
        bestAsk,
        expectedVwap: bestAsk,
        slippagePct: 99.9,
        levelsConsumed,
        isFilled: false,
        executionStatus: 'INSUFFICIENT_DEPTH',
      };
    }

    const expectedVwap = totalBaseFilled > 0 ? totalUsdtSpent / totalBaseFilled : bestAsk;
    const slippagePct = bestAsk > 0 ? ((expectedVwap - bestAsk) / bestAsk) * 100 : 0;
    const executionStatus =
      slippagePct <= maxAllowedSlippagePct ? 'PASS' : 'HIGH_SLIPPAGE';

    return {
      orderSizeUsdt,
      bestAsk,
      expectedVwap,
      slippagePct,
      levelsConsumed,
      isFilled: true,
      executionStatus,
    };
  }
}

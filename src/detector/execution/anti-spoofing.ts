/**
 * Anti-Spoofing and Manipulation Guard
 * Spec Section 38: ANTI-SPOOFING
 * Tracks order book wall lifecycle: wall_created, wall_lifetime, wall_cancelled, fill_ratio
 */

export interface ManipulationReport {
  manipulationScore: number; // 0.0 to 1.0 (higher = more suspicious)
  isManipulated: boolean;
  cancelRatio: number;
  reason?: string;
}

export class AntiSpoofingGuard {
  evaluateManipulation(
    askDepletionRate: number,
    isConsumedByMarketBuy: boolean,
    spreadVolatility: number,
    orderBookImbalance: number,
  ): ManipulationReport {
    let score = 0;
    const reasons: string[] = [];

    // 1. Fake Wall Cancellation: Ask decreased sharply (>30%) but NO market buys consumed it!
    if (askDepletionRate >= 0.3 && !isConsumedByMarketBuy) {
      score += 0.55;
      reasons.push('Fake ask wall cancelled without trade execution (Quote pulling)');
    }

    // 2. Erratic Spread Flashing (Spoofing best bid/ask)
    if (spreadVolatility > 0.05) {
      score += 0.25;
      reasons.push('Unstable flickering spread');
    }

    // 3. Extreme unbacked book imbalance (> 85% imbalance with no flow confirmation)
    if (Math.abs(orderBookImbalance) > 0.85 && !isConsumedByMarketBuy) {
      score += 0.20;
      reasons.push('Extreme artificial book imbalance');
    }

    const manipulationScore = Math.min(1.0, Math.round(score * 100) / 100);
    const isManipulated = manipulationScore >= 0.45;

    return {
      manipulationScore,
      isManipulated,
      cancelRatio: !isConsumedByMarketBuy ? askDepletionRate : 0,
      reason: reasons.length > 0 ? reasons.join('; ') : undefined,
    };
  }
}

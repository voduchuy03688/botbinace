import {
  DetectorOutput,
  DetectorState,
  ExecutionStatus,
  SignalLevel,
} from '../types/detector-output.types.js';
import { FlowFeatureSnapshot } from '../types/feature.types.js';
import { LiquidityFeatureSnapshot } from '../types/liquidity.types.js';
import { StructureFeatureSnapshot } from '../types/structure.types.js';
import { DerivativesMarketSnapshot } from '../types/derivatives-market.types.js';
import { CusumChangePointDetector } from '../changepoint/cusum-detector.js';
import { SlippageSimulator } from '../execution/slippage-simulator.js';
import { AntiSpoofingGuard } from '../execution/anti-spoofing.js';
import { NormalizedDepthSnapshot } from '../types/market-event.types.js';

export class ScoringEngine {
  private readonly slippageSimulator = new SlippageSimulator();
  private readonly antiSpoofingGuard = new AntiSpoofingGuard();
  private readonly cusumDetectors: Map<string, CusumChangePointDetector> =
    new Map();

  private getOrCreateCusum(symbol: string): CusumChangePointDetector {
    let detector = this.cusumDetectors.get(symbol);
    if (!detector) {
      detector = new CusumChangePointDetector(0.5, 4.5);
      this.cusumDetectors.set(symbol, detector);
    }
    return detector;
  }

  evaluate(
    symbol: string,
    flow: FlowFeatureSnapshot,
    liquidity?: LiquidityFeatureSnapshot | null,
    structure?: StructureFeatureSnapshot | null,
    derivatives?: DerivativesMarketSnapshot | null,
    depthSnapshot?: NormalizedDepthSnapshot | null,
    now = Date.now(),
  ): DetectorOutput {
    // 1. Group Scores
    const flowScore = flow.flowScore; // 0 - 35
    const liquidityScore = liquidity?.liquidityScore ?? 15; // 0 - 30
    const structureScore = structure?.structureScore ?? 10; // 0 - 20
    const derivativeScore = derivatives?.derivativeScore ?? 4; // 0 - 10
    const marketScore = derivatives?.marketScore ?? 3; // 0 - 5

    const totalScore = Math.min(
      100,
      flowScore + liquidityScore + structureScore + derivativeScore + marketScore,
    );

    // 2. Change-Point Detection (CUSUM on volumeZ and cvdZ)
    const cusum = this.getOrCreateCusum(symbol);
    const combinedFlowZ = (flow.volume.volume_Z_60s + flow.cvd.cvd_Z_60s) / 2;
    const changePointScore = cusum.update(combinedFlowZ);

    // 3. Execution Simulation & Anti-Spoofing
    const slippageResult = depthSnapshot
      ? this.slippageSimulator.simulateMarketBuy(depthSnapshot, 10_000, 0.35)
      : { slippagePct: 0.08, executionStatus: 'PASS' as const };

    const manipulationReport = this.antiSpoofingGuard.evaluateManipulation(
      liquidity?.depletion.askDepletionRate ?? 0,
      liquidity?.depletion.isConsumedByMarketBuy ?? true,
      liquidity?.spread.spreadVolatility_30s ?? 0,
      liquidity?.orderBook.overallImbalance_1pct ?? 0,
    );

    // 4. Hard Filter Checks (Spec Section 37 & 55)
    let execution: ExecutionStatus = 'PASS';
    let rejectionReason: string | undefined;

    if (liquidity?.spread.isSpreadExcessive) {
      execution = 'REJECT';
      rejectionReason = `Spread is excessive (${liquidity.spread.currentSpreadPct.toFixed(3)}%)`;
    } else if (slippageResult.executionStatus !== 'PASS') {
      execution = 'REJECT';
      rejectionReason = `Simulated slippage too high (${slippageResult.slippagePct.toFixed(3)}%)`;
    } else if (manipulationReport.isManipulated) {
      execution = 'REJECT';
      rejectionReason = `High manipulation score (${manipulationReport.manipulationScore}): ${manipulationReport.reason}`;
    } else if (derivatives?.btcRegime.isBtcCrashing) {
      execution = 'REJECT';
      rejectionReason = 'BTC is currently in a severe crash regime';
    } else if (structure?.breakout.isChasingExcessivePump) {
      execution = 'REJECT';
      rejectionReason = 'Price has already pumped excessively (>3.0% from base)';
    }

    // 5. State Machine Evaluation (Spec Section 28 & 35)
    let state: DetectorState = 'NORMAL';
    if (
      flowScore >= 16 &&
      liquidityScore >= 12 &&
      structure?.compression.isCompressed
    ) {
      state = 'PRE_PUMP';
    }

    const passesReadyMinimums =
      flowScore >= 22 &&
      liquidityScore >= 18 &&
      structureScore >= 10 &&
      changePointScore >= 0.6 &&
      execution === 'PASS';

    if (passesReadyMinimums) {
      state = 'READY';
    }

    const isMicroTriggerFired =
      structure?.breakout.isMicroBreakout ||
      liquidity?.vacuum.isVacuumPresent ||
      liquidity?.depletion.isAskDepleting;

    if (state === 'READY' && isMicroTriggerFired) {
      state = 'EXPANSION';
    }

    // 6. Signal Level (Spec Section 52)
    let signal: SignalLevel = 'NONE';
    if (totalScore >= 65 && totalScore < 80) {
      signal = 'WATCH';
    } else if (
      totalScore >= 84 &&
      state === 'EXPANSION' &&
      passesReadyMinimums &&
      isMicroTriggerFired &&
      execution === 'PASS'
    ) {
      signal = 'EXECUTE';
    } else if (totalScore >= 80) {
      signal = state === 'READY' || state === 'EXPANSION' ? 'READY' : 'WATCH';
    }

    // 7. Multi-Horizon Probabilities & Expected Return Estimates
    const baseProb = Math.min(0.95, totalScore / 100);
    const probability_1pct_30s = Math.round(baseProb * 100) / 100;
    const probability_2pct_60s = Math.round(baseProb * 0.9 * 100) / 100;
    const expectedMFE = Math.round((totalScore * 0.035) * 100) / 100; // in %
    const expectedMAE = 0.45; // in %
    const leadTimeEstimate = 12.5; // Lead time in seconds before explosion

    return {
      symbol,
      timestamp: now,
      state,
      flowScore,
      liquidityScore,
      structureScore,
      derivativeScore,
      marketScore,
      totalScore,
      changePointScore,
      cvdAcceleration: flow.cvd.cvdAcceleration_15s,
      buyPressure: flow.aggressive.buyPressure['15s'],
      tradeBurst: flow.burst.tradesPerSecond,
      volumeZ: flow.volume.volume_Z_60s,
      askDepletion: liquidity?.depletion.askDepletionRate ?? 0,
      liquidityVacuum: liquidity?.vacuum.vacuumScore ?? 0,
      oiAcceleration: derivatives?.oi.oiAcceleration ?? 0,
      shortLiquidationAcceleration:
        derivatives?.liquidation.shortLiquidationAcceleration ?? 0,
      spread: liquidity?.spread.currentSpreadPct ?? 0.03,
      estimatedSlippage: slippageResult.slippagePct,
      manipulationScore: manipulationReport.manipulationScore,
      probability_1pct_30s,
      probability_2pct_60s,
      expectedMFE,
      expectedMAE,
      leadTimeEstimate,
      execution,
      rejectionReason,
      signal,
    };
  }
}

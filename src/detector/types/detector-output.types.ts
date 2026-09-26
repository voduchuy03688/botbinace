/**
 * Full Detector Output Schema according to Spec Section 50
 */

export type DetectorState = 'NORMAL' | 'PRE_PUMP' | 'READY' | 'EXPANSION';
export type SignalLevel = 'NONE' | 'WATCH' | 'READY' | 'EXECUTE';
export type ExecutionStatus = 'PASS' | 'REJECT';

export interface DetectorOutput {
  symbol: string;
  timestamp: number;
  state: DetectorState;

  // Group Scores
  flowScore: number; // 0 - 35
  liquidityScore: number; // 0 - 30
  structureScore: number; // 0 - 20
  derivativeScore: number; // 0 - 10
  marketScore: number; // 0 - 5
  totalScore: number; // 0 - 100

  // Change-Point Detection (Spec Section 27)
  changePointScore: number; // 0.0 - 1.0

  // Core Flow Metrics
  cvdAcceleration: number;
  buyPressure: number;
  tradeBurst: number;
  volumeZ: number;

  // Liquidity Metrics
  askDepletion: number;
  liquidityVacuum: number;

  // Derivatives & Market
  oiAcceleration: number;
  shortLiquidationAcceleration: number;

  // Safety & Execution
  spread: number;
  estimatedSlippage: number;
  manipulationScore: number;

  // Multi-Horizon Probabilities & Metrics
  probability_1pct_30s: number;
  probability_2pct_60s: number;
  expectedMFE: number;
  expectedMAE: number;
  leadTimeEstimate: number; // seconds

  // Final Action
  execution: ExecutionStatus;
  rejectionReason?: string;
  signal: SignalLevel;
}

# Binance Early Expansion Detector (crypto-spike-bot)

A high-performance real-time microstructure trading detector built for Binance Perpetual Futures. It detects the **exact behavioral transition** where a coin prepares to explode into an expansion wave *before* the large price candle prints.

```text
NORMAL ➔ ACCUMULATION / ABSORPTION ➔ PRE-EXPANSION ➔ READY ➔ MICRO BREAKOUT ➔ EXPANSION
```

---

## 1. Core Architecture

The system operates on live microsecond order-flow streams, multi-window sliding circular buffers, coin-specific rolling Z-scores, statistical change-point detection, independent score groups with strict caps, and simulated order book execution guards.

```mermaid
flowchart TD
    WS["Binance Futures WebSocket\n(aggTrade / depth20@100ms / bookTicker)"] --> STREAM_MGR["BinanceWsManager\n(Multi-stream Multiplexer)"]
    STREAM_MGR --> BUFFER["TimeWindowRingBuffer & OrderBookHistoryBuffer\n(5s, 10s, 15s, 30s, 60s, 3m, 5m, 15m, 1h)"]
    
    BUFFER --> FLOW["FlowEngine (Max 35 pts)\n- CVD Acceleration\n- Aggressive Buy Pressure\n- Trade Frequency Burst\n- Volume Acceleration\n- P95/P99 Whale Trades"]
    BUFFER --> LIQUIDITY["LiquidityEngine (Max 30 pts)\n- Ask Depletion (Market Buy vs Cancel)\n- Liquidity Vacuum\n- Bid Replenishment & Absorption\n- 6 Depth Bands (0.05% - 2%)\n- Spread Stability"]
    BUFFER --> STRUCTURE["StructureEngine (Max 20 pts)\n- Volatility Compression\n- Resistance Distance\n- Micro Breakout\n- Anti-Chasing Guard (>3% pump)"]
    BUFFER --> DERIVATIVES["DerivativesMarketEngine (Max 15 pts)\n- BTC Crash Filter\n- Relative Strength (Token - BTC)\n- OI & Short Liquidation"]

    FLOW & LIQUIDITY & STRUCTURE & DERIVATIVES --> BASELINE["DynamicBaselineEngine\n(Rolling Mean, Std, MAD, Robust Z-scores)"]
    BASELINE --> CPD["CusumChangePointDetector\n(Cumulative Sum Score 0.0 - 1.0)"]
    
    CPD --> SCORING["ScoringEngine\n(TOTAL_SCORE 0 - 100)"]
    SCORING --> GUARD["Execution Guard & Anti-Spoofing\n- Simulated $10k Market Buy Slippage\n- Wall Pull / Cancel Ratio Check"]
    
    GUARD --> STATE["State Machine & Trigger\n- NORMAL\n- PRE_PUMP (Score 65-79)\n- READY (Score 80-88, Group Minima Passed)\n- EXPANSION ➔ SIGNAL = EXECUTE (Score >= 84 + Micro Breakout)"]
    
    STATE --> BACKTEST["MetricsEvaluator\n(MFE, MAE, Lead Time in seconds, Multi-horizon targets)"]
```

---

## 2. Independent Group Scores & Group Caps

Correlated features are grouped together and capped to prevent multiple correlated indicators from over-inflating confidence.

| Group | Max Score | Components & Weights |
| :--- | :---: | :--- |
| **FLOW** | **35** | Aggressive Buy Accel (25%), CVD Accel (25%), Trade Burst (15%), Volume Accel (15%), Large Aggressive Buys (20%) |
| **LIQUIDITY** | **30** | Ask Depletion (30%), Liquidity Vacuum (25%), Bid Replenishment (20%), Book Imbalance (15%), Spread Stability (10%) |
| **STRUCTURE** | **20** | Volatility Compression (25%), Resistance Distance (20%), Price Accel (20%), Micro Breakout (20%), Multi-TF Alignment (15%) |
| **DERIVATIVES** | **10** | OI Accel (35%), Short Liquidation (30%), OI/Price Relationship (25%), Funding Context (10%) |
| **MARKET** | **5** | BTC Regime (Bullish/Neutral vs Crash, 50%), Relative Strength (50%) |
| **TOTAL** | **100** | Strict minimum per-group threshold required for READY/EXECUTE |

---

## 3. Core Behavioral Safeguards

1. **Ask Depletion vs Quote Pulling (Spoofing)**:
   - Ask depletion is only credited if backed by aggressive market buy trade volume eating the orders. If ask depth drops without trade execution, it is flagged as quote pulling (manipulation score penalization).
2. **Anti-Chasing Guard**:
   - If price has already pumped `> 3.0%` from base or `returns_5m >= 3%`, the entry is severely penalized to eliminate chasing the top of candles.
3. **Simulated Slippage Execution Filter**:
   - Simulates a market buy of $10,000 against actual order book asks. If slippage exceeds 0.35%, the signal is rejected.
4. **BTC Crash Regime Filter**:
   - If BTC 5m return `< -1.8%` or 1m return `< -0.9%`, all altcoin long signals are immediately rejected.

---

## 4. Signal Output Schema (Spec Section 50)

```json
{
  "symbol": "BTCUSDT",
  "state": "EXPANSION",
  "flowScore": 32,
  "liquidityScore": 26,
  "structureScore": 18,
  "derivativeScore": 8,
  "marketScore": 4,
  "totalScore": 88,
  "changePointScore": 0.85,
  "cvdAcceleration": 500.0,
  "buyPressure": 0.82,
  "tradeBurst": 15.0,
  "volumeZ": 4.2,
  "askDepletion": 0.70,
  "liquidityVacuum": 0.80,
  "oiAcceleration": 1.2,
  "shortLiquidationAcceleration": 2.1,
  "spread": 0.02,
  "estimatedSlippage": 0.05,
  "manipulationScore": 0.05,
  "probability_1pct_30s": 0.88,
  "probability_2pct_60s": 0.79,
  "expectedMFE": 3.08,
  "expectedMAE": 0.45,
  "leadTimeEstimate": 12.5,
  "execution": "PASS",
  "signal": "EXECUTE"
}
```

---

## 5. Development & Testing

```bash
# Install dependencies
npm install

# Run unit & integration tests
npm test

# Run build
npm run build

# Run linter
npm run lint

# Start server
npm run start:dev
```

import { Module } from '@nestjs/common';
import { BinanceWsManager } from './websocket/binance-ws-manager.js';
import { DynamicBaselineEngine } from './baseline/dynamic-baseline.js';
import { FlowEngine } from './features/flow-engine.js';
import { LiquidityEngine } from './features/liquidity-engine.js';
import { StructureEngine } from './features/structure-engine.js';
import { DerivativesMarketEngine } from './features/derivatives-market-engine.js';
import { ScoringEngine } from './scoring/scoring-engine.js';
import { DetectorService } from './detector.service.js';
import { BinanceService } from '../binance/binance.service.js';
import { TelegramService } from '../telegram/telegram.service.js';

@Module({
  providers: [
    BinanceWsManager,
    DynamicBaselineEngine,
    FlowEngine,
    LiquidityEngine,
    StructureEngine,
    DerivativesMarketEngine,
    ScoringEngine,
    BinanceService,
    TelegramService,
    DetectorService,
  ],
  exports: [
    DetectorService,
    BinanceWsManager,
    DynamicBaselineEngine,
    FlowEngine,
    LiquidityEngine,
    StructureEngine,
    DerivativesMarketEngine,
    ScoringEngine,
  ],
})
export class DetectorModule {}

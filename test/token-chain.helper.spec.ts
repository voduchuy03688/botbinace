import { describe, it, expect } from 'vitest';
import {
  getTokenChain,
  getChainBadge,
  isPriceUnderHalfDollar,
  isTargetChain,
  isEligibleTokenForAlert,
  MAX_ALLOWED_PRICE,
} from '../src/binance/token-chain.helper.js';

describe('TokenChainHelper', () => {
  describe('Price Filter (< 0.50$)', () => {
    it('should correctly accept prices strictly below 0.50$', () => {
      expect(isPriceUnderHalfDollar(0.00001)).toBe(true);
      expect(isPriceUnderHalfDollar(0.05)).toBe(true);
      expect(isPriceUnderHalfDollar(0.125)).toBe(true);
      expect(isPriceUnderHalfDollar(0.4999)).toBe(true);
    });

    it('should reject prices >= 0.50$ or invalid prices', () => {
      expect(isPriceUnderHalfDollar(0.50)).toBe(false);
      expect(isPriceUnderHalfDollar(0.5001)).toBe(false);
      expect(isPriceUnderHalfDollar(1.0)).toBe(false);
      expect(isPriceUnderHalfDollar(10.5)).toBe(false);
      expect(isPriceUnderHalfDollar(65000)).toBe(false);
      expect(isPriceUnderHalfDollar(0)).toBe(false);
      expect(isPriceUnderHalfDollar(-1)).toBe(false);
    });
  });

  describe('Chain Classification (ETH, BSC, SOL)', () => {
    it('should correctly classify Solana tokens', () => {
      expect(getTokenChain('POPCATUSDT')).toBe('SOL');
      expect(getTokenChain('WIFUSDT')).toBe('SOL');
      expect(getTokenChain('1000BONKUSDT')).toBe('SOL');
      expect(getTokenChain('MEWUSDT')).toBe('SOL');
      expect(getTokenChain('BOMEUSDT')).toBe('SOL');
      expect(getTokenChain('PNUTUSDT')).toBe('SOL');
      expect(getTokenChain('GOATUSDT')).toBe('SOL');
      expect(getTokenChain('ACTUSDT')).toBe('SOL');
      expect(getChainBadge('POPCATUSDT')).toBe('[SOL 🟣]');
      expect(isTargetChain('WIFUSDT')).toBe(true);
    });

    it('should correctly classify Ethereum ecosystem / ERC20 tokens', () => {
      expect(getTokenChain('1000PEPEUSDT')).toBe('ETH');
      expect(getTokenChain('1000SHIBUSDT')).toBe('ETH');
      expect(getTokenChain('NEIROUSDT')).toBe('ETH');
      expect(getTokenChain('TURBOUSDT')).toBe('ETH');
      expect(getTokenChain('MEMEUSDT')).toBe('ETH');
      expect(getTokenChain('BLURUSDT')).toBe('ETH');
      expect(getTokenChain('LDOUSDT')).toBe('ETH');
      expect(getTokenChain('ARBUSDT')).toBe('ETH');
      expect(getTokenChain('OPUSDT')).toBe('ETH');
      expect(getChainBadge('1000PEPEUSDT')).toBe('[ETH 🔷]');
      expect(isTargetChain('1000PEPEUSDT')).toBe(true);
    });

    it('should correctly classify BNB Chain (BSC) tokens', () => {
      expect(getTokenChain('1000FLOKIUSDT')).toBe('BSC');
      expect(getTokenChain('1MBABYDOGEUSDT')).toBe('BSC');
      expect(getTokenChain('1000CHEEMSUSDT')).toBe('BSC');
      expect(getTokenChain('THEUSDT')).toBe('BSC');
      expect(getTokenChain('BAKEUSDT')).toBe('BSC');
      expect(getTokenChain('CAKEUSDT')).toBe('BSC');
      expect(getTokenChain('C98USDT')).toBe('BSC');
      expect(getChainBadge('1000FLOKIUSDT')).toBe('[BSC 🟡]');
      expect(isTargetChain('1000FLOKIUSDT')).toBe(true);
    });

    it('should exclude tokens from other chains or non-target symbols', () => {
      expect(getTokenChain('BTCUSDT')).toBe(null);
      expect(getTokenChain('ADAUSDT')).toBe(null);
      expect(getTokenChain('XRPUSDT')).toBe(null);
      expect(getTokenChain('DOTUSDT')).toBe(null);
      expect(getTokenChain('TRXUSDT')).toBe(null);
      expect(getTokenChain('SUNUSDT')).toBe(null);
      expect(getTokenChain('SUIUSDT')).toBe(null);
      expect(getTokenChain('NEARUSDT')).toBe(null);
      expect(getTokenChain('USDCUSDT')).toBe(null);
      expect(isTargetChain('BTCUSDT')).toBe(false);
      expect(isTargetChain('TRXUSDT')).toBe(false);
    });
  });

  describe('isEligibleTokenForAlert', () => {
    it('should only return true if token is on target chain AND price < 0.50$', () => {
      // Valid cases
      expect(isEligibleTokenForAlert('1000BONKUSDT', 0.025)).toBe(true);
      expect(isEligibleTokenForAlert('1000PEPEUSDT', 0.009)).toBe(true);
      expect(isEligibleTokenForAlert('1000FLOKIUSDT', 0.14)).toBe(true);

      // Price >= 0.50$ (Rejected even if on target chain)
      expect(isEligibleTokenForAlert('WIFUSDT', 1.45)).toBe(false);
      expect(isEligibleTokenForAlert('SOLUSDT', 135.0)).toBe(false);
      expect(isEligibleTokenForAlert('JUPUSDT', 0.55)).toBe(false);
      expect(isEligibleTokenForAlert('1000PEPEUSDT', 0.50)).toBe(false);

      // Non-target chain (Rejected even if price < 0.50$)
      expect(isEligibleTokenForAlert('TRXUSDT', 0.15)).toBe(false);
      expect(isEligibleTokenForAlert('ADAUSDT', 0.35)).toBe(false);
      expect(isEligibleTokenForAlert('SUNUSDT', 0.02)).toBe(false);
    });
  });
});

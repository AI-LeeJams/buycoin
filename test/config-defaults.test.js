import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, toBithumbMarket, normalizeSymbol } from "../src/config/defaults.js";

test("defaults use balanced profile with mean reversion live config", () => {
  const config = loadConfig({});

  assert.equal(config.tradingProfile.name, "balanced");
  assert.equal(config.strategy.name, "mean_reversion");
  assert.equal(config.strategy.meanLookback, 20);
  assert.equal(config.strategy.meanEntryBps, 60);
  assert.equal(config.strategy.meanExitBps, 10);
  assert.equal(config.execution.symbol, "BTC_KRW");
  assert.deepEqual(config.execution.symbols, ["BTC_KRW"]);
  assert.equal(config.execution.orderAmountKrw, 12000);
  assert.equal(config.execution.maxSymbolsPerWindow, 1);
  assert.equal(config.execution.maxOrderAttemptsPerWindow, 1);
  assert.equal(config.risk.maxDailyLossKrw, 4000);
  assert.equal(config.risk.maxMtmDailyLossKrw, 4000);
  assert.equal(config.risk.maxHoldingLossPct, 2.8);
  assert.equal(config.risk.trailingArmPct, 1.6);
  assert.equal(config.risk.trailingStopPct, 0.8);
  assert.equal(config.strategySettings.requireOptimizerSource, false);
  assert.equal(config.optimizer.applyOnStart, false);
  assert.equal(config.optimizer.reoptEnabled, false);
  assert.deepEqual(config.optimizer.strategies, ["mean_reversion"]);
  assert.deepEqual(config.optimizer.meanLookbacks, [12, 20, 30, 48]);
});

test("trading profiles change the operating preset", () => {
  const safe = loadConfig({ TRADING_PROFILE: "safe" });
  const aggressive = loadConfig({ TRADING_PROFILE: "aggressive" });

  assert.equal(safe.tradingProfile.name, "safe");
  assert.equal(safe.execution.orderAmountKrw, 10000);
  assert.equal(safe.risk.maxMtmDailyLossKrw, 3000);
  assert.equal(aggressive.tradingProfile.name, "aggressive");
  assert.equal(aggressive.execution.orderAmountKrw, 15000);
  assert.equal(aggressive.risk.maxMtmDailyLossKrw, 5000);
});

test("legacy strategy envs still work for research and tests", () => {
  const config = loadConfig({
    STRATEGY_NAME: "breakout",
    STRATEGY_BREAKOUT_LOOKBACK: "3",
    STRATEGY_BREAKOUT_BUFFER_BPS: "0",
    STRATEGY_BASE_ORDER_AMOUNT_KRW: "5000",
  });

  assert.equal(config.strategy.name, "breakout");
  assert.equal(config.strategy.breakoutLookback, 3);
  assert.equal(config.strategy.breakoutBufferBps, 0);
  assert.equal(config.execution.orderAmountKrw, 5000);
});

test("symbol conversion helpers work", () => {
  assert.equal(normalizeSymbol("usdt-krw"), "USDT_KRW");
  assert.equal(toBithumbMarket("USDT_KRW"), "KRW-USDT");
});

test("market universe include symbols can be explicitly disabled", () => {
  const config = loadConfig({
    MARKET_UNIVERSE_INCLUDE_SYMBOLS: "NONE",
  });

  assert.deepEqual(config.marketUniverse.includeSymbols, []);
});

test("risk max exposure can be set to auto", () => {
  const config = loadConfig({
    RISK_MAX_EXPOSURE_KRW: "AUTO",
  });

  assert.equal(config.risk.maxExposureKrw, null);
});

test("risk max order notional can be set to auto", () => {
  const config = loadConfig({
    RISK_MAX_ORDER_NOTIONAL_KRW: "AUTO",
  });

  assert.equal(config.risk.maxOrderNotionalKrw, null);
});

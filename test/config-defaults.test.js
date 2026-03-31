import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, toBithumbMarket, normalizeSymbol } from "../src/config/defaults.js";

test("defaults include orthodox strategy and overlay settings", () => {
  const config = loadConfig({});
  assert.equal(config.runtime.httpAuditEnabled, false);
  assert.equal(config.runtime.httpAuditFile.endsWith(".trader/http-audit.jsonl"), true);
  assert.equal(config.runtime.httpAuditMaxBytes, 10 * 1024 * 1024);
  assert.equal(config.runtime.retention.keepLatestOnly, true);
  assert.equal(config.runtime.retention.closedOrders, 20);
  assert.equal(config.runtime.retention.orders, 400);
  assert.equal(config.runtime.retention.orderEvents, 1000);
  assert.equal(config.strategy.name, "risk_managed_momentum");
  assert.equal(config.strategy.candleInterval, "15m");
  assert.equal(config.strategy.candleCount, 180);
  assert.equal(config.strategy.momentumLookback, 24);
  assert.equal(config.strategy.volatilityLookback, 72);
  assert.equal(config.strategy.meanLookback, 20);
  assert.equal(config.strategy.meanEntryBps, 60);
  assert.equal(config.strategy.meanExitBps, 10);
  assert.equal(config.strategy.autoSellEnabled, true);
  assert.equal(config.strategy.sellAllOnExit, true);
  assert.equal(config.strategy.sellAllQtyPrecision, 8);
  assert.equal(config.strategy.breakoutLookback, 20);
  assert.equal(config.strategy.baseOrderAmountKrw, 12000);
  assert.equal(config.strategy.cashUsagePct, 0);
  assert.equal(config.overlay.timeoutMs, 500);
  assert.equal(config.overlay.enabled, false);
  assert.equal(config.exchange.publicMaxPerSec, 150);
  assert.equal(config.exchange.privateMaxPerSec, 140);
  assert.equal(config.exchange.wsPublicUrl, "wss://ws-api.bithumb.com/websocket/v1");
  assert.equal(config.exchange.wsPrivateUrl, "wss://ws-api.bithumb.com/websocket/v1/private");
  assert.equal(config.exchange.wsConnectMaxPerSec, 5);
  assert.equal(config.strategySettings.enabled, true);
  assert.equal(config.strategySettings.settingsFile.endsWith(".trader/strategy-settings.json"), true);
  assert.equal(config.strategySettings.requireOptimizerSource, true);
  assert.equal(config.strategySettings.maxAgeSec, 7200);
  assert.equal(config.strategySettings.allowKillSwitchReset, false);
  assert.equal(config.strategySettings.refreshMinSec, 1800);
  assert.equal(config.strategySettings.refreshMaxSec, 3600);
  assert.equal(config.marketUniverse.enabled, true);
  assert.equal(config.marketUniverse.quote, "KRW");
  assert.equal(config.marketUniverse.minAccTradeValue24hKrw, 3_500_000_000);
  assert.equal(config.marketUniverse.minListingAgeDays, 365);
  assert.equal(config.marketUniverse.maxSymbols, 80);
  assert.deepEqual(config.marketUniverse.includeSymbols, []);
  assert.equal(config.marketUniverse.minBaseAssetLength, 2);
  assert.equal(config.marketUniverse.refreshMinSec, 1800);
  assert.equal(config.marketUniverse.refreshMaxSec, 3600);
  assert.equal(config.marketUniverse.snapshotFile.endsWith(".trader/market-universe.json"), true);
  assert.equal(config.execution.enabled, true);
  assert.equal(config.execution.symbol, "BTC_KRW");
  assert.deepEqual(config.execution.symbols, ["BTC_KRW"]);
  assert.equal(config.execution.orderAmountKrw, 12000);
  assert.equal(config.execution.windowSec, 300);
  assert.equal(config.execution.cooldownSec, 30);
  assert.equal(config.execution.maxSymbolsPerWindow, 2);
  assert.equal(config.execution.dryRun, false);
  assert.equal(config.execution.maxWindows, 0);
  assert.equal(config.execution.logOnlyOnActivity, true);
  assert.equal(config.execution.heartbeatWindows, 12);
  assert.equal(config.risk.buyCashBufferBps, 50);
  assert.equal(config.optimizer.enabled, true);
  assert.equal(config.optimizer.applyOnStart, true);
  assert.equal(config.optimizer.reoptEnabled, true);
  assert.equal(config.optimizer.reoptIntervalSec, 3600);
  assert.equal(config.optimizer.applyToStrategySettings, true);
  assert.equal(config.optimizer.maxLiveSymbols, 2);
  assert.equal(config.optimizer.minListingAgeDays, 365);
  assert.equal(config.optimizer.minHistoryCandles, 200);
  assert.equal(config.optimizer.initialCashKrw, 100000);
  assert.equal(config.optimizer.baseOrderAmountKrw, 12000);
  assert.deepEqual(config.optimizer.strategies, ["risk_managed_momentum", "breakout", "mean_reversion"]);
  assert.deepEqual(config.optimizer.breakoutBufferBpsCandidates, [0, 5, 10, 15]);
  assert.deepEqual(config.optimizer.breakoutLookbacks, [10, 20, 30, 55]);
  assert.deepEqual(config.optimizer.meanLookbacks, [12, 20, 30, 48]);
  assert.deepEqual(config.optimizer.meanExitBpsCandidates, [0, 10, 20, 30]);
});

test("symbol conversion helpers work", () => {
  assert.equal(normalizeSymbol("usdt-krw"), "USDT_KRW");
  assert.equal(toBithumbMarket("USDT_KRW"), "KRW-USDT");
});

test("market universe include symbols can be explicitly disabled", () => {
  const config = loadConfig({
    MARKET_UNIVERSE_INCLUDE_SYMBOLS: "NONE",
    OPTIMIZER_MIN_HISTORY_CANDLES: "160",
  });

  assert.deepEqual(config.marketUniverse.includeSymbols, []);
  assert.equal(config.optimizer.minHistoryCandles, 160);
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

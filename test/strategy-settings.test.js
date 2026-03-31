import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/defaults.js";
import { StrategySettingsSource } from "../src/app/strategy-settings.js";

async function makeConfig(extra = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-settings-test-"));
  return loadConfig({
    STRATEGY_SETTINGS_FILE: path.join(baseDir, "strategy-settings.json"),
    STRATEGY_SETTINGS_REQUIRE_OPTIMIZER_SOURCE: "false",
    EXECUTION_SYMBOL: "BTC_KRW",
    EXECUTION_ORDER_AMOUNT_KRW: "20000",
    EXECUTION_WINDOW_SEC: "30",
    EXECUTION_COOLDOWN_SEC: "5",
    ...extra,
  });
}

test("strategy settings source creates template when file is missing", async () => {
  const config = await makeConfig();
  const source = new StrategySettingsSource(config);

  await source.init();
  const raw = await fs.readFile(config.strategySettings.settingsFile, "utf8");
  const parsed = JSON.parse(raw);

  assert.equal(parsed.version, 1);
  assert.equal(parsed.execution.enabled, false);
  assert.equal(parsed.execution.symbol, "BTC_KRW");
  assert.deepEqual(parsed.execution.symbols, ["BTC_KRW"]);
  assert.equal(parsed.execution.orderAmountKrw, 20000);
});

test("strategy settings source reads execution overrides and mean reversion strategy", async () => {
  const config = await makeConfig();
  const source = new StrategySettingsSource(config);
  await source.init();

  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      enabled: true,
      symbol: "usdt-krw",
      symbols: ["usdt-krw", "eth-krw"],
      orderAmountKrw: 10000,
      windowSec: 120,
      cooldownSec: 15,
    },
    strategy: {
      name: "mean_reversion",
      defaultSymbol: "eth-krw",
      candleInterval: "5m",
      candleCount: 180,
      meanLookback: 24,
      meanEntryBps: 90,
      meanExitBps: 20,
      autoSellEnabled: true,
      baseOrderAmountKrw: 7000,
      cashUsagePct: 80,
    },
    controls: {
      killSwitch: true,
    },
  };
  await fs.writeFile(config.strategySettings.settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const result = await source.read();

  assert.equal(result.execution.symbol, "USDT_KRW");
  assert.deepEqual(result.execution.symbols, ["USDT_KRW", "ETH_KRW"]);
  assert.equal(result.execution.orderAmountKrw, 10000);
  assert.equal(result.execution.windowSec, 120);
  assert.equal(result.execution.cooldownSec, 15);
  assert.equal(result.strategy.name, "mean_reversion");
  assert.equal(result.strategy.defaultSymbol, "ETH_KRW");
  assert.equal(result.strategy.candleInterval, "5m");
  assert.equal(result.strategy.meanLookback, 24);
  assert.equal(result.strategy.meanEntryBps, 90);
  assert.equal(result.strategy.meanExitBps, 20);
  assert.equal(result.strategy.cashUsagePct, 80);
  assert.equal(result.controls.killSwitch, true);
});

test("strategy settings source preserves execution order amount when risk max order is auto", async () => {
  const config = await makeConfig({
    RISK_MAX_ORDER_NOTIONAL_KRW: "AUTO",
  });
  const source = new StrategySettingsSource(config);
  await source.init();

  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      enabled: true,
      symbol: "btc-krw",
      symbols: ["btc-krw"],
      orderAmountKrw: 500000,
      windowSec: 120,
      cooldownSec: 15,
    },
  };
  await fs.writeFile(config.strategySettings.settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const result = await source.read();

  assert.equal(result.execution.orderAmountKrw, 500000);
});

test("strategy settings source accepts comma-separated symbols", async () => {
  const config = await makeConfig();
  const source = new StrategySettingsSource(config);
  await source.init();

  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      enabled: true,
      symbol: "btc-krw",
      symbols: "btc-krw,eth-krw,usdt-krw",
      orderAmountKrw: 20000,
      windowSec: 120,
      cooldownSec: 10,
    },
  };
  await fs.writeFile(config.strategySettings.settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const result = await source.read();
  assert.equal(result.execution.symbol, "BTC_KRW");
  assert.deepEqual(result.execution.symbols, ["BTC_KRW", "ETH_KRW", "USDT_KRW"]);
});

test("strategy settings source diversifies optimizer-managed multi-symbol snapshots", async () => {
  const config = await makeConfig();
  const source = new StrategySettingsSource(config);
  await source.init();

  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    meta: {
      source: "optimizer",
    },
    execution: {
      enabled: true,
      symbol: "uos-krw",
      symbols: ["uos-krw", "btr-krw"],
      orderAmountKrw: 20000,
      windowSec: 300,
      cooldownSec: 30,
      maxSymbolsPerWindow: 2,
      maxOrderAttemptsPerWindow: 1,
    },
    strategy: {
      name: "mean_reversion",
      defaultSymbol: "uos-krw",
      cashUsagePct: 100,
    },
  };
  await fs.writeFile(config.strategySettings.settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const result = await source.read();

  assert.deepEqual(result.execution.symbols, ["UOS_KRW", "BTR_KRW"]);
  assert.equal(result.execution.maxOrderAttemptsPerWindow, 2);
  assert.equal(result.strategy.cashUsagePct, 50);
});

test("strategy settings source rejects stale optimizer snapshots by default", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-settings-stale-test-"));
  const config = loadConfig({
    STRATEGY_SETTINGS_FILE: path.join(baseDir, "strategy-settings.json"),
    STRATEGY_SETTINGS_MAX_AGE_SEC: "1",
  });
  const source = new StrategySettingsSource(config);

  const payload = {
    version: 1,
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    meta: {
      source: "optimizer",
    },
  };
  await fs.writeFile(config.strategySettings.settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const result = await source.read();
  assert.equal(result.source, "stale_snapshot_fallback");
  assert.equal(result.execution.enabled, false);
});

test("strategy settings source requires optimizer-generated snapshots by default", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-settings-source-test-"));
  const config = loadConfig({
    STRATEGY_SETTINGS_FILE: path.join(baseDir, "strategy-settings.json"),
  });
  const source = new StrategySettingsSource(config);

  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      symbol: "BTC_KRW",
    },
  };
  await fs.writeFile(config.strategySettings.settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const result = await source.read();
  assert.equal(result.source, "invalid_contract_fallback");
  assert.equal(result.execution.enabled, false);
});

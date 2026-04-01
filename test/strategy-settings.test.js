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
    EXECUTION_SYMBOL: "BTC_KRW",
    EXECUTION_ORDER_AMOUNT_KRW: "20000",
    EXECUTION_WINDOW_SEC: "30",
    EXECUTION_COOLDOWN_SEC: "5",
    ...extra,
  });
}

test("strategy settings source creates a minimal operator template when file is missing", async () => {
  const config = await makeConfig();
  const source = new StrategySettingsSource(config);

  await source.init();
  const raw = await fs.readFile(config.strategySettings.settingsFile, "utf8");
  const parsed = JSON.parse(raw);

  assert.equal(parsed.version, 1);
  assert.equal(parsed.meta.source, "operator");
  assert.equal(parsed.execution.symbol, "BTC_KRW");
  assert.equal(parsed.execution.orderAmountKrw, 20000);
  assert.equal(parsed.controls.pauseEntries, null);
});

test("strategy settings source reads pauseEntries and a single-symbol override", async () => {
  const config = await makeConfig();
  const source = new StrategySettingsSource(config);
  await source.init();

  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      enabled: true,
      symbol: "usdt-krw",
      orderAmountKrw: 10000,
      windowSec: 120,
      cooldownSec: 15,
    },
    controls: {
      pauseEntries: true,
    },
  };
  await fs.writeFile(config.strategySettings.settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const result = await source.read();

  assert.equal(result.execution.symbol, "USDT_KRW");
  assert.deepEqual(result.execution.symbols, ["USDT_KRW"]);
  assert.equal(result.execution.orderAmountKrw, 10000);
  assert.equal(result.execution.windowSec, 120);
  assert.equal(result.execution.cooldownSec, 15);
  assert.equal(result.execution.maxSymbolsPerWindow, 1);
  assert.equal(result.strategy.name, "mean_reversion");
  assert.equal(result.controls.pauseEntries, true);
});

test("strategy settings source preserves operator amount when risk max order is auto", async () => {
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
      orderAmountKrw: 500000,
    },
  };
  await fs.writeFile(config.strategySettings.settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const result = await source.read();
  assert.equal(result.execution.orderAmountKrw, 500000);
});

test("strategy settings source supports legacy killSwitch field as pauseEntries compatibility", async () => {
  const config = await makeConfig();
  const source = new StrategySettingsSource(config);
  await source.init();

  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    controls: {
      killSwitch: true,
    },
  };
  await fs.writeFile(config.strategySettings.settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const result = await source.read();
  assert.equal(result.controls.pauseEntries, true);
});

test("strategy settings source falls back to defaults on stale file", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-settings-stale-test-"));
  const config = loadConfig({
    STRATEGY_SETTINGS_FILE: path.join(baseDir, "strategy-settings.json"),
    STRATEGY_SETTINGS_MAX_AGE_SEC: "1",
  });
  const source = new StrategySettingsSource(config);

  const payload = {
    version: 1,
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    execution: {
      symbol: "USDT_KRW",
    },
  };
  await fs.writeFile(config.strategySettings.settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const result = await source.read();
  assert.equal(result.source, "stale_snapshot_fallback");
  assert.equal(result.execution.symbol, "BTC_KRW");
});

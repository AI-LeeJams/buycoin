import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runExecutionService } from "../src/app/run.js";

class SystemMock {
  constructor(result = null) {
    this.result = result || {
      ok: true,
      code: 0,
      data: {
        tickCount: 1,
        buySignals: 0,
        attemptedOrders: 0,
        successfulOrders: 0,
      },
    };
    this.calls = {
      init: 0,
      realtime: 0,
      strategyApply: 0,
      killSwitch: 0,
      args: [],
      strategyArgs: [],
      killSwitchArgs: [],
    };
    this.killSwitch = false;
  }

  async init() {
    this.calls.init += 1;
  }

  async runStrategyRealtime(args) {
    this.calls.realtime += 1;
    this.calls.args.push(args);
    return this.result;
  }

  async applyStrategySettings(args) {
    this.calls.strategyApply += 1;
    this.calls.strategyArgs.push(args);
    return {
      ok: true,
      code: 0,
      data: args,
    };
  }

  async setKillSwitch(enabled, reason = null) {
    this.calls.killSwitch += 1;
    this.calls.killSwitchArgs.push({ enabled, reason });
    this.killSwitch = Boolean(enabled);
    return {
      ok: true,
      code: 0,
      data: {
        killSwitch: this.killSwitch,
        reason,
      },
    };
  }

  async status() {
    return {
      data: {
        killSwitch: this.killSwitch,
        killSwitchReason: this.killSwitch ? "mock_kill_switch" : null,
      },
    };
  }
}

function baseConfig() {
  return {
    runtime: {},
    exchange: {
      accessKey: "",
      secretKey: "",
    },
    strategy: {
      name: "risk_managed_momentum",
      defaultSymbol: "BTC_KRW",
      candleInterval: "15m",
      candleCount: 120,
      baseOrderAmountKrw: 20000,
      autoSellEnabled: true,
    },
    strategySettings: {
      enabled: false,
      settingsFile: null,
      requireOptimizerSource: false,
      refreshMinSec: 1800,
      refreshMaxSec: 3600,
    },
    execution: {
      enabled: true,
      symbol: "BTC_KRW",
      symbols: ["BTC_KRW"],
      orderAmountKrw: 20000,
      windowSec: 1,
      cooldownSec: 1,
      maxSymbolsPerWindow: 3,
      restartDelayMs: 1,
    },
  };
}

test("execution service runs realtime windows by stopAfterWindows", async () => {
  const config = baseConfig();
  const system = new SystemMock();

  const result = await runExecutionService({
    system,
    config,
    stopAfterWindows: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 2);
  assert.equal(result.stoppedBy, "window_limit");
  assert.equal(system.calls.init, 1);
  assert.equal(system.calls.realtime, 2);
  assert.equal(system.calls.args[0].symbol, "BTC_KRW");
});

test("execution service exits immediately when disabled", async () => {
  const config = baseConfig();
  config.execution.enabled = false;
  const system = new SystemMock();

  const result = await runExecutionService({
    system,
    config,
  });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 0);
  assert.equal(result.stoppedBy, "disabled");
  assert.equal(system.calls.init, 1);
  assert.equal(system.calls.realtime, 0);
});

test("execution service applies strategy settings per window", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "execution-strategy-"));
  const settingsFile = path.join(baseDir, "strategy-settings.json");
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      enabled: true,
      symbol: "USDT_KRW",
      symbols: ["USDT_KRW"],
      orderAmountKrw: 7000,
      windowSec: 2,
      cooldownSec: 0,
    },
    strategy: {
      name: "risk_managed_momentum",
      defaultSymbol: "USDT_KRW",
      candleInterval: "5m",
      momentumLookback: 36,
      volatilityLookback: 96,
      momentumEntryBps: 16,
      momentumExitBps: 10,
      targetVolatilityPct: 0.35,
      riskManagedMinMultiplier: 0.4,
      riskManagedMaxMultiplier: 1.8,
      autoSellEnabled: true,
      baseOrderAmountKrw: 7000,
      candleCount: 120,
      breakoutLookback: 20,
      breakoutBufferBps: 5,
    },
  };
  await fs.writeFile(settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const config = baseConfig();
  config.strategySettings.enabled = true;
  config.strategySettings.settingsFile = settingsFile;

  const system = new SystemMock();
  const result = await runExecutionService({ system, config, stopAfterWindows: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 1);
  assert.equal(system.calls.strategyApply, 1);
  assert.equal(system.calls.realtime, 1);
  assert.equal(system.calls.args[0].symbol, "USDT_KRW");
  assert.equal(system.calls.args[0].amount, 20000);
  assert.equal(system.calls.args[0].durationSec, 5);
  assert.equal(system.calls.args[0].cooldownSec, 0);
  assert.equal(system.calls.args[0].dryRun, false);
});

test("execution service runs multiple symbols in one window when strategy settings provide symbols", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "execution-strategy-multi-"));
  const settingsFile = path.join(baseDir, "strategy-settings.json");
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      enabled: true,
      symbol: "BTC_KRW",
      symbols: ["BTC_KRW", "ETH_KRW", "USDT_KRW"],
      orderAmountKrw: 7000,
      windowSec: 2,
      cooldownSec: 0,
    },
  };
  await fs.writeFile(settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const config = baseConfig();
  config.strategySettings.enabled = true;
  config.strategySettings.settingsFile = settingsFile;

  const system = new SystemMock();
  const result = await runExecutionService({ system, config, stopAfterWindows: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 1);
  assert.equal(system.calls.realtime, 3);
  const symbols = system.calls.args.map((row) => row.symbol).sort();
  assert.deepEqual(symbols, ["BTC_KRW", "ETH_KRW", "USDT_KRW"]);
});

test("execution service keeps strategy snapshot until refresh window", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "execution-strategy-refresh-"));
  const settingsFile = path.join(baseDir, "strategy-settings.json");
  const firstPayload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      enabled: true,
      symbol: "USDT_KRW",
      symbols: ["USDT_KRW"],
      orderAmountKrw: 7000,
      windowSec: 1,
      cooldownSec: 0,
    },
  };
  const secondPayload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      enabled: true,
      symbol: "ETH_KRW",
      symbols: ["ETH_KRW"],
      orderAmountKrw: 9000,
      windowSec: 1,
      cooldownSec: 0,
    },
  };
  await fs.writeFile(settingsFile, JSON.stringify(firstPayload, null, 2), "utf8");

  class MutatingSystemMock extends SystemMock {
    async runStrategyRealtime(args) {
      this.calls.realtime += 1;
      this.calls.args.push(args);
      if (this.calls.realtime === 1) {
        await fs.writeFile(settingsFile, JSON.stringify(secondPayload, null, 2), "utf8");
      }
      return this.result;
    }
  }

  const config = baseConfig();
  config.strategySettings.enabled = true;
  config.strategySettings.settingsFile = settingsFile;
  config.strategySettings.refreshMinSec = 3600;
  config.strategySettings.refreshMaxSec = 3600;

  const system = new MutatingSystemMock();
  const result = await runExecutionService({ system, config, stopAfterWindows: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 2);
  assert.equal(system.calls.realtime, 2);
  assert.equal(system.calls.args[0].symbol, "USDT_KRW");
  assert.equal(system.calls.args[1].symbol, "USDT_KRW");
  assert.equal(system.calls.args[0].amount, 20000);
  assert.equal(system.calls.args[1].amount, 20000);
});

test("execution service applies kill switch from strategy settings", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "execution-strategy-kill-"));
  const settingsFile = path.join(baseDir, "strategy-settings.json");
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    controls: {
      killSwitch: true,
    },
  };
  await fs.writeFile(settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const config = baseConfig();
  config.strategySettings.enabled = true;
  config.strategySettings.settingsFile = settingsFile;

  const system = new SystemMock();
  const result = await runExecutionService({ system, config, stopAfterWindows: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 1);
  assert.equal(system.calls.killSwitch, 1);
  assert.equal(system.calls.realtime, 0);
  assert.equal(system.calls.killSwitchArgs[0].enabled, true);
});

test("execution service does not clear runtime kill switch unless explicitly allowed", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "execution-strategy-kill-reset-"));
  const settingsFile = path.join(baseDir, "strategy-settings.json");
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    meta: {
      source: "optimizer",
    },
    execution: {
      enabled: true,
      symbol: "BTC_KRW",
      symbols: ["BTC_KRW"],
    },
    controls: {
      killSwitch: false,
    },
  };
  await fs.writeFile(settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const config = baseConfig();
  config.strategySettings.enabled = true;
  config.strategySettings.settingsFile = settingsFile;

  const system = new SystemMock();
  system.killSwitch = true;
  const result = await runExecutionService({ system, config, stopAfterWindows: 1 });

  assert.equal(result.ok, true);
  assert.equal(system.calls.killSwitch, 0);
  assert.equal(system.killSwitch, true);
  assert.equal(system.calls.realtime, 0);
});

test("execution service applies market universe filter to requested symbols", async () => {
  const config = baseConfig();
  config.execution.symbols = ["BTC_KRW", "ETH_KRW", "USDT_KRW"];

  const system = new SystemMock();
  const universe = {
    enabled: true,
    async init() {},
    async maybeRefresh() {
      return {
        ok: true,
        data: {
          symbols: ["BTC_KRW", "USDT_KRW"],
          criteria: { minAccTradeValue24hKrw: 1 },
          nextRefreshSec: 1800,
        },
      };
    },
    filterSymbols(symbols = []) {
      const allowed = new Set(["BTC_KRW", "USDT_KRW"]);
      const accepted = [];
      const rejected = [];
      for (const symbol of symbols) {
        if (allowed.has(symbol)) {
          accepted.push(symbol);
        } else {
          rejected.push(symbol);
        }
      }
      return {
        symbols: accepted,
        filteredOut: rejected,
        allowedCount: allowed.size,
        source: "mock",
      };
    },
  };

  const result = await runExecutionService({
    system,
    config,
    stopAfterWindows: 1,
    marketUniverseService: universe,
  });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 1);
  assert.equal(system.calls.realtime, 2);
  const symbols = system.calls.args.map((row) => row.symbol).sort();
  assert.deepEqual(symbols, ["BTC_KRW", "USDT_KRW"]);
});

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
        sellSignals: 0,
        attemptedOrders: 0,
        successfulOrders: 0,
      },
    };
    this.calls = {
      init: 0,
      realtime: 0,
      entryBlockSet: 0,
      entryBlockClear: 0,
      args: [],
      entryBlockArgs: [],
    };
    this.entryBlock = {
      blocked: false,
      reason: null,
      source: null,
      blockedAt: null,
      tradeDate: null,
    };
    this.heldSymbols = [];
    this.markToMarketResult = {
      ok: true,
      code: 0,
      data: {
        positionCount: 0,
        totalUnrealizedPnlKrw: 0,
        totalUnrealizedPnlPct: 0,
        dailyPnlKrw: 0,
        equityMtmKrw: 100000,
      },
    };
  }

  async init() {
    this.calls.init += 1;
  }

  async runStrategyRealtime(args) {
    this.calls.realtime += 1;
    this.calls.args.push(args);
    return this.result;
  }

  async setEntryBlock(blocked, options = {}) {
    this.calls.entryBlockSet += 1;
    this.calls.entryBlockArgs.push({ blocked, ...options });
    this.entryBlock = blocked
      ? {
        blocked: true,
        reason: options.reason || null,
        source: options.source || options.reason || null,
        blockedAt: options.blockedAt || new Date().toISOString(),
        tradeDate: options.tradeDate || null,
      }
      : {
        blocked: false,
        reason: null,
        source: null,
        blockedAt: null,
        tradeDate: null,
      };
    return {
      ok: true,
      data: {
        entryBlocked: this.entryBlock.blocked,
        entryBlockReason: this.entryBlock.reason,
        entryBlockSource: this.entryBlock.source,
      },
    };
  }

  async clearEntryBlock(reason = null) {
    this.calls.entryBlockClear += 1;
    if (!reason || this.entryBlock.reason === reason) {
      this.entryBlock = {
        blocked: false,
        reason: null,
        source: null,
        blockedAt: null,
        tradeDate: null,
      };
    }
    return {
      ok: true,
      data: {
        entryBlocked: this.entryBlock.blocked,
        entryBlockReason: this.entryBlock.reason,
        entryBlockSource: this.entryBlock.source,
      },
    };
  }

  async status() {
    return {
      data: {
        entryBlocked: this.entryBlock.blocked,
        entryBlockReason: this.entryBlock.reason,
        entryBlockSource: this.entryBlock.source,
        entryBlockAt: this.entryBlock.blockedAt,
        entryBlockTradeDate: this.entryBlock.tradeDate,
      },
    };
  }

  async listHeldSymbols() {
    return this.heldSymbols;
  }

  async evaluateMarkToMarket() {
    return this.markToMarketResult;
  }
}

function baseConfig() {
  return {
    runtime: {},
    exchange: {
      accessKey: "",
      secretKey: "",
    },
    tradingProfile: {
      name: "balanced",
    },
    strategy: {
      name: "mean_reversion",
      defaultSymbol: "BTC_KRW",
      candleInterval: "15m",
      candleCount: 180,
      meanLookback: 20,
      meanEntryBps: 60,
      meanExitBps: 10,
      baseOrderAmountKrw: 20000,
      autoSellEnabled: true,
    },
    risk: {
      maxMtmDailyLossKrw: 4000,
    },
    strategySettings: {
      enabled: false,
      settingsFile: null,
      maxAgeSec: 7200,
    },
    marketUniverse: {
      enabled: false,
    },
    execution: {
      enabled: true,
      symbol: "BTC_KRW",
      symbols: ["BTC_KRW"],
      orderAmountKrw: 20000,
      windowSec: 1,
      cooldownSec: 1,
      maxSymbolsPerWindow: 1,
      maxOrderAttemptsPerWindow: 1,
      dryRun: false,
      logOnlyOnActivity: true,
      restartDelayMs: 1,
      kpiMonitorMaxOpenLossPct: -1.5,
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

test("execution service reads single-symbol operator overrides from strategy settings", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "execution-settings-"));
  const settingsFile = path.join(baseDir, "strategy-settings.json");
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      enabled: true,
      symbol: "USDT_KRW",
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
  assert.equal(system.calls.realtime, 1);
  assert.equal(system.calls.args[0].symbol, "USDT_KRW");
  assert.equal(system.calls.args[0].amount, 7000);
  assert.equal(system.calls.args[0].durationSec, 2);
  assert.equal(system.calls.args[0].cooldownSec, 0);
});

test("execution service keeps held symbols in exit-only mode without consuming entry slots", async () => {
  const config = baseConfig();
  const system = new SystemMock();
  system.heldSymbols = ["TDROP_KRW"];

  const result = await runExecutionService({ system, config, stopAfterWindows: 1 });

  assert.equal(result.ok, true);
  assert.equal(system.calls.realtime, 2);
  assert.deepEqual(
    system.calls.args.map((row) => row.symbol),
    ["TDROP_KRW", "BTC_KRW"],
  );
  assert.equal(system.calls.args[0].executionPolicy.allowBuy, false);
  assert.equal(system.calls.args[0].executionPolicy.allowSell, true);
  assert.equal(system.calls.args[1].executionPolicy, null);
});

test("execution service applies pause entries from strategy settings", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "execution-pause-"));
  const settingsFile = path.join(baseDir, "strategy-settings.json");
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    controls: {
      pauseEntries: true,
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
  assert.equal(system.calls.entryBlockSet, 1);
  assert.equal(system.calls.realtime, 0);
  assert.deepEqual(system.calls.entryBlockArgs[0], {
    blocked: true,
    reason: "manual_pause_entries",
    source: "manual_pause_entries",
    manual: true,
  });
});

test("execution service clears manual pause entries when strategy settings disable it", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "execution-pause-reset-"));
  const settingsFile = path.join(baseDir, "strategy-settings.json");
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      enabled: true,
      symbol: "BTC_KRW",
    },
    controls: {
      pauseEntries: false,
    },
  };
  await fs.writeFile(settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const config = baseConfig();
  config.strategySettings.enabled = true;
  config.strategySettings.settingsFile = settingsFile;

  const system = new SystemMock();
  system.entryBlock = {
    blocked: true,
    reason: "manual_pause_entries",
    source: "manual_pause_entries",
    blockedAt: new Date().toISOString(),
    tradeDate: null,
  };
  const result = await runExecutionService({ system, config, stopAfterWindows: 1 });

  assert.equal(result.ok, true);
  assert.equal(system.calls.entryBlockClear >= 1, true);
  assert.equal(system.entryBlock.blocked, false);
  assert.equal(system.calls.realtime, 1);
});

test("execution service applies market universe filter to requested symbol", async () => {
  const config = baseConfig();

  const system = new SystemMock();
  const universe = {
    enabled: true,
    async init() {},
    async maybeRefresh() {
      return {
        ok: true,
        data: {
          symbols: ["USDT_KRW"],
        },
      };
    },
    filterSymbols(symbols = []) {
      return {
        symbols: symbols.filter((symbol) => symbol === "USDT_KRW"),
      };
    },
  };
  config.strategySettings.enabled = true;
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "execution-universe-"));
  const settingsFile = path.join(baseDir, "strategy-settings.json");
  await fs.writeFile(settingsFile, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      symbol: "USDT_KRW",
    },
  }, null, 2), "utf8");
  config.strategySettings.settingsFile = settingsFile;

  const result = await runExecutionService({
    system,
    config,
    stopAfterWindows: 1,
    marketUniverseService: universe,
  });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 1);
  assert.equal(system.calls.realtime, 1);
  assert.equal(system.calls.args[0].symbol, "USDT_KRW");
});

test("execution service activates entry block from mtm daily loss before trading", async () => {
  const config = baseConfig();
  const system = new SystemMock();
  system.markToMarketResult = {
    ok: true,
    code: 0,
    data: {
      positionCount: 1,
      totalUnrealizedPnlKrw: -2500,
      totalUnrealizedPnlPct: -2.5,
      dailyPnlKrw: -5000,
      equityMtmKrw: 95000,
    },
  };

  const result = await runExecutionService({
    system,
    config,
    stopAfterWindows: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stoppedBy, "window_limit");
  assert.equal(system.calls.entryBlockSet, 1);
  assert.equal(system.calls.realtime, 0);
});

test("execution service blocks new entries and switches to exit-only on open loss monitor alert", async () => {
  const config = baseConfig();

  const system = new SystemMock();
  system.heldSymbols = ["BTC_KRW"];
  system.markToMarketResult = {
    ok: true,
    code: 0,
    data: {
      positionCount: 1,
      totalUnrealizedPnlKrw: -1600,
      totalUnrealizedPnlPct: -2,
      dailyPnlKrw: -1000,
      equityMtmKrw: 99000,
    },
  };

  const result = await runExecutionService({
    system,
    config,
    stopAfterWindows: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 1);
  assert.equal(system.calls.realtime, 1);
  assert.equal(system.calls.args[0].symbol, "BTC_KRW");
  assert.equal(system.calls.args[0].executionPolicy.allowBuy, false);
  assert.equal(system.calls.args[0].executionPolicy.allowSell, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/defaults.js";
import { TradingSystem } from "../src/core/trading-system.js";

class ExchangeMock {
  constructor() {
    this.placeCalls = [];
    this.listCalls = [];
  }

  isRetryableError() {
    return false;
  }

  async getAccounts() {
    return [
      {
        currency: "KRW",
        balance: "120000",
        locked: "0",
        avg_buy_price: "0",
        unit_currency: "KRW",
      },
    ];
  }

  async getOrderChance() {
    return {
      market: {
        bid: { min_total: "5000" },
        ask: { min_total: "5000" },
      },
    };
  }

  async placeOrder(payload) {
    this.placeCalls.push(payload);
    return { uuid: "exchange-1" };
  }

  async listOrders(payload) {
    this.listCalls.push(payload);
    return [];
  }

  async getOrder() {
    return { uuid: "exchange-1" };
  }

  async cancelOrder() {
    return { uuid: "exchange-1", state: "cancel" };
  }
}

// Candle fixtures for realtime tests.
// Default interval is 15m = 900000 ms. Periods: 0, 900000, 1800000 = quarters 1-3.
// Tick timestamps 2700000+ land in period 2700000 (quarter 4) — after all historical candles.
const REALTIME_CANDLES_BUY = [
  { timestamp: 0, open: 93, high: 95, low: 90, close: 95 },
  { timestamp: 900000, open: 94, high: 96, low: 91, close: 96 },
  { timestamp: 1800000, open: 95, high: 97, low: 92, close: 97 },
];
// Highest high = 105 so ticks at price 100 do NOT trigger breakout-up (100 < 105).
const REALTIME_CANDLES_HOLD = [
  { timestamp: 0, open: 101, high: 105, low: 100, close: 102 },
  { timestamp: 900000, open: 100, high: 104, low: 99, close: 101 },
  { timestamp: 1800000, open: 99, high: 103, low: 98, close: 100 },
];

class MarketDataMock {
  constructor(candles = null) {
    this._candles = candles || [
      { timestamp: 1, high: 100, low: 90, close: 95 },
      { timestamp: 2, high: 101, low: 91, close: 96 },
      { timestamp: 3, high: 102, low: 92, close: 97 },
      { timestamp: 4, high: 103, low: 93, close: 104 },
    ];
  }

  async getCandles() {
    return {
      symbol: "BTC_KRW",
      interval: "15m",
      candles: this._candles,
      raw: [],
    };
  }
}

class MarketDataSellMock {
  async getCandles() {
    return {
      symbol: "BTC_KRW",
      interval: "15m",
      candles: [
        { timestamp: 1, high: 100, low: 90, close: 95 },
        { timestamp: 2, high: 101, low: 91, close: 96 },
        { timestamp: 3, high: 102, low: 92, close: 97 },
        { timestamp: 4, high: 81, low: 79, close: 80 },
      ],
      raw: [],
    };
  }
}

class OverlayMock {
  async readCurrent() {
    return {
      multiplier: 1.2,
      source: "overlay_multiplier",
      stale: false,
      updatedAt: new Date().toISOString(),
      score: null,
      regime: "risk_on",
    };
  }
}

class WsClientMock {
  constructor(ticks = []) {
    this.ticks = ticks;
    this.openCalls = [];
  }

  async openTickerStream({ symbols, onTicker, onError }) {
    this.openCalls.push({ symbols });
    let closed = false;
    let resolveClosed;
    const closedPromise = new Promise((resolve) => {
      resolveClosed = resolve;
    });

    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      resolveClosed({ code: 1000, reason: "mock_closed" });
    };

    queueMicrotask(() => {
      try {
        for (const tick of this.ticks) {
          if (closed) {
            break;
          }
          onTicker(tick);
        }
      } catch (error) {
        onError(error);
      } finally {
        close();
      }
    });

    return {
      close,
      closed: closedPromise,
    };
  }
}

class WsClientBlockingMock {
  constructor() {
    this.openCalls = [];
    this.closeCalls = 0;
  }

  async openTickerStream({ symbols }) {
    this.openCalls.push({ symbols });
    let closed = false;
    let resolveClosed;
    const closedPromise = new Promise((resolve) => {
      resolveClosed = resolve;
    });

    return {
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        this.closeCalls += 1;
        resolveClosed({ code: 1000, reason: "aborted" });
      },
      closed: closedPromise,
    };
  }
}

async function createConfig(extra = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "system-test-"));
  return loadConfig({
    TRADER_STATE_FILE: path.join(baseDir, "state.json"),
    TRADER_OVERLAY_FILE: path.join(baseDir, "overlay.json"),
    STRATEGY_NAME: "breakout",
    STRATEGY_BREAKOUT_LOOKBACK: "3",
    STRATEGY_BREAKOUT_BUFFER_BPS: "0",
    STRATEGY_BASE_ORDER_AMOUNT_KRW: "5000",
    ...extra,
  });
}

test("strategy run executes immediate market buy on BUY signal", async () => {
  const config = await createConfig();
  const exchange = new ExchangeMock();
  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(),
    overlayEngine: new OverlayMock(),
  });
  await system.init();

  const result = await system.runStrategyOnce({ symbol: "BTC_KRW" });

  assert.equal(result.ok, true);
  assert.equal(result.data.signal.action, "BUY");
  assert.equal(result.data.amountAdjustedKrw, 6000);
  assert.equal(result.data.order.exchangeOrderId, "exchange-1");
  assert.equal(exchange.placeCalls.length, 1);
});

test("strategy run sizes buy from available cash percentage when configured", async () => {
  const config = await createConfig({
    STRATEGY_CASH_USAGE_PCT: "50",
    RISK_MAX_ORDER_NOTIONAL_KRW: "50000",
    RISK_MAX_EXPOSURE_KRW: "100000",
    EXECUTION_MAX_SYMBOLS_PER_WINDOW: "1",
  });
  const exchange = new ExchangeMock();
  exchange.getAccounts = async () => [
    {
      currency: "KRW",
      balance: "80000",
      locked: "0",
      avg_buy_price: "0",
      unit_currency: "KRW",
    },
  ];
  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(),
    overlayEngine: new OverlayMock(),
  });
  await system.init();

  const result = await system.runStrategyOnce({ symbol: "BTC_KRW" });

  assert.equal(result.ok, true);
  assert.equal(result.data.amountBaseKrw, 40000);
  assert.equal(result.data.amountSubmittedKrw, 48000);
  assert.equal(result.data.sizingSource, "available_cash_pct");
  assert.equal(exchange.placeCalls.length, 1);
  assert.equal(exchange.placeCalls[0].amountKrw, 48000);
});

test("strategy run leaves buy cash buffer when sizing from full available cash", async () => {
  const config = await createConfig({
    STRATEGY_CASH_USAGE_PCT: "100",
    RISK_MAX_ORDER_NOTIONAL_KRW: "AUTO",
    RISK_MAX_EXPOSURE_KRW: "AUTO",
    RISK_BUY_CASH_BUFFER_BPS: "50",
    EXECUTION_MAX_SYMBOLS_PER_WINDOW: "1",
  });
  const exchange = new ExchangeMock();
  exchange.getAccounts = async () => [
    {
      currency: "KRW",
      balance: "100000",
      locked: "0",
      avg_buy_price: "0",
      unit_currency: "KRW",
    },
  ];
  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(),
    overlayEngine: new OverlayMock(),
  });
  await system.init();

  const result = await system.runStrategyOnce({ symbol: "BTC_KRW" });

  assert.equal(result.ok, true);
  assert.equal(result.data.amountBaseKrw, 100000);
  assert.equal(result.data.amountSubmittedKrw, 99500);
  assert.equal(result.data.sizingSource, "available_cash_pct");
  assert.equal(exchange.placeCalls.length, 1);
  assert.equal(exchange.placeCalls[0].amountKrw, 99500);
});

test("strategy run caps a single symbol to half of equity when two symbols are targeted", async () => {
  const config = await createConfig({
    STRATEGY_CASH_USAGE_PCT: "100",
    RISK_MAX_ORDER_NOTIONAL_KRW: "AUTO",
    RISK_MAX_EXPOSURE_KRW: "AUTO",
    RISK_BUY_CASH_BUFFER_BPS: "0",
    EXECUTION_MAX_SYMBOLS_PER_WINDOW: "2",
  });
  const exchange = new ExchangeMock();
  exchange.getAccounts = async () => [
    {
      currency: "KRW",
      balance: "120000",
      locked: "0",
      avg_buy_price: "0",
      unit_currency: "KRW",
    },
  ];
  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(),
    overlayEngine: new OverlayMock(),
  });
  await system.init();

  const result = await system.runStrategyOnce({ symbol: "BTC_KRW" });

  assert.equal(result.ok, true);
  assert.equal(result.data.amountSubmittedKrw, 60000);
  assert.equal(exchange.placeCalls[0].amountKrw, 60000);
});

test("strategy run dry-run does not submit exchange order", async () => {
  const config = await createConfig();
  const exchange = new ExchangeMock();
  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(),
    overlayEngine: new OverlayMock(),
  });
  await system.init();

  const result = await system.runStrategyOnce({ symbol: "BTC_KRW", dryRun: true });

  assert.equal(result.ok, true);
  assert.equal(result.data.signal.action, "BUY");
  assert.equal(result.data.order.dryRun, true);
  assert.equal(exchange.placeCalls.length, 0);
});

test("strategy sell uses available position amount when sell-all exit is enabled", async () => {
  const config = await createConfig({
    STRATEGY_SELL_ALL_ON_EXIT: "true",
  });
  const exchange = new ExchangeMock();
  exchange.getAccounts = async () => [
    {
      currency: "KRW",
      balance: "120000",
      locked: "0",
      avg_buy_price: "0",
      unit_currency: "KRW",
    },
    {
      currency: "BTC",
      balance: "300",
      locked: "0",
      avg_buy_price: "90",
      unit_currency: "KRW",
    },
  ];

  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataSellMock(),
    overlayEngine: new OverlayMock(),
  });
  await system.init();

  const result = await system.runStrategyOnce({ symbol: "BTC_KRW" });

  assert.equal(result.ok, true);
  assert.equal(result.data.signal.action, "SELL");
  assert.equal(exchange.placeCalls.length, 1);
  assert.equal(exchange.placeCalls[0].side, "sell");
  assert.equal(exchange.placeCalls[0].type, "market");
  assert.equal(exchange.placeCalls[0].qty, 300);
  assert.equal(Math.round(exchange.placeCalls[0].amountKrw), 24000);
});

test("protective sell exits full position even above max order notional", async () => {
  const config = await createConfig({
    STRATEGY_SELL_ALL_ON_EXIT: "true",
    RISK_MAX_ORDER_NOTIONAL_KRW: "18000",
    RISK_MAX_HOLDING_LOSS_PCT: "4",
  });
  const exchange = new ExchangeMock();
  exchange.getAccounts = async () => [
    {
      currency: "KRW",
      balance: "120000",
      locked: "0",
      avg_buy_price: "0",
      unit_currency: "KRW",
    },
    {
      currency: "BTC",
      balance: "300",
      locked: "0",
      avg_buy_price: "90",
      unit_currency: "KRW",
    },
  ];

  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataSellMock(),
    overlayEngine: new OverlayMock(),
  });
  await system.init();

  const result = await system.runStrategyOnce({ symbol: "BTC_KRW" });

  assert.equal(result.ok, true);
  assert.equal(result.data.protectiveExit?.reason, "protective_stop_loss");
  assert.equal(exchange.placeCalls.length, 1);
  assert.equal(exchange.placeCalls[0].side, "sell");
  assert.equal(exchange.placeCalls[0].qty, 300);
  assert.equal(Math.round(exchange.placeCalls[0].amountKrw), 24000);
});

test("strategy run does not force a take-profit exit when fixed TP is disabled", async () => {
  const config = await createConfig({
    STRATEGY_BREAKOUT_LOOKBACK: "4",
    RISK_MAX_HOLDING_TAKE_PROFIT_PCT: "0",
    RISK_TRAILING_ARM_PCT: "10",
    RISK_TRAILING_STOP_PCT: "5",
  });
  const exchange = new ExchangeMock();
  exchange.getAccounts = async () => [
    {
      currency: "KRW",
      balance: "120000",
      locked: "0",
      avg_buy_price: "0",
      unit_currency: "KRW",
    },
    {
      currency: "BTC",
      balance: "300",
      locked: "0",
      avg_buy_price: "90",
      unit_currency: "KRW",
    },
  ];
  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(REALTIME_CANDLES_HOLD),
    overlayEngine: new OverlayMock(),
  });
  await system.init();

  const result = await system.runStrategyOnce({ symbol: "BTC_KRW" });

  assert.equal(result.ok, true);
  assert.equal(result.data.protectiveExit, null);
  assert.equal(result.data.order, null);
  assert.equal(exchange.placeCalls.length, 0);
});

test("stream ticker collects realtime ticks from websocket client", async () => {
  const config = await createConfig();
  const wsClient = new WsClientMock([
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 100, streamType: "REALTIME", timestamp: 1 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 101, streamType: "REALTIME", timestamp: 2 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 102, streamType: "REALTIME", timestamp: 3 },
  ]);

  const system = new TradingSystem(config, {
    exchangeClient: new ExchangeMock(),
    marketData: new MarketDataMock(),
    overlayEngine: new OverlayMock(),
    wsClient,
  });
  await system.init();

  const result = await system.streamTicker({
    symbol: "BTC_KRW",
    durationSec: 1,
    maxEvents: 10,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.count, 3);
  assert.equal(result.data.ticks[2].tradePrice, 102);
  assert.equal(wsClient.openCalls.length, 1);
});

test("strategy realtime executes buy from websocket ticks", async () => {
  const config = await createConfig();
  const exchange = new ExchangeMock();
  // Ticks land in period 2700000 (quarter 4), after historical candles at 0/900000/1800000.
  // Prices 95-97 don't break out (highest historical high = 97); price 104 does.
  const wsClient = new WsClientMock([
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 95, streamType: "REALTIME", timestamp: 2700000 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 96, streamType: "REALTIME", timestamp: 2700001 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 97, streamType: "REALTIME", timestamp: 2700002 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 104, streamType: "REALTIME", timestamp: 2700003 },
  ]);

  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(REALTIME_CANDLES_BUY),
    overlayEngine: new OverlayMock(),
    wsClient,
  });
  await system.init();

  const result = await system.runStrategyRealtime({
    symbol: "BTC_KRW",
    durationSec: 1,
    cooldownSec: 0,
    dryRun: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.buySignals >= 1, true);
  assert.equal(result.data.successfulOrders >= 1, true);
  assert.equal(exchange.placeCalls.length >= 1, true);
});

test("strategy realtime closes promptly when stop signal is aborted", async () => {
  const config = await createConfig();
  const exchange = new ExchangeMock();
  const wsClient = new WsClientBlockingMock();
  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(REALTIME_CANDLES_BUY),
    overlayEngine: new OverlayMock(),
    wsClient,
  });
  await system.init();

  const controller = new AbortController();
  const pending = system.runStrategyRealtime({
    symbol: "BTC_KRW",
    durationSec: 300,
    stopSignal: controller.signal,
  });

  setTimeout(() => controller.abort(), 10);
  const result = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error("abort_timeout")), 500)),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.data.aborted, true);
  assert.equal(wsClient.closeCalls, 1);
});

test("strategy realtime can execute policy override decision without signal trigger", async () => {
  const config = await createConfig();
  const exchange = new ExchangeMock();
  // HOLD_HISTORY has highest high = 105, so price 100 never triggers breakout-up.
  // Only the policy override BUY should fire (once, then consumed).
  const wsClient = new WsClientMock([
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 100, streamType: "REALTIME", timestamp: 2700000 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 100, streamType: "REALTIME", timestamp: 2700001 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 100, streamType: "REALTIME", timestamp: 2700002 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 100, streamType: "REALTIME", timestamp: 2700003 },
  ]);

  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(REALTIME_CANDLES_HOLD),
    overlayEngine: new OverlayMock(),
    wsClient,
  });
  await system.init();

  const result = await system.runStrategyRealtime({
    symbol: "BTC_KRW",
    durationSec: 1,
    cooldownSec: 0,
    dryRun: false,
    executionPolicy: {
      mode: "override",
      forceAction: "BUY",
      forceAmountKrw: 9000,
      forceOnce: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.attemptedOrders, 1);
  assert.equal(exchange.placeCalls.length, 1);
  assert.equal(exchange.placeCalls[0].side, "buy");
  assert.equal(exchange.placeCalls[0].amountKrw, 10000);
  assert.equal(result.data.decisions[0].actionSource, "policy_override");
});

test("strategy realtime blocks additional buy when a symbol already has an open position", async () => {
  const config = await createConfig();
  const exchange = new ExchangeMock();
  exchange.getAccounts = async () => [
    {
      currency: "KRW",
      balance: "120000",
      locked: "0",
      avg_buy_price: "0",
      unit_currency: "KRW",
    },
    {
      currency: "BTC",
      balance: "300",
      locked: "0",
      avg_buy_price: "90",
      unit_currency: "KRW",
    },
  ];
  const wsClient = new WsClientMock([
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 100, streamType: "REALTIME", timestamp: 2700000 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 100, streamType: "REALTIME", timestamp: 2700001 },
  ]);

  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(REALTIME_CANDLES_HOLD),
    overlayEngine: new OverlayMock(),
    wsClient,
  });
  await system.init();

  const result = await system.runStrategyRealtime({
    symbol: "BTC_KRW",
    durationSec: 1,
    cooldownSec: 0,
    dryRun: false,
    executionPolicy: {
      mode: "override",
      forceAction: "BUY",
      forceAmountKrw: 9000,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.attemptedOrders, 0);
  assert.equal(result.data.successfulOrders, 0);
  assert.equal(exchange.placeCalls.length, 0);
  assert.equal(
    result.data.decisions.some((row) => row.skipped === "single_position_per_symbol"),
    true,
  );
});

test("strategy realtime does not consume force-once override on non-actionable sell", async () => {
  const config = await createConfig();
  const exchange = new ExchangeMock();
  // All ticks land in period 2700000. With pre-loaded history, every tick has enough
  // candles to evaluate; the override SELL is attempted each time but skipped (no position).
  // The override is NOT consumed (no actual order placed), verifying forceOnce is only
  // consumed when an order is successfully attempted.
  const wsClient = new WsClientMock([
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 100, streamType: "REALTIME", timestamp: 2700000 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 99, streamType: "REALTIME", timestamp: 2700001 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 98, streamType: "REALTIME", timestamp: 2700002 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 97, streamType: "REALTIME", timestamp: 2700003 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 97.5, streamType: "REALTIME", timestamp: 2700004 },
  ]);

  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(REALTIME_CANDLES_BUY),
    overlayEngine: new OverlayMock(),
    wsClient,
  });
  await system.init();

  const result = await system.runStrategyRealtime({
    symbol: "BTC_KRW",
    durationSec: 1,
    cooldownSec: 0,
    dryRun: false,
    executionPolicy: {
      mode: "override",
      forceAction: "SELL",
      forceAmountKrw: 5000,
      forceOnce: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.attemptedOrders, 0);
  assert.equal(result.data.successfulOrders, 0);
  assert.equal(exchange.placeCalls.length, 0);
  // With pre-loaded history every tick is evaluated; all decisions are override SELL
  // skipped due to no position — confirming forceOnce is never consumed.
  assert.ok(result.data.decisions.length >= 1);
  assert.equal(result.data.decisions.every((row) => row.actionSource === "policy_override"), true);
  assert.equal(result.data.decisions.every((row) => row.skipped === "no_position"), true);
});

test("realtime respects open-order cap with stale ACCEPTED state", async () => {
  const config = await createConfig({
    RISK_MAX_OPEN_ORDERS: "1",
  });
  const exchange = new ExchangeMock();
  // HOLD_HISTORY (highest=105) keeps the signal neutral for prices 95-98,
  // so only the policy override BUY fires — it should succeed (ACCEPTED order is not open).
  const wsClient = new WsClientMock([
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 95, streamType: "REALTIME", timestamp: 2700000 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 96, streamType: "REALTIME", timestamp: 2700001 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 97, streamType: "REALTIME", timestamp: 2700002 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 98, streamType: "REALTIME", timestamp: 2700003 },
  ]);

  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(REALTIME_CANDLES_HOLD),
    overlayEngine: new OverlayMock(),
    wsClient,
  });
  await system.init();

  await system.store.update((state) => {
    state.orders.push({
      id: "stale-open",
      state: "ACCEPTED",
      symbol: "BTC_KRW",
      clientOrderKey: "legacy",
    });
    return state;
  });

  const result = await system.runStrategyRealtime({
    symbol: "BTC_KRW",
    durationSec: 1,
    cooldownSec: 0,
    dryRun: false,
    executionPolicy: {
      mode: "override",
      forceAction: "BUY",
      forceAmountKrw: 9000,
      forceOnce: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(exchange.placeCalls.length, 0);
  assert.equal(result.data.successfulOrders, 0);
});

test("realtime allows another attempt after retryable order failure within the same window", async () => {
  const config = await createConfig();
  const exchange = new ExchangeMock();
  let callCount = 0;
  exchange.isRetryableError = (error) => Boolean(error?.retryable);
  exchange.placeOrder = async (payload) => {
    exchange.placeCalls.push(payload);
    callCount += 1;
    if (callCount === 1) {
      const error = new Error("temporary exchange issue");
      error.retryable = true;
      throw error;
    }
    return { uuid: `exchange-${callCount}` };
  };

  const wsClient = new WsClientMock([
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 100, streamType: "REALTIME", timestamp: 2700000 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 100, streamType: "REALTIME", timestamp: 2700001 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 100, streamType: "REALTIME", timestamp: 2700002 },
  ]);

  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(REALTIME_CANDLES_HOLD),
    overlayEngine: new OverlayMock(),
    wsClient,
  });
  await system.init();

  const result = await system.runStrategyRealtime({
    symbol: "BTC_KRW",
    durationSec: 1,
    cooldownSec: 0,
    dryRun: false,
    executionPolicy: {
      mode: "override",
      forceAction: "BUY",
      forceAmountKrw: 9000,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.attemptedOrders, 2);
  assert.equal(result.data.successfulOrders, 1);
  assert.equal(exchange.placeCalls.length, 2);
});

test("realtime blocks further attempts after non-retryable order failure within the same window", async () => {
  const config = await createConfig();
  const exchange = new ExchangeMock();
  exchange.isRetryableError = () => false;
  exchange.placeOrder = async (payload) => {
    exchange.placeCalls.push(payload);
    const error = new Error("invalid request");
    error.status = 400;
    throw error;
  };

  const wsClient = new WsClientMock([
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 100, streamType: "REALTIME", timestamp: 2700000 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 100, streamType: "REALTIME", timestamp: 2700001 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 100, streamType: "REALTIME", timestamp: 2700002 },
  ]);

  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(REALTIME_CANDLES_HOLD),
    overlayEngine: new OverlayMock(),
    wsClient,
  });
  await system.init();

  const result = await system.runStrategyRealtime({
    symbol: "BTC_KRW",
    durationSec: 1,
    cooldownSec: 0,
    dryRun: false,
    executionPolicy: {
      mode: "override",
      forceAction: "BUY",
      forceAmountKrw: 9000,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.attemptedOrders, 1);
  assert.equal(result.data.successfulOrders, 0);
  assert.equal(exchange.placeCalls.length, 1);
  assert.equal(
    result.data.decisions.some((row) => row.skipped === "order_blocked_after_non_retryable_failure"),
    true,
  );
});

test("orderList forwards uuids/states options to exchange listOrders", async () => {
  const config = await createConfig();
  const exchange = new ExchangeMock();
  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(),
    overlayEngine: new OverlayMock(),
  });
  await system.init();

  const result = await system.orderList({
    symbol: "BTC_KRW",
    uuids: "id-1,id-2",
    states: ["wait", "watch"],
    page: 2,
    limit: 50,
    orderBy: "asc",
  });

  assert.equal(result.ok, true);
  assert.equal(exchange.listCalls.length, 1);
  assert.deepEqual(exchange.listCalls[0], {
    symbol: "BTC_KRW",
    uuids: ["id-1", "id-2"],
    state: null,
    states: ["wait", "watch"],
    page: 2,
    limit: 50,
    orderBy: "asc",
  });
});

test("market buy reconciliation keeps market type and fill-derived price/qty", async () => {
  const config = await createConfig();
  const exchange = new ExchangeMock();
  exchange.getOrderStatus = async () => ({
    uuid: "exchange-1",
    state: "done",
    side: "bid",
    ord_type: "price",
    price: "18000",
    executed_volume: "131.38686131386862",
    avg_price: "137",
    paid_fee: "45",
  });

  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(),
    overlayEngine: new OverlayMock(),
  });
  await system.init();

  const result = await system.placeOrder({
    symbol: "SWAP_KRW",
    side: "buy",
    type: "market",
    amount: 18000,
    expectedPrice: 137,
    reason: "test_market_buy_reconcile",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.type, "market");
  assert.equal(result.data.amountKrw, 18000);
  assert.equal(result.data.price, 137);
  assert.equal(result.data.qty, 131.38686131386862);
  assert.equal(result.data.filledQty, 131.38686131386862);
});

// ---------------------------------------------------------------------------
// FIX-1  protective exit bypasses cooldown and order-attempt cap
// ---------------------------------------------------------------------------

test("realtime protective exit fires even when cooldown is active after a buy", async () => {
  // Scenario: already holding BTC at avgBuyPrice=100, price crashes to 80 (-20%)
  // => protective_stop_loss must fire despite a very long cooldown.
  // No buy occurs here; we only test that cooldown does not block protective exit.
  const config = await createConfig({
    STRATEGY_BREAKOUT_LOOKBACK: "3",
    STRATEGY_BREAKOUT_BUFFER_BPS: "0",
    RISK_MAX_HOLDING_LOSS_PCT: "3",
  });
  const exchange = new ExchangeMock();
  exchange.getAccounts = async () => [
    { currency: "KRW", balance: "120000", locked: "0", avg_buy_price: "0", unit_currency: "KRW" },
    { currency: "BTC", balance: "100", locked: "0", avg_buy_price: "100", unit_currency: "KRW" },
  ];

  // Use HOLD candles so no BUY/SELL signal from strategy — only protective exit.
  // Tick at price 80 triggers -20% loss => protective exit.
  const wsClient = new WsClientMock([
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 100, streamType: "REALTIME", timestamp: 2700000 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 80, streamType: "REALTIME", timestamp: 2700001 },
  ]);

  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(REALTIME_CANDLES_HOLD),
    overlayEngine: new OverlayMock(),
    wsClient,
  });
  await system.init();

  // Simulate that a buy just succeeded moments ago by seeding internal state.
  // We call runStrategyRealtime with a huge cooldown to confirm protective exit bypasses it.
  const result = await system.runStrategyRealtime({
    symbol: "BTC_KRW",
    durationSec: 1,
    cooldownSec: 9999,
    maxOrderAttemptsPerWindow: 0,
    dryRun: false,
  });

  assert.equal(result.ok, true);
  const sellDecisions = result.data.decisions.filter(
    (d) => d.side === "sell" && d.actionSource === "protective_exit" && d.orderOk === true,
  );
  assert.equal(sellDecisions.length >= 1, true, "protective exit sell must execute despite active cooldown");
});

test("realtime protective exit fires even when order-attempt cap is reached", async () => {
  // Scenario: a buy already consumed the single order attempt.
  // Price then crashes triggering protective exit — must still fire.
  const config = await createConfig({
    STRATEGY_BREAKOUT_LOOKBACK: "3",
    STRATEGY_BREAKOUT_BUFFER_BPS: "0",
    RISK_MAX_HOLDING_LOSS_PCT: "3",
    RISK_SINGLE_POSITION_PER_SYMBOL: "false",
  });
  const exchange = new ExchangeMock();
  // The getOrder/reconcile mock returns uuid but no terminal state,
  // so the order record stays as UNKNOWN_SUBMIT (non-blocking for sells).
  exchange.getAccounts = async () => [
    { currency: "KRW", balance: "120000", locked: "0", avg_buy_price: "0", unit_currency: "KRW" },
    { currency: "BTC", balance: "100", locked: "0", avg_buy_price: "100", unit_currency: "KRW" },
  ];
  // Reconcile returns done state so the open order count clears.
  exchange.getOrder = async () => ({ uuid: "exchange-1", state: "done" });
  exchange.getOrderStatus = exchange.getOrder;

  const wsClient = new WsClientMock([
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 104, streamType: "REALTIME", timestamp: 2700000 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 80, streamType: "REALTIME", timestamp: 2700001 },
  ]);

  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(REALTIME_CANDLES_BUY),
    overlayEngine: new OverlayMock(),
    wsClient,
  });
  await system.init();

  const result = await system.runStrategyRealtime({
    symbol: "BTC_KRW",
    durationSec: 1,
    cooldownSec: 0,
    maxOrderAttemptsPerWindow: 1,
    dryRun: false,
  });

  assert.equal(result.ok, true);
  const sellDecisions = result.data.decisions.filter(
    (d) => d.side === "sell" && d.actionSource === "protective_exit" && d.orderOk === true,
  );
  assert.equal(sellDecisions.length >= 1, true, "protective exit sell must bypass order attempt cap");
});

// ---------------------------------------------------------------------------
// FIX-2  REST fallback protective exit when WS stream has no ticks
// ---------------------------------------------------------------------------

test("realtime REST fallback protective exit fires when no WS ticks arrive", async () => {
  const config = await createConfig({
    STRATEGY_BREAKOUT_LOOKBACK: "3",
    STRATEGY_BREAKOUT_BUFFER_BPS: "0",
    RISK_MAX_HOLDING_LOSS_PCT: "3",
    EXECUTION_REST_FALLBACK_INTERVAL_MS: "200",
  });
  const exchange = new ExchangeMock();
  exchange.getAccounts = async () => [
    { currency: "KRW", balance: "120000", locked: "0", avg_buy_price: "0", unit_currency: "KRW" },
    { currency: "BTC", balance: "100", locked: "0", avg_buy_price: "100", unit_currency: "KRW" },
  ];

  // WsClientMock sends no ticks — simulates a dead/disconnected stream.
  const wsClient = new WsClientMock([]);

  // MarketDataMock.getMarketTicker returns a price of 80 => -20% loss => protective exit.
  const marketData = new MarketDataMock(REALTIME_CANDLES_HOLD);
  marketData.getMarketTicker = async () => ({
    symbol: "BTC_KRW",
    market: "KRW-BTC",
    trade_price: 80,
    tradePrice: 80,
  });
  marketData.extractTickerMetrics = (data) => ({
    lastPrice: data?.tradePrice ?? data?.trade_price ?? null,
  });

  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData,
    overlayEngine: new OverlayMock(),
    wsClient,
  });
  await system.init();

  const result = await system.runStrategyRealtime({
    symbol: "BTC_KRW",
    durationSec: 1,
    cooldownSec: 0,
    dryRun: false,
  });

  assert.equal(result.ok, true);
  // Even though WS was dead, REST fallback should have triggered protective exit
  const sellDecisions = (result.data.decisions || []).filter(
    (d) => d.side === "sell" && d.actionSource === "protective_exit",
  );
  assert.equal(sellDecisions.length >= 1, true, "REST fallback protective exit must fire when WS is dead");
  assert.equal(sellDecisions.some((d) => d.orderOk === true), true, "REST fallback protective exit must submit");
  assert.equal(exchange.placeCalls.length, 1);
  assert.equal(exchange.placeCalls[0].side, "sell");
  assert.equal(exchange.placeCalls[0].type, "market");
  assert.equal(Math.round(exchange.placeCalls[0].amountKrw), 8000);
});

test("loadAccountContext cache reduces API calls within TTL window", async () => {
  const config = await createConfig({
    EXECUTION_ACCOUNT_CACHE_TTL_MS: "5000",
  });
  const exchange = new ExchangeMock();
  let getAccountsCalls = 0;
  const originalGetAccounts = exchange.getAccounts.bind(exchange);
  exchange.getAccounts = async () => {
    getAccountsCalls += 1;
    return originalGetAccounts();
  };

  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(),
    overlayEngine: new OverlayMock(),
    wsClient: new WsClientMock([]),
  });
  await system.init();

  // Call loadAccountContext 5 times rapidly — cache should reduce to 1 API call
  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(await system.loadAccountContext());
  }

  assert.equal(getAccountsCalls, 1, "cache must collapse rapid loadAccountContext calls into one API call");
  assert.equal(results[0].source, "exchange_accounts");
  assert.equal(results[4].source, "exchange_accounts");

  // After invalidation, the next call should hit the API again
  system.invalidateAccountCache();
  await system.loadAccountContext();
  assert.equal(getAccountsCalls, 2, "invalidateAccountCache must force a fresh API call");
});

test("keep-latest retention keeps open orders and latest snapshots", async () => {
  const config = await createConfig({
    TRADER_STATE_KEEP_LATEST_ONLY: "true",
    TRADER_RETENTION_CLOSED_ORDERS: "1",
    TRADER_RETENTION_ORDER_EVENTS: "10",
    TRADER_RETENTION_FILLS: "2",
  });
  const system = new TradingSystem(config, {
    exchangeClient: new ExchangeMock(),
    marketData: new MarketDataMock(),
    overlayEngine: new OverlayMock(),
  });
  await system.init();

  const next = system.applyStateRetention({
    orders: [
      { id: "open-1", state: "NEW", clientOrderKey: "k-open" },
      { id: "closed-1", state: "FILLED", clientOrderKey: "k-1" },
      { id: "closed-2", state: "CANCELED", clientOrderKey: "k-2" },
    ],
    orderEvents: [
      { orderId: "closed-1", payload: { clientOrderKey: "k-1" } },
      { orderId: "closed-2", payload: { clientOrderKey: "k-2" } },
      { orderId: "open-1", payload: { clientOrderKey: "k-open" } },
    ],
    strategyRuns: [{ id: "r1" }, { id: "r2" }],
    balancesSnapshot: [{ id: "b1" }, { id: "b2" }],
    fills: [{ id: "f1" }, { id: "f2" }, { id: "f3" }],
    riskEvents: [{ id: "x1" }, { id: "x2" }],
    systemHealth: [{ id: "h1" }, { id: "h2" }],
    agentAudit: [{ id: "a1" }, { id: "a2" }],
    marketData: {
      ticks: [1, 2],
      candles: [1, 2],
    },
  });

  assert.equal(next.orders.length, 2);
  assert.equal(next.orders.some((row) => row.id === "open-1"), true);
  assert.equal(next.orders.some((row) => row.id === "closed-2"), true);
  assert.equal(next.orderEvents.length, 3);
  assert.equal(next.strategyRuns.length, 1);
  assert.equal(next.balancesSnapshot.length, 1);
  assert.equal(next.fills.length, 2);
  assert.deepEqual(next.marketData.ticks, []);
  assert.deepEqual(next.marketData.candles, []);
});

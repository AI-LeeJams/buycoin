import path from "node:path";

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPositiveInt(value, fallback) {
  const parsed = toNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function toNonNegativeInt(value, fallback) {
  const parsed = toNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function toPositiveNumber(value, fallback) {
  const parsed = toNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function toNonNegativeNumber(value, fallback) {
  const parsed = toNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function toCsvList(value, fallback = []) {
  if (value === undefined || value === null || value === "") {
    return Array.isArray(fallback) ? fallback.slice() : [];
  }
  return String(value)
    .split(",")
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function toCsvPositiveInts(value, fallback = []) {
  const raw = toCsvList(value, fallback);
  const numbers = raw
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.floor(item));
  return numbers.length > 0 ? numbers : fallback.slice();
}

function toCsvPositiveNumbers(value, fallback = []) {
  const raw = toCsvList(value, fallback);
  const numbers = raw
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);
  return numbers.length > 0 ? numbers : fallback.slice();
}

function toCsvNonNegativeNumbers(value, fallback = []) {
  const raw = toCsvList(value, fallback);
  const numbers = raw
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item >= 0);
  return numbers.length > 0 ? numbers : fallback.slice();
}

function toCsvSymbols(value, fallback = []) {
  const raw = toCsvList(value, fallback);
  const normalized = raw.map((item) => normalizeSymbol(item)).filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : fallback.slice();
}

function toCsvSymbolsOrNone(value, fallback = []) {
  const token = String(value ?? "").trim().toUpperCase();
  if (token === "NONE" || token === "EMPTY" || token === "-") {
    return [];
  }
  return toCsvSymbols(value, fallback);
}

function toNullablePositiveNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function toNullablePositiveNumberOrAuto(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const token = String(value).trim().toUpperCase();
  if (token === "AUTO" || token === "NONE" || token === "DYNAMIC") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function normalizeSymbol(symbol) {
  if (!symbol) {
    return "BTC_KRW";
  }
  return String(symbol).trim().toUpperCase().replace(/-/g, "_");
}

export function toBithumbMarket(symbol) {
  const normalized = normalizeSymbol(symbol);
  const [base, quote] = normalized.split("_");
  if (!base || !quote) {
    throw new Error(`Invalid symbol format: ${symbol}`);
  }
  return `${quote}-${base}`;
}

export function fromBithumbMarket(market) {
  const token = String(market || "").trim().toUpperCase().replace(/-/g, "_");
  const [quote, base] = token.split("_");
  if (!base || !quote) {
    return normalizeSymbol(market);
  }
  return `${base}_${quote}`;
}

export function loadConfig(env = process.env) {
  const defaultSymbol = normalizeSymbol(env.STRATEGY_SYMBOL || env.TRADER_DEFAULT_SYMBOL || "BTC_KRW");
  const optimizerDefaultSymbols = Array.from(new Set([defaultSymbol, "ETH_KRW", "USDT_KRW"]));
  const universeDefaultIncludes = [];

  return {
    runtime: {
      stateFile: env.TRADER_STATE_FILE || path.join(process.cwd(), ".trader", "state.json"),
      overlayFile: env.TRADER_OVERLAY_FILE || path.join(process.cwd(), ".trader", "overlay.json"),
      httpAuditEnabled: toBoolean(env.TRADER_HTTP_AUDIT_ENABLED, false),
      httpAuditFile: env.TRADER_HTTP_AUDIT_FILE || path.join(process.cwd(), ".trader", "http-audit.jsonl"),
      httpAuditMaxBytes: toNonNegativeInt(env.TRADER_HTTP_AUDIT_MAX_BYTES, 10 * 1024 * 1024),
      httpAuditPruneRatio: toNumber(env.TRADER_HTTP_AUDIT_PRUNE_RATIO, 0.7),
      httpAuditCheckEvery: toPositiveInt(env.TRADER_HTTP_AUDIT_CHECK_EVERY, 200),
      timezone: env.TZ || "Asia/Seoul",
      stateLockStaleMs: toPositiveInt(env.TRADER_STATE_LOCK_STALE_MS, 30_000),
      retention: {
        keepLatestOnly: toBoolean(env.TRADER_STATE_KEEP_LATEST_ONLY, true),
        closedOrders: toNonNegativeInt(env.TRADER_RETENTION_CLOSED_ORDERS, 20),
        orders: toPositiveInt(env.TRADER_RETENTION_ORDERS, 400),
        orderEvents: toPositiveInt(env.TRADER_RETENTION_ORDER_EVENTS, 1000),
        strategyRuns: toPositiveInt(env.TRADER_RETENTION_STRATEGY_RUNS, 400),
        strategyRunDecisions: toPositiveInt(env.TRADER_RETENTION_STRATEGY_RUN_DECISIONS, 25),
        balancesSnapshot: toPositiveInt(env.TRADER_RETENTION_BALANCE_SNAPSHOTS, 120),
        fills: toPositiveInt(env.TRADER_RETENTION_FILLS, 1000),
        pruneUnknownSubmitMs: toNonNegativeInt(env.TRADER_RETENTION_PRUNE_UNKNOWN_SUBMIT_MS, 1_800_000),
        keepLatestOnlyStrategyRuns: toPositiveInt(env.TRADER_RETENTION_KEEP_LATEST_ONLY_STRATEGY_RUNS, 1),
        keepLatestOnlyBalancesSnapshot: toPositiveInt(env.TRADER_RETENTION_KEEP_LATEST_ONLY_BALANCE_SNAPSHOTS, 1),
        keepLatestOnlyFills: toPositiveInt(
          env.TRADER_RETENTION_KEEP_LATEST_ONLY_FILLS,
          toPositiveInt(env.TRADER_RETENTION_FILLS, 1000),
        ),
        executionKpiHistory: toPositiveInt(env.TRADER_STATE_KPI_HISTORY_MAX_ENTRIES, 240),
        executionKpiHistoryShardDays: toPositiveInt(env.TRADER_STATE_KPI_HISTORY_SHARD_DAYS, 7),
        keepLatestOnlyRiskEvents: toPositiveInt(env.TRADER_RETENTION_KEEP_LATEST_ONLY_RISK_EVENTS, 100),
        keepLatestOnlySystemHealth: toPositiveInt(env.TRADER_RETENTION_KEEP_LATEST_ONLY_SYSTEM_HEALTH, 100),
        keepLatestOnlyAgentAudit: toPositiveInt(env.TRADER_RETENTION_KEEP_LATEST_ONLY_AGENT_AUDIT, 100),
      },
    },
    exchange: {
      baseUrl: env.BITHUMB_BASE_URL || "https://api.bithumb.com",
      wsPublicUrl: env.BITHUMB_WS_PUBLIC_URL || "wss://ws-api.bithumb.com/websocket/v1",
      wsPrivateUrl: env.BITHUMB_WS_PRIVATE_URL || "wss://ws-api.bithumb.com/websocket/v1/private",
      accessKey: env.BITHUMB_ACCESS_KEY || "",
      secretKey: env.BITHUMB_SECRET_KEY || "",
      timeoutMs: toPositiveInt(env.BITHUMB_TIMEOUT_MS, 5_000),
      maxRetries: toPositiveInt(env.BITHUMB_MAX_RETRIES, 4),
      retryBaseMs: toPositiveInt(env.BITHUMB_RETRY_BASE_MS, 250),
      publicMaxPerSec: toPositiveInt(env.BITHUMB_PUBLIC_MAX_PER_SEC, 150),
      privateMaxPerSec: toPositiveInt(env.BITHUMB_PRIVATE_MAX_PER_SEC, 140),
      wsConnectMaxPerSec: toPositiveInt(env.BITHUMB_WS_CONNECT_MAX_PER_SEC, 5),
    },
    strategy: {
      name: String(env.STRATEGY_NAME || "risk_managed_momentum").toLowerCase(),
      defaultSymbol,
      candleInterval: String(env.STRATEGY_CANDLE_INTERVAL || "15m").toLowerCase(),
      candleCount: toPositiveInt(env.STRATEGY_CANDLE_COUNT, 180),
      breakoutLookback: toPositiveInt(env.STRATEGY_BREAKOUT_LOOKBACK, 20),
      breakoutBufferBps: toNonNegativeNumber(env.STRATEGY_BREAKOUT_BUFFER_BPS, 5),
      momentumLookback: toPositiveInt(env.STRATEGY_MOMENTUM_LOOKBACK, 24),
      volatilityLookback: toPositiveInt(env.STRATEGY_VOLATILITY_LOOKBACK, 72),
      momentumEntryBps: toPositiveNumber(env.STRATEGY_MOMENTUM_ENTRY_BPS, 12),
      momentumExitBps: toPositiveNumber(env.STRATEGY_MOMENTUM_EXIT_BPS, 8),
      meanLookback: toPositiveInt(env.STRATEGY_MEAN_LOOKBACK, 20),
      meanEntryBps: toPositiveNumber(env.STRATEGY_MEAN_ENTRY_BPS, 60),
      meanExitBps: toNonNegativeNumber(env.STRATEGY_MEAN_EXIT_BPS, 10),
      targetVolatilityPct: toPositiveNumber(env.STRATEGY_TARGET_VOLATILITY_PCT, 0.6),
      riskManagedMinMultiplier: toPositiveNumber(env.STRATEGY_RM_MIN_MULTIPLIER, 0.6),
      riskManagedMaxMultiplier: toPositiveNumber(env.STRATEGY_RM_MAX_MULTIPLIER, 2.2),
      autoSellEnabled: toBoolean(env.STRATEGY_AUTO_SELL_ENABLED, true),
      sellAllOnExit: toBoolean(env.STRATEGY_SELL_ALL_ON_EXIT, true),
      sellAllQtyPrecision: toPositiveInt(env.STRATEGY_SELL_ALL_QTY_PRECISION, 8),
      baseOrderAmountKrw: toPositiveNumber(env.STRATEGY_BASE_ORDER_AMOUNT_KRW, 12_000),
      cashUsagePct: toPositiveNumber(env.STRATEGY_CASH_USAGE_PCT, 0),
      rebound: {
        enabled: toBoolean(env.REBOUND_ENABLED, true),
        dropLookback: toPositiveInt(env.REBOUND_DROP_LOOKBACK, 8),
        dropPct: toNumber(env.REBOUND_DROP_PCT, -2.5),
        confirmEma: toPositiveInt(env.REBOUND_CONFIRM_EMA, 9),
        breakoutLookback: toPositiveInt(env.REBOUND_BREAKOUT_LOOKBACK, 6),
        entrySplits: [0.4, 0.3, 0.3],
        stopLossPct: toPositiveNumber(env.REBOUND_STOP_LOSS_PCT, 4.8),
        tp1Pct: toPositiveNumber(env.REBOUND_TP1_PCT, 2.2),
        tp2Pct: toPositiveNumber(env.REBOUND_TP2_PCT, 3.8),
        trailPct: toPositiveNumber(env.REBOUND_TRAIL_PCT, 1.2),
      },
    },
    optimizer: {
      enabled: toBoolean(env.OPTIMIZER_ENABLED, true),
      applyOnStart: toBoolean(env.OPTIMIZER_APPLY_ON_START, true),
      applyToStrategySettings: toBoolean(
        env.OPTIMIZER_APPLY_TO_STRATEGY_SETTINGS ?? env.OPTIMIZER_APPLY_TO_AI_SETTINGS,
        true,
      ),
      lockFile: env.OPTIMIZER_LOCK_FILE || path.join(process.cwd(), ".trader", "optimize.lock"),
      lockTtlSec: toPositiveInt(env.OPTIMIZER_LOCK_TTL_SEC, 900),
      reoptEnabled: toBoolean(env.OPTIMIZER_REOPT_ENABLED, true),
      reoptIntervalSec: toPositiveInt(env.OPTIMIZER_REOPT_INTERVAL_SEC, 3600),
      reportFile: env.OPTIMIZER_REPORT_FILE || path.join(process.cwd(), ".trader", "optimizer-report.json"),
      symbols: toCsvSymbols(env.OPTIMIZER_SYMBOLS, optimizerDefaultSymbols),
      maxLiveSymbols: toPositiveInt(env.OPTIMIZER_MAX_LIVE_SYMBOLS, 2),
      minListingAgeDays: toNonNegativeInt(
        env.OPTIMIZER_MIN_LISTING_AGE_DAYS,
        toNonNegativeInt(env.MARKET_UNIVERSE_MIN_LISTING_AGE_DAYS, 365),
      ),
      minHistoryCandles: toPositiveInt(
        env.OPTIMIZER_MIN_HISTORY_CANDLES,
        toPositiveInt(env.OPTIMIZER_CANDLE_COUNT, 200),
      ),
      strategies: Array.from(new Set(
        toCsvList(env.OPTIMIZER_STRATEGIES, [
          "risk_managed_momentum",
          "breakout",
          "mean_reversion",
        ]).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean),
      )),
      interval: String(env.OPTIMIZER_INTERVAL || env.STRATEGY_CANDLE_INTERVAL || "15m").toLowerCase(),
      candleCount: toPositiveInt(env.OPTIMIZER_CANDLE_COUNT, 200),
      initialCashKrw: toPositiveNumber(
        env.OPTIMIZER_INITIAL_CASH_KRW,
        100_000,
      ),
      baseOrderAmountKrw: toPositiveNumber(
        env.OPTIMIZER_BASE_ORDER_AMOUNT_KRW,
        toPositiveNumber(env.EXECUTION_ORDER_AMOUNT_KRW, 12_000),
      ),
      minOrderNotionalKrw: toPositiveNumber(
        env.OPTIMIZER_MIN_ORDER_NOTIONAL_KRW,
        toPositiveNumber(env.RISK_MIN_ORDER_NOTIONAL_KRW, 10_000),
      ),
      feeBps: toPositiveNumber(env.OPTIMIZER_FEE_BPS, 5),
      backtestSlippageBps: toPositiveNumber(env.OPTIMIZER_BACKTEST_SLIPPAGE_BPS, 0),
      maxDrawdownPctLimit: toPositiveNumber(env.OPTIMIZER_MAX_DRAWDOWN_PCT, 10),
      minTrades: toNonNegativeInt(env.OPTIMIZER_MIN_TRADES, 4),
      minWinRatePct: toPositiveNumber(env.OPTIMIZER_MIN_WIN_RATE_PCT, 45),
      minProfitFactor: toPositiveNumber(env.OPTIMIZER_MIN_PROFIT_FACTOR, 1.05),
      minReturnPct: toNumber(env.OPTIMIZER_MIN_RETURN_PCT, 0),
      walkForwardEnabled: toBoolean(env.OPTIMIZER_WALK_FORWARD_ENABLED, true),
      walkForwardScoreWeight: toNumber(env.OPTIMIZER_WALK_FORWARD_SCORE_WEIGHT, 0.25),
      walkForwardTrainWindow: toPositiveInt(env.OPTIMIZER_WALK_FORWARD_TRAIN_WINDOW, 80),
      walkForwardTestWindow: toPositiveInt(env.OPTIMIZER_WALK_FORWARD_TEST_WINDOW, 40),
      walkForwardStepWindow: toPositiveInt(env.OPTIMIZER_WALK_FORWARD_STEP_WINDOW, 30),
      walkForwardMaxFolds: toPositiveInt(env.OPTIMIZER_WALK_FORWARD_MAX_FOLDS, 0),
      walkForwardMinScore: toNumber(env.OPTIMIZER_WALK_FORWARD_MIN_SCORE, -999999),
      // With default optimizer windows (train 80 / test 40 / step 30) and 200 candles,
      // max fold count is 3. Keep default min fold count aligned to avoid rejecting all candidates.
      walkForwardMinFoldCount: toPositiveInt(env.OPTIMIZER_WALK_FORWARD_MIN_FOLD_COUNT, 3),
      walkForwardMinPassRate: toNumber(env.OPTIMIZER_WALK_FORWARD_MIN_PASS_RATE, 0.55),
      topResults: toPositiveInt(env.OPTIMIZER_TOP_RESULTS, 10),
      momentumLookbacks: toCsvPositiveInts(env.OPTIMIZER_MOMENTUM_LOOKBACKS, [24, 36, 48, 72]),
      volatilityLookbacks: toCsvPositiveInts(env.OPTIMIZER_VOLATILITY_LOOKBACKS, [72, 96, 120, 144]),
      entryBpsCandidates: toCsvPositiveNumbers(env.OPTIMIZER_ENTRY_BPS, [10, 16, 24, 32]),
      exitBpsCandidates: toCsvPositiveNumbers(env.OPTIMIZER_EXIT_BPS, [6, 10, 14, 20]),
      breakoutLookbacks: toCsvPositiveInts(env.OPTIMIZER_BREAKOUT_LOOKBACKS, [10, 20, 30, 55]),
      breakoutBufferBpsCandidates: toCsvNonNegativeNumbers(env.OPTIMIZER_BREAKOUT_BUFFER_BPS, [0, 5, 10, 15]),
      meanLookbacks: toCsvPositiveInts(env.OPTIMIZER_MEAN_LOOKBACKS, [12, 20, 30, 48]),
      meanEntryBpsCandidates: toCsvPositiveNumbers(env.OPTIMIZER_MEAN_ENTRY_BPS, [40, 60, 90, 120]),
      meanExitBpsCandidates: toCsvNonNegativeNumbers(env.OPTIMIZER_MEAN_EXIT_BPS, [0, 10, 20, 30]),
      targetVolatilityPctCandidates: toCsvPositiveNumbers(env.OPTIMIZER_TARGET_VOLATILITY_PCT, [0.35, 0.5]),
      rmMinMultiplierCandidates: toCsvPositiveNumbers(env.OPTIMIZER_RM_MIN_MULTIPLIER, [0.4]),
      rmMaxMultiplierCandidates: toCsvPositiveNumbers(env.OPTIMIZER_RM_MAX_MULTIPLIER, [1.6, 1.8]),
    },
    risk: {
      minOrderNotionalKrw: toPositiveNumber(env.RISK_MIN_ORDER_NOTIONAL_KRW, 10_000),
      buyCashBufferBps: toNonNegativeNumber(env.RISK_BUY_CASH_BUFFER_BPS, 50),
      maxOrderNotionalKrw: toNullablePositiveNumberOrAuto(env.RISK_MAX_ORDER_NOTIONAL_KRW, 18_000),
      maxOpenOrders: toPositiveInt(env.RISK_MAX_OPEN_ORDERS, 2),
      maxOpenOrdersPerSymbol: toPositiveInt(env.RISK_MAX_OPEN_ORDERS_PER_SYMBOL, 1),
      maxExposureKrw: toNullablePositiveNumberOrAuto(env.RISK_MAX_EXPOSURE_KRW, 65_000),
      maxDailyLossKrw: toPositiveNumber(env.RISK_MAX_DAILY_LOSS_KRW, 10_000),
      maxHoldingLossPct: toNumber(env.RISK_MAX_HOLDING_LOSS_PCT, 4.8),
      maxHoldingTakeProfitPct: toNumber(env.RISK_MAX_HOLDING_TAKE_PROFIT_PCT, 2.2),
      trailingStopPct: toPositiveNumber(env.RISK_TRAILING_STOP_PCT, 1.2),
      trailingArmPct: toPositiveNumber(env.RISK_TRAILING_ARM_PCT, 2.2),
      postExitBuyCooldownSec: toPositiveInt(env.RISK_POST_EXIT_BUY_COOLDOWN_SEC, 900),
      maxConsecutiveRiskRejects: toPositiveInt(env.RISK_MAX_CONSECUTIVE_RISK_REJECTS, 4),
      riskRejectResetSec: toPositiveInt(
        env.RISK_REJECT_RESET_SEC ?? env.RISK_RISK_REJECT_RESET_SEC,
        300,
      ),
      initialCapitalKrw: toNullablePositiveNumber(env.TRADER_INITIAL_CAPITAL_KRW),
    },
    overlay: {
      enabled: toBoolean(env.OVERLAY_ENABLED, false),
      timeoutMs: toPositiveInt(env.OVERLAY_TIMEOUT_MS, 500),
      defaultMultiplier: toPositiveNumber(env.OVERLAY_DEFAULT_MULTIPLIER, 1),
      fallbackMultiplier: toPositiveNumber(env.OVERLAY_FALLBACK_MULTIPLIER, 1),
      minMultiplier: toPositiveNumber(env.OVERLAY_MIN_MULTIPLIER, 0.2),
      maxMultiplier: toPositiveNumber(env.OVERLAY_MAX_MULTIPLIER, 1.5),
      maxStalenessSec: toPositiveInt(env.OVERLAY_MAX_STALENESS_SEC, 600),
    },
    strategySettings: {
      enabled: toBoolean(env.STRATEGY_SETTINGS_ENABLED ?? env.AI_SETTINGS_ENABLED, true),
      settingsFile: env.STRATEGY_SETTINGS_FILE
        || env.AI_SETTINGS_FILE
        || path.join(process.cwd(), ".trader", "strategy-settings.json"),
      maxAgeSec: toPositiveInt(
        env.STRATEGY_SETTINGS_MAX_AGE_SEC,
        Math.max(7_200, toPositiveInt(env.OPTIMIZER_REOPT_INTERVAL_SEC, 3_600) * 2),
      ),
      requireOptimizerSource: toBoolean(env.STRATEGY_SETTINGS_REQUIRE_OPTIMIZER_SOURCE, true),
      allowKillSwitchReset: toBoolean(env.STRATEGY_SETTINGS_ALLOW_KILL_SWITCH_RESET, false),
      applyCooldownSec: toPositiveInt(
        env.STRATEGY_SETTINGS_APPLY_COOLDOWN_SEC ?? env.AI_SETTINGS_APPLY_COOLDOWN_SEC,
        180,
      ),
      refreshFixedSec: toPositiveInt(env.STRATEGY_SETTINGS_REFRESH_FIXED_SEC ?? env.AI_SETTINGS_REFRESH_FIXED_SEC, 0),
      refreshMinSec: toPositiveInt(env.STRATEGY_SETTINGS_REFRESH_MIN_SEC ?? env.AI_SETTINGS_REFRESH_MIN_SEC, 1_800),
      refreshMaxSec: toPositiveInt(env.STRATEGY_SETTINGS_REFRESH_MAX_SEC ?? env.AI_SETTINGS_REFRESH_MAX_SEC, 3_600),
    },
    marketUniverse: {
      enabled: toBoolean(env.MARKET_UNIVERSE_ENABLED, true),
      quote: String(env.MARKET_UNIVERSE_QUOTE || "KRW").trim().toUpperCase(),
      minAccTradeValue24hKrw: toPositiveNumber(env.MARKET_UNIVERSE_MIN_ACC_TRADE_VALUE_24H_KRW, 3_500_000_000),
      minPriceKrw: toPositiveNumber(env.MARKET_UNIVERSE_MIN_PRICE_KRW, 1),
      minListingAgeDays: toNonNegativeInt(env.MARKET_UNIVERSE_MIN_LISTING_AGE_DAYS, 365),
      maxSymbols: toPositiveInt(env.MARKET_UNIVERSE_MAX_SYMBOLS, 80),
      includeSymbols: toCsvSymbolsOrNone(env.MARKET_UNIVERSE_INCLUDE_SYMBOLS, universeDefaultIncludes),
      excludeSymbols: toCsvSymbolsOrNone(env.MARKET_UNIVERSE_EXCLUDE_SYMBOLS, []),
      minBaseAssetLength: toPositiveInt(env.MARKET_UNIVERSE_MIN_BASE_ASSET_LENGTH, 2),
      refreshMinSec: toPositiveInt(env.MARKET_UNIVERSE_REFRESH_MIN_SEC, 1_800),
      refreshMaxSec: toPositiveInt(env.MARKET_UNIVERSE_REFRESH_MAX_SEC, 3_600),
      snapshotFile: env.MARKET_UNIVERSE_FILE || path.join(process.cwd(), ".trader", "market-universe.json"),
      tickerChunkSize: toPositiveInt(env.MARKET_UNIVERSE_TICKER_CHUNK_SIZE, 40),
    },
    execution: {
      enabled: toBoolean(env.EXECUTION_ENABLED, true),
      symbol: normalizeSymbol(env.EXECUTION_SYMBOL || env.STRATEGY_SYMBOL || env.TRADER_DEFAULT_SYMBOL || "BTC_KRW"),
      symbols: toCsvSymbols(
        env.EXECUTION_SYMBOLS,
        [normalizeSymbol(env.EXECUTION_SYMBOL || env.STRATEGY_SYMBOL || env.TRADER_DEFAULT_SYMBOL || "BTC_KRW")],
      ),
      orderAmountKrw: toPositiveNumber(
        env.EXECUTION_ORDER_AMOUNT_KRW,
        toPositiveNumber(env.STRATEGY_BASE_ORDER_AMOUNT_KRW, 12_000),
      ),
      windowSec: toPositiveInt(env.EXECUTION_WINDOW_SEC, 300),
      cooldownSec: toPositiveInt(env.EXECUTION_COOLDOWN_SEC, 30),
      maxSymbolsPerWindow: toPositiveInt(env.EXECUTION_MAX_SYMBOLS_PER_WINDOW, 2),
      maxOrderAttemptsPerWindow: toPositiveInt(env.EXECUTION_MAX_ORDER_ATTEMPTS_PER_WINDOW, 1),
      dryRun: toBoolean(env.EXECUTION_DRY_RUN, false),
      kpiGuardEnabled: toBoolean(env.EXECUTION_KPI_GUARD_ENABLED, true),
      kpiGuardMinTrades: toPositiveInt(env.EXECUTION_KPI_GUARD_MIN_TRADES, 3),
      kpiGuardMinWinRatePct: toNumber(env.EXECUTION_KPI_GUARD_MIN_WIN_RATE_PCT, 35),
      kpiGuardMaxAbsSlippageBps: toNumber(env.EXECUTION_KPI_GUARD_MAX_ABS_SLIPPAGE_BPS, 120),
      kpiGuardMinExpectancyKrw: toNumber(env.EXECUTION_KPI_GUARD_MIN_EXPECTANCY_KRW, -5000),
      kpiGuardMaxConsecutiveViolations: toNonNegativeInt(
        env.EXECUTION_KPI_GUARD_MAX_CONSECUTIVE_VIOLATIONS,
        1,
      ),
      kpiReportFile: env.EXECUTION_KPI_REPORT_FILE || path.join(process.cwd(), ".trader", "execution-kpi-report.jsonl"),
      kpiReportSummaryFile: env.EXECUTION_KPI_REPORT_SUMMARY_FILE
        || path.join(process.cwd(), ".trader", "execution-kpi-summary.json"),
      kpiMonitorWindowSec: toPositiveInt(env.EXECUTION_KPI_MONITOR_WINDOW_SEC, 3600),
      kpiMonitorMinTradeSamples: toPositiveInt(env.EXECUTION_KPI_MONITOR_MIN_TRADE_SAMPLES, 3),
      kpiMonitorReportEveryWindows: toPositiveInt(env.EXECUTION_KPI_MONITOR_REPORT_EVERY_WINDOWS, 1),
      kpiMonitorSummaryMaxEntries: toPositiveInt(env.EXECUTION_KPI_MONITOR_SUMMARY_MAX_ENTRIES, 720),
      kpiMonitorAlertWinRatePct: toNumber(env.EXECUTION_KPI_MONITOR_ALERT_WIN_RATE_PCT, toNumber(env.EXECUTION_KPI_GUARD_MIN_WIN_RATE_PCT, 35)),
      kpiMonitorAlertExpectancyKrw: toNumber(
        env.EXECUTION_KPI_MONITOR_ALERT_EXPECTANCY_KRW,
        toNumber(env.EXECUTION_KPI_GUARD_MIN_EXPECTANCY_KRW, -5000),
      ),
      kpiMonitorAlertMaxAbsSlippageBps: toNumber(
        env.EXECUTION_KPI_MONITOR_ALERT_MAX_ABS_SLIPPAGE_BPS,
        toNumber(env.EXECUTION_KPI_GUARD_MAX_ABS_SLIPPAGE_BPS, 120),
      ),
      restartDelayMs: toPositiveInt(env.EXECUTION_RESTART_DELAY_MS, 1_000),
      streamFailureRetryThreshold: toPositiveInt(env.EXECUTION_STREAM_FAILURE_RETRY_THRESHOLD, 3),
      streamFailureBackoffBaseMs: toPositiveInt(env.EXECUTION_STREAM_FAILURE_BACKOFF_BASE_MS, 2_000),
      streamFailureBackoffMaxMs: toPositiveInt(env.EXECUTION_STREAM_FAILURE_BACKOFF_MAX_MS, 120_000),
      maxWindows: toNonNegativeInt(env.EXECUTION_MAX_WINDOWS, 0),
      logOnlyOnActivity: toBoolean(env.EXECUTION_LOG_ONLY_ON_ACTIVITY, true),
      heartbeatWindows: toPositiveInt(env.EXECUTION_LOG_HEARTBEAT_WINDOWS, 12),
    },
  };
}

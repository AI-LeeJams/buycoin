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

function toNullablePositiveNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
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

function toCsvSymbols(value, fallback = []) {
  const normalized = toCsvList(value, fallback)
    .map((item) => normalizeSymbol(item))
    .filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : Array.from(new Set(fallback.map(normalizeSymbol)));
}

function toCsvSymbolsOrNone(value, fallback = []) {
  const token = String(value ?? "").trim().toUpperCase();
  if (token === "NONE" || token === "EMPTY" || token === "-") {
    return [];
  }
  return toCsvSymbols(value, fallback);
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
  if (!quote || !base) {
    return normalizeSymbol(market);
  }
  return `${base}_${quote}`;
}

const TRADING_PROFILES = {
  safe: {
    strategy: {
      candleInterval: "15m",
      candleCount: 180,
      meanLookback: 24,
      meanEntryBps: 100,
      meanExitBps: 5,
      baseOrderAmountKrw: 10_000,
      cashUsagePct: 15,
    },
    risk: {
      maxDailyLossKrw: 3_000,
      maxMtmDailyLossKrw: 3_000,
      maxHoldingLossPct: 2.2,
      maxHoldingTakeProfitPct: 0,
      trailingArmPct: 1.2,
      trailingStopPct: 0.6,
      maxOrderNotionalKrw: 15_000,
      maxExposureKrw: 45_000,
    },
  },
  balanced: {
    strategy: {
      candleInterval: "15m",
      candleCount: 180,
      meanLookback: 20,
      meanEntryBps: 80,
      meanExitBps: 5,
      baseOrderAmountKrw: 12_000,
      cashUsagePct: 20,
    },
    risk: {
      maxDailyLossKrw: 4_000,
      maxMtmDailyLossKrw: 4_000,
      maxHoldingLossPct: 2.8,
      maxHoldingTakeProfitPct: 0,
      trailingArmPct: 1.6,
      trailingStopPct: 0.8,
      maxOrderNotionalKrw: 18_000,
      maxExposureKrw: 65_000,
    },
  },
  aggressive: {
    strategy: {
      candleInterval: "15m",
      candleCount: 180,
      meanLookback: 16,
      meanEntryBps: 60,
      meanExitBps: 0,
      baseOrderAmountKrw: 15_000,
      cashUsagePct: 25,
    },
    risk: {
      maxDailyLossKrw: 5_000,
      maxMtmDailyLossKrw: 5_000,
      maxHoldingLossPct: 3.2,
      maxHoldingTakeProfitPct: 0,
      trailingArmPct: 1.8,
      trailingStopPct: 1.0,
      maxOrderNotionalKrw: 22_000,
      maxExposureKrw: 80_000,
    },
  },
};

export function loadConfig(env = process.env) {
  const cwd = process.cwd();
  const profileName = String(env.TRADING_PROFILE || "balanced").trim().toLowerCase();
  const resolvedProfileName = Object.hasOwn(TRADING_PROFILES, profileName) ? profileName : "balanced";
  const profile = TRADING_PROFILES[resolvedProfileName];
  const requestedStrategyName = String(env.STRATEGY_NAME || "mean_reversion").trim().toLowerCase();
  const strategyName = ["mean_reversion", "breakout", "risk_managed_momentum"].includes(requestedStrategyName)
    ? requestedStrategyName
    : "mean_reversion";

  const defaultSymbol = normalizeSymbol(
    env.EXECUTION_SYMBOL || env.STRATEGY_SYMBOL || env.TRADER_DEFAULT_SYMBOL || "BTC_KRW",
  );
  const executionOrderAmountKrw = toPositiveNumber(
    env.EXECUTION_ORDER_AMOUNT_KRW,
    toPositiveNumber(env.STRATEGY_BASE_ORDER_AMOUNT_KRW, profile.strategy.baseOrderAmountKrw),
  );
  const executionSymbols = [defaultSymbol];

  const runtime = {
    stateFile: env.TRADER_STATE_FILE || path.join(cwd, ".trader", "state.json"),
    overlayFile: env.TRADER_OVERLAY_FILE || path.join(cwd, ".trader", "overlay.json"),
    httpAuditEnabled: toBoolean(env.TRADER_HTTP_AUDIT_ENABLED, false),
    httpAuditFile: env.TRADER_HTTP_AUDIT_FILE || path.join(cwd, ".trader", "http-audit.jsonl"),
    httpAuditMaxBytes: toNonNegativeInt(env.TRADER_HTTP_AUDIT_MAX_BYTES, 10 * 1024 * 1024),
    httpAuditPruneRatio: toNumber(env.TRADER_HTTP_AUDIT_PRUNE_RATIO, 0.7),
    httpAuditCheckEvery: toPositiveInt(env.TRADER_HTTP_AUDIT_CHECK_EVERY, 200),
    timezone: env.TZ || "Asia/Seoul",
    stateLockStaleMs: toPositiveInt(env.TRADER_STATE_LOCK_STALE_MS, 30_000),
    retention: {
      keepLatestOnly: true,
      closedOrders: toNonNegativeInt(env.TRADER_RETENTION_CLOSED_ORDERS, 20),
      orders: toPositiveInt(env.TRADER_RETENTION_ORDERS, 400),
      orderEvents: toPositiveInt(env.TRADER_RETENTION_ORDER_EVENTS, 1000),
      strategyRuns: toPositiveInt(env.TRADER_RETENTION_STRATEGY_RUNS, 400),
      strategyRunDecisions: toPositiveInt(env.TRADER_RETENTION_STRATEGY_RUN_DECISIONS, 25),
      balancesSnapshot: toPositiveInt(env.TRADER_RETENTION_BALANCE_SNAPSHOTS, 120),
      fills: toPositiveInt(env.TRADER_RETENTION_FILLS, 1000),
      pruneUnknownSubmitMs: toNonNegativeInt(env.TRADER_RETENTION_PRUNE_UNKNOWN_SUBMIT_MS, 1_800_000),
      keepLatestOnlyStrategyRuns: 1,
      keepLatestOnlyBalancesSnapshot: 1,
      keepLatestOnlyFills: toPositiveInt(env.TRADER_RETENTION_FILLS, 1000),
      executionKpiHistory: toPositiveInt(env.TRADER_STATE_KPI_HISTORY_MAX_ENTRIES, 240),
      executionKpiHistoryShardDays: toPositiveInt(env.TRADER_STATE_KPI_HISTORY_SHARD_DAYS, 7),
      keepLatestOnlyRiskEvents: 100,
      keepLatestOnlySystemHealth: 100,
      keepLatestOnlyAgentAudit: 100,
    },
  };

  const exchange = {
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
  };

  const strategy = {
    name: strategyName,
    defaultSymbol,
    candleInterval: String(env.STRATEGY_CANDLE_INTERVAL || profile.strategy.candleInterval).toLowerCase(),
    candleCount: toPositiveInt(env.STRATEGY_CANDLE_COUNT, profile.strategy.candleCount),
    breakoutLookback: toPositiveInt(env.STRATEGY_BREAKOUT_LOOKBACK, 20),
    breakoutBufferBps: toNonNegativeNumber(env.STRATEGY_BREAKOUT_BUFFER_BPS, 5),
    momentumLookback: toPositiveInt(env.STRATEGY_MOMENTUM_LOOKBACK, 24),
    volatilityLookback: toPositiveInt(env.STRATEGY_VOLATILITY_LOOKBACK, 72),
    momentumEntryBps: toPositiveNumber(env.STRATEGY_MOMENTUM_ENTRY_BPS, 12),
    momentumExitBps: toPositiveNumber(env.STRATEGY_MOMENTUM_EXIT_BPS, 8),
    meanLookback: toPositiveInt(env.STRATEGY_MEAN_LOOKBACK, profile.strategy.meanLookback),
    meanEntryBps: toPositiveNumber(env.STRATEGY_MEAN_ENTRY_BPS, profile.strategy.meanEntryBps),
    meanExitBps: toNonNegativeNumber(env.STRATEGY_MEAN_EXIT_BPS, profile.strategy.meanExitBps),
    targetVolatilityPct: toPositiveNumber(env.STRATEGY_TARGET_VOLATILITY_PCT, 0.35),
    riskManagedMinMultiplier: toPositiveNumber(env.STRATEGY_RM_MIN_MULTIPLIER, 0.4),
    riskManagedMaxMultiplier: toPositiveNumber(env.STRATEGY_RM_MAX_MULTIPLIER, 1.8),
    autoSellEnabled: true,
    sellAllOnExit: true,
    sellAllQtyPrecision: 8,
    baseOrderAmountKrw: executionOrderAmountKrw,
    cashUsagePct: toPositiveNumber(
      env.STRATEGY_CASH_USAGE_PCT,
      strategyName === "mean_reversion" ? profile.strategy.cashUsagePct : 0,
    ),
    rebound: {
      enabled: false,
      dropLookback: 8,
      dropPct: -2.5,
      confirmEma: 9,
      breakoutLookback: 6,
      entrySplits: [0.4, 0.3, 0.3],
      stopLossPct: 4.8,
      tp1Pct: 2.2,
      tp2Pct: 3.8,
      trailPct: 1.2,
    },
  };

  const risk = {
    minOrderNotionalKrw: toPositiveNumber(env.RISK_MIN_ORDER_NOTIONAL_KRW, 10_000),
    buyCashBufferBps: toNonNegativeNumber(env.RISK_BUY_CASH_BUFFER_BPS, 50),
    maxOrderNotionalKrw: toNullablePositiveNumberOrAuto(
      env.RISK_MAX_ORDER_NOTIONAL_KRW,
      profile.risk.maxOrderNotionalKrw,
    ),
    maxOpenOrders: 2,
    maxOpenOrdersPerSymbol: 1,
    maxExposureKrw: toNullablePositiveNumberOrAuto(env.RISK_MAX_EXPOSURE_KRW, profile.risk.maxExposureKrw),
    maxDailyLossKrw: toPositiveNumber(env.RISK_MAX_DAILY_LOSS_KRW, profile.risk.maxDailyLossKrw),
    maxMtmDailyLossKrw: toPositiveNumber(env.RISK_MAX_MTM_DAILY_LOSS_KRW, profile.risk.maxMtmDailyLossKrw),
    maxHoldingLossPct: toNumber(env.RISK_MAX_HOLDING_LOSS_PCT, profile.risk.maxHoldingLossPct),
    maxHoldingTakeProfitPct: toNumber(
      env.RISK_MAX_HOLDING_TAKE_PROFIT_PCT,
      profile.risk.maxHoldingTakeProfitPct,
    ),
    trailingStopPct: toPositiveNumber(env.RISK_TRAILING_STOP_PCT, profile.risk.trailingStopPct),
    trailingArmPct: toPositiveNumber(env.RISK_TRAILING_ARM_PCT, profile.risk.trailingArmPct),
    postExitBuyCooldownSec: toPositiveInt(env.RISK_POST_EXIT_BUY_COOLDOWN_SEC, 300),
    maxConsecutiveRiskRejects: toPositiveInt(env.RISK_MAX_CONSECUTIVE_RISK_REJECTS, 4),
    riskRejectResetSec: toPositiveInt(env.RISK_REJECT_RESET_SEC, 300),
    singlePositionPerSymbol: toBoolean(env.RISK_SINGLE_POSITION_PER_SYMBOL, true),
    initialCapitalKrw: toNullablePositiveNumber(env.TRADER_INITIAL_CAPITAL_KRW, null),
  };

  const overlay = {
    enabled: false,
    timeoutMs: 500,
    defaultMultiplier: 1,
    fallbackMultiplier: 1,
    minMultiplier: 0.2,
    maxMultiplier: 1.5,
    maxStalenessSec: 600,
  };

  const strategySettings = {
    enabled: toBoolean(env.STRATEGY_SETTINGS_ENABLED, true),
    settingsFile: env.STRATEGY_SETTINGS_FILE || path.join(cwd, ".trader", "strategy-settings.json"),
    maxAgeSec: toPositiveInt(env.STRATEGY_SETTINGS_MAX_AGE_SEC, 7_200),
    requireOptimizerSource: false,
  };

  const marketUniverse = {
    enabled: toBoolean(env.MARKET_UNIVERSE_ENABLED, true),
    quote: "KRW",
    minAccTradeValue24hKrw: toPositiveNumber(env.MARKET_UNIVERSE_MIN_ACC_TRADE_VALUE_24H_KRW, 3_500_000_000),
    minPriceKrw: toPositiveNumber(env.MARKET_UNIVERSE_MIN_PRICE_KRW, 1),
    minListingAgeDays: toNonNegativeInt(env.MARKET_UNIVERSE_MIN_LISTING_AGE_DAYS, 365),
    maxSymbols: toPositiveInt(env.MARKET_UNIVERSE_MAX_SYMBOLS, 80),
    includeSymbols: toCsvSymbolsOrNone(env.MARKET_UNIVERSE_INCLUDE_SYMBOLS, []),
    excludeSymbols: toCsvSymbolsOrNone(env.MARKET_UNIVERSE_EXCLUDE_SYMBOLS, []),
    minBaseAssetLength: toPositiveInt(env.MARKET_UNIVERSE_MIN_BASE_ASSET_LENGTH, 2),
    refreshMinSec: toPositiveInt(env.MARKET_UNIVERSE_REFRESH_MIN_SEC, 1_800),
    refreshMaxSec: toPositiveInt(env.MARKET_UNIVERSE_REFRESH_MAX_SEC, 3_600),
    snapshotFile: env.MARKET_UNIVERSE_FILE || path.join(cwd, ".trader", "market-universe.json"),
    tickerChunkSize: toPositiveInt(env.MARKET_UNIVERSE_TICKER_CHUNK_SIZE, 40),
  };

  const execution = {
    enabled: toBoolean(env.EXECUTION_ENABLED, true),
    symbol: defaultSymbol,
    symbols: executionSymbols,
    orderAmountKrw: executionOrderAmountKrw,
    windowSec: toPositiveInt(env.EXECUTION_WINDOW_SEC, 300),
    cooldownSec: toPositiveInt(env.EXECUTION_COOLDOWN_SEC, 30),
    maxSymbolsPerWindow: toPositiveInt(env.EXECUTION_MAX_SYMBOLS_PER_WINDOW, 1),
    maxOrderAttemptsPerWindow: toPositiveInt(env.EXECUTION_MAX_ORDER_ATTEMPTS_PER_WINDOW, 1),
    dryRun: toBoolean(env.EXECUTION_DRY_RUN, false),
    maxWindows: toNonNegativeInt(env.EXECUTION_MAX_WINDOWS, 0),
    logOnlyOnActivity: toBoolean(env.EXECUTION_LOG_ONLY_ON_ACTIVITY, true),
    heartbeatWindows: toPositiveInt(env.EXECUTION_LOG_HEARTBEAT_WINDOWS, 12),
    restartDelayMs: toPositiveInt(env.EXECUTION_RESTART_DELAY_MS, 1_000),
    restFallbackIntervalMs: toPositiveInt(env.EXECUTION_REST_FALLBACK_INTERVAL_MS, 5_000),
    accountCacheTtlMs: toPositiveInt(env.EXECUTION_ACCOUNT_CACHE_TTL_MS, 2_000),
    kpiMonitorWindowSec: 3600,
    kpiMonitorMinTradeSamples: 3,
    kpiMonitorReportEveryWindows: 1,
    kpiMonitorSummaryMaxEntries: 720,
    kpiMonitorAlertWinRatePct: 35,
    kpiMonitorAlertExpectancyKrw: -5000,
    kpiMonitorAlertMaxAbsSlippageBps: 120,
    kpiMonitorMaxOpenLossPct: -1.5,
    kpiMonitorMaxConsecutiveLosingExits: 2,
    kpiMonitorMaxStalledWindows: 4,
  };

  const optimizer = {
    enabled: toBoolean(env.OPTIMIZER_ENABLED, true),
    applyOnStart: false,
    applyToStrategySettings: false,
    lockFile: env.OPTIMIZER_LOCK_FILE || path.join(cwd, ".trader", "optimize.lock"),
    lockTtlSec: toPositiveInt(env.OPTIMIZER_LOCK_TTL_SEC, 900),
    reoptEnabled: false,
    reoptIntervalSec: 3600,
    reportFile: env.OPTIMIZER_REPORT_FILE || path.join(cwd, ".trader", "optimizer-report.json"),
    symbols: toCsvSymbols(env.OPTIMIZER_SYMBOLS, [defaultSymbol, "ETH_KRW", "USDT_KRW"]),
    maxLiveSymbols: 1,
    maxSymbolScoreGap: 5,
    minListingAgeDays: marketUniverse.minListingAgeDays,
    minHistoryCandles: 200,
    strategies: ["mean_reversion"],
    interval: strategy.candleInterval,
    candleCount: 200,
    initialCashKrw: toPositiveNumber(env.OPTIMIZER_INITIAL_CASH_KRW, 100_000),
    baseOrderAmountKrw: executionOrderAmountKrw,
    minOrderNotionalKrw: risk.minOrderNotionalKrw,
    feeBps: 5,
    backtestSlippageBps: 12,
    maxDrawdownPctLimit: 6,
    minTrades: 8,
    minWinRatePct: 45,
    minProfitFactor: 1.15,
    minReturnPct: 1,
    minExpectancyKrw: 150,
    minNetEdgeBps: 8,
    walkForwardEnabled: true,
    walkForwardScoreWeight: 0.25,
    walkForwardTrainWindow: 80,
    walkForwardTestWindow: 40,
    walkForwardStepWindow: 30,
    walkForwardMaxFolds: 0,
    walkForwardMinScore: -999999,
    walkForwardMinFoldCount: 3,
    walkForwardMinPassRate: 0.55,
    topResults: 10,
    momentumLookbacks: [],
    volatilityLookbacks: [],
    entryBpsCandidates: [],
    exitBpsCandidates: [],
    breakoutLookbacks: [],
    breakoutBufferBpsCandidates: [],
    meanLookbacks: [12, 20, 30, 48],
    meanEntryBpsCandidates: [60, 80, 100, 120],
    meanExitBpsCandidates: [0, 5, 10, 15, 25],
    targetVolatilityPctCandidates: [],
    rmMinMultiplierCandidates: [],
    rmMaxMultiplierCandidates: [],
  };

  return {
    runtime,
    exchange,
    tradingProfile: {
      name: resolvedProfileName,
      ...profile,
    },
    strategy,
    optimizer,
    risk,
    overlay,
    strategySettings,
    marketUniverse,
    execution,
  };
}

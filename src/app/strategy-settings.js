import fs from "node:fs/promises";
import path from "node:path";
import { normalizeSymbol } from "../config/defaults.js";
import { nowIso } from "../lib/time.js";

const ALLOWED_STRATEGY_NAMES = new Set(["risk_managed_momentum", "breakout", "mean_reversion"]);
const ALLOWED_INTERVALS = new Set([
  "1m",
  "3m",
  "5m",
  "10m",
  "15m",
  "30m",
  "60m",
  "240m",
  "day",
  "week",
  "month",
]);

const STRATEGY_SAFE_RANGES = {
  momentumLookback: { min: 12, max: 72 },
  volatilityLookback: { min: 48, max: 144 },
  momentumEntryBps: { min: 6, max: 24 },
  momentumExitBps: { min: 4, max: 20 },
  meanLookback: { min: 8, max: 72 },
  meanEntryBps: { min: 20, max: 240 },
  meanExitBps: { min: 0, max: 120 },
  targetVolatilityPct: { min: 0.3, max: 1.2 },
  riskManagedMinMultiplier: { min: 0.4, max: 1.0 },
  riskManagedMaxMultiplier: { min: 1.2, max: 2.5 },
  cashUsagePct: { min: 1, max: 100 },
};

function clampRange(value, min, max, fallback, label, logger = null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (!Number.isFinite(min) && !Number.isFinite(max)) {
    return value;
  }
  let clamped = value;
  if (Number.isFinite(min)) {
    clamped = Math.max(clamped, min);
  }
  if (Number.isFinite(max)) {
    clamped = Math.min(clamped, max);
  }
  if (clamped !== value && logger) {
    logger.warn("strategy settings: value clamped", {
      field: label,
      received: value,
      clamped,
      min,
      max,
    });
  }
  return clamped;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const token = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(token)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(token)) {
    return false;
  }
  return fallback;
}

function toPositiveNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function toNonNegativeNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function toPositiveInt(value, fallback) {
  const parsed = toPositiveNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function toNonNegativeInt(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizeStrategyName(value, fallback) {
  const token = String(value || fallback || "risk_managed_momentum")
    .trim()
    .toLowerCase();
  return ALLOWED_STRATEGY_NAMES.has(token) ? token : fallback;
}

function normalizeInterval(value, fallback) {
  const token = String(value || fallback || "15m").trim().toLowerCase();
  return ALLOWED_INTERVALS.has(token) ? token : fallback;
}

function toSymbolArray(value, fallback = []) {
  const base = Array.isArray(fallback) ? fallback : [];
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : base;

  const normalized = raw
    .map((item) => normalizeSymbol(String(item || "").trim()))
    .filter(Boolean);

  const unique = Array.from(new Set(normalized));
  if (unique.length > 0) {
    return unique;
  }
  return base.length > 0 ? Array.from(new Set(base.map((item) => normalizeSymbol(item)).filter(Boolean))) : [];
}

function normalizeRuntimeMeta(raw = {}) {
  const meta = raw && typeof raw === "object" ? raw : null;
  if (!meta) {
    return null;
  }

  const source = typeof meta.source === "string" && meta.source.trim() !== ""
    ? String(meta.source).trim()
    : null;
  const runId = meta.runId !== undefined && meta.runId !== null ? String(meta.runId) : null;
  const version = typeof meta.version === "string" && meta.version.trim() !== ""
    ? String(meta.version).trim()
    : null;

  if (source === null && runId === null && version === null) {
    return null;
  }

  return {
    source,
    runId,
    version,
  };
}

function normalizeKillSwitch(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return toBoolean(value, null);
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJsonAtomic(filePath, payload) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempFile = path.join(
    dir,
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await fs.writeFile(tempFile, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tempFile, filePath);
}

async function readJsonWithWriteStabilityGuard(filePath) {
  const attempts = 3;
  const delayMs = 60;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let beforeStat;
    try {
      beforeStat = await fs.stat(filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }
      if (attempt >= attempts) {
        throw error;
      }
      await sleep(delayMs);
      continue;
    }

    let rawText;
    try {
      rawText = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }
      if (attempt >= attempts) {
        throw error;
      }
      await sleep(delayMs);
      continue;
    }

    let afterStat;
    try {
      afterStat = await fs.stat(filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }
      if (attempt >= attempts) {
        throw error;
      }
      await sleep(delayMs);
      continue;
    }

    if (beforeStat.size !== afterStat.size || beforeStat.mtimeMs !== afterStat.mtimeMs) {
      if (attempt >= attempts) {
        return {};
      }
      await sleep(delayMs);
      continue;
    }

    const trimmed = rawText.trim();
    if (!trimmed) {
      return {};
    }
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }
      await sleep(delayMs);
    }
  }

  return {};
}

export class StrategySettingsSource {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger || {
      info() {},
      warn() {},
    };

    this.enabled = config.strategySettings?.enabled === undefined
      ? true
      : Boolean(config.strategySettings.enabled);
    this.settingsFile = config.strategySettings?.settingsFile
      || path.join(process.cwd(), ".trader", "strategy-settings.json");
    this.maxAgeSec = toPositiveInt(config.strategySettings?.maxAgeSec, 7_200);
    this.requireOptimizerSource = config.strategySettings?.requireOptimizerSource !== false;
    this.lastError = null;
  }

  defaultExecution(executionEnabled = null) {
    const defaultSymbol = normalizeSymbol(this.config.execution.symbol);
    const configuredSymbols = toSymbolArray(this.config.execution.symbols, [defaultSymbol]);
    const symbols = configuredSymbols.length > 0 ? configuredSymbols : [defaultSymbol];
    return {
      enabled: executionEnabled === null ? Boolean(this.config.execution.enabled) : Boolean(executionEnabled),
      symbol: symbols[0],
      symbols,
      orderAmountKrw: this.config.execution.orderAmountKrw,
      windowSec: this.config.execution.windowSec,
      cooldownSec: this.config.execution.cooldownSec,
      maxSymbolsPerWindow: toPositiveInt(this.config.execution.maxSymbolsPerWindow, 1),
      maxOrderAttemptsPerWindow: toPositiveInt(this.config.execution.maxOrderAttemptsPerWindow, 1),
    };
  }

  defaultStrategy() {
    const base = this.config?.strategy || {};
    return {
      name: normalizeStrategyName(base.name, "risk_managed_momentum"),
      defaultSymbol: normalizeSymbol(base.defaultSymbol || this.config?.execution?.symbol || "BTC_KRW"),
      candleInterval: normalizeInterval(base.candleInterval, "15m"),
      candleCount: toPositiveInt(base.candleCount, 120),
      breakoutLookback: toPositiveInt(base.breakoutLookback, 20),
      breakoutBufferBps: toPositiveNumber(base.breakoutBufferBps, 5),
      momentumLookback: toPositiveInt(base.momentumLookback, 24),
      volatilityLookback: toPositiveInt(base.volatilityLookback, 72),
      momentumEntryBps: toPositiveNumber(base.momentumEntryBps, 12),
      momentumExitBps: toPositiveNumber(base.momentumExitBps, 8),
      meanLookback: toPositiveInt(base.meanLookback ?? base.meanReversionLookback, 20),
      meanEntryBps: toPositiveNumber(base.meanEntryBps ?? base.meanReversionEntryBps, 60),
      meanExitBps: toNonNegativeNumber(base.meanExitBps ?? base.meanReversionExitBps, 10),
      targetVolatilityPct: toPositiveNumber(base.targetVolatilityPct, 0.6),
      riskManagedMinMultiplier: toPositiveNumber(base.riskManagedMinMultiplier, 0.6),
      riskManagedMaxMultiplier: toPositiveNumber(base.riskManagedMaxMultiplier, 2.2),
      autoSellEnabled: toBoolean(base.autoSellEnabled, true),
      sellAllOnExit: toBoolean(base.sellAllOnExit, true),
      sellAllQtyPrecision: toPositiveInt(base.sellAllQtyPrecision, 8),
      baseOrderAmountKrw: toPositiveNumber(base.baseOrderAmountKrw, 20_000),
      cashUsagePct: toPositiveNumber(base.cashUsagePct, 0),
    };
  }

  defaultControls() {
    return {
      killSwitch: null,
    };
  }

  defaultSnapshot(source = "defaults", executionEnabled = null) {
    const defaultEnabled = source === "disabled"
      ? Boolean(this.config.execution.enabled)
      : false;
    return {
      source,
      loadedAt: nowIso(),
      meta: null,
      execution: this.defaultExecution(executionEnabled === null ? defaultEnabled : executionEnabled),
      strategy: this.defaultStrategy(),
      controls: this.defaultControls(),
    };
  }

  defaultTemplate() {
    return {
      version: 1,
      updatedAt: nowIso(),
      meta: {
        source: "template",
        version: "strategy-settings/v1",
      },
      execution: this.defaultExecution(false),
      strategy: this.defaultStrategy(),
      controls: this.defaultControls(),
    };
  }

  async init() {
    if (!this.enabled || !this.settingsFile) {
      return;
    }

    await fs.mkdir(path.dirname(this.settingsFile), { recursive: true });
    try {
      await fs.access(this.settingsFile);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      const template = this.defaultTemplate();
      await writeJsonAtomic(this.settingsFile, template);
      this.logger.info("strategy settings template created", {
        file: this.settingsFile,
      });
    }
  }

  validateContract(raw = {}) {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
    if (!source) {
      return { ok: false, reason: "invalid_root_payload" };
    }

    if (source.version !== undefined && source.version !== 1 && source.version !== "1") {
      return { ok: false, reason: "invalid_version" };
    }

    if (source.updatedAt !== undefined && parseTimestamp(source.updatedAt) === null) {
      return { ok: false, reason: "invalid_updated_at" };
    }

    if (this.requireOptimizerSource) {
      const metaSource = typeof source?.meta?.source === "string"
        ? String(source.meta.source).trim()
        : null;
      if (metaSource !== "optimizer") {
        return { ok: false, reason: "missing_optimizer_source" };
      }
    }

    return { ok: true, reason: null };
  }

  isStale(raw = {}) {
    if (!Number.isFinite(this.maxAgeSec) || this.maxAgeSec <= 0) {
      return false;
    }
    const updatedAt = parseTimestamp(raw.updatedAt)
      ?? parseTimestamp(raw?.meta?.updatedAt)
      ?? parseTimestamp(raw?.meta?.approvedAt);
    if (!Number.isFinite(updatedAt)) {
      return true;
    }
    return Date.now() - updatedAt > this.maxAgeSec * 1_000;
  }

  normalize(raw = {}) {
    const meta = normalizeRuntimeMeta(raw.meta);
    const optimizerManaged = meta?.source === "optimizer";
    const executionRaw = raw.execution || {};
    const defaults = this.defaultExecution();
    const strategyRaw = raw.strategy || {};
    const strategyDefaults = this.defaultStrategy();

    const execution = {
      enabled: toBoolean(executionRaw.enabled, defaults.enabled),
      symbol: normalizeSymbol(executionRaw.symbol || defaults.symbol),
      symbols: [],
      orderAmountKrw: toPositiveNumber(executionRaw.orderAmountKrw, defaults.orderAmountKrw),
      windowSec: toPositiveInt(executionRaw.windowSec, defaults.windowSec),
      cooldownSec: toNonNegativeInt(executionRaw.cooldownSec, defaults.cooldownSec),
      maxSymbolsPerWindow: toPositiveInt(executionRaw.maxSymbolsPerWindow, defaults.maxSymbolsPerWindow),
      maxOrderAttemptsPerWindow: toPositiveInt(executionRaw.maxOrderAttemptsPerWindow, defaults.maxOrderAttemptsPerWindow),
    };

    const riskMinOrder = toPositiveNumber(this.config?.risk?.minOrderNotionalKrw, 20_000);
    const riskMaxOrder = toPositiveNumber(this.config?.risk?.maxOrderNotionalKrw, null);
    execution.orderAmountKrw = clampRange(
      execution.orderAmountKrw,
      riskMinOrder,
      riskMaxOrder,
      execution.orderAmountKrw,
      "execution.orderAmountKrw",
      this.logger,
    );
    execution.windowSec = clampRange(
      execution.windowSec,
      5,
      86_400,
      execution.windowSec,
      "execution.windowSec",
      this.logger,
    );
    execution.cooldownSec = clampRange(
      execution.cooldownSec,
      0,
      600,
      execution.cooldownSec,
      "execution.cooldownSec",
      this.logger,
    );
    execution.maxSymbolsPerWindow = clampRange(
      execution.maxSymbolsPerWindow,
      1,
      20,
      execution.maxSymbolsPerWindow,
      "execution.maxSymbolsPerWindow",
      this.logger,
    );
    execution.maxOrderAttemptsPerWindow = clampRange(
      execution.maxOrderAttemptsPerWindow,
      1,
      20,
      execution.maxOrderAttemptsPerWindow,
      "execution.maxOrderAttemptsPerWindow",
      this.logger,
    );

    const hasExplicitSymbol = executionRaw.symbol !== undefined
      && executionRaw.symbol !== null
      && String(executionRaw.symbol).trim() !== "";
    const explicitSymbol = hasExplicitSymbol ? normalizeSymbol(executionRaw.symbol) : null;
    const symbolFallback = explicitSymbol ? [explicitSymbol] : defaults.symbols || [execution.symbol];
    const symbols = toSymbolArray(executionRaw.symbols, symbolFallback);
    if (hasExplicitSymbol && explicitSymbol && !symbols.includes(explicitSymbol)) {
      symbols.unshift(explicitSymbol);
    }
    execution.symbols = symbols.length > 0 ? symbols : [execution.symbol];
    execution.symbol = hasExplicitSymbol && explicitSymbol ? explicitSymbol : execution.symbols[0];

    const strategy = {
      name: normalizeStrategyName(strategyRaw.name, strategyDefaults.name),
      defaultSymbol: normalizeSymbol(strategyRaw.defaultSymbol || execution.symbol || strategyDefaults.defaultSymbol),
      candleInterval: normalizeInterval(strategyRaw.candleInterval, strategyDefaults.candleInterval),
      candleCount: toPositiveInt(strategyRaw.candleCount, strategyDefaults.candleCount),
      breakoutLookback: toPositiveInt(strategyRaw.breakoutLookback, strategyDefaults.breakoutLookback),
      breakoutBufferBps: toPositiveNumber(strategyRaw.breakoutBufferBps, strategyDefaults.breakoutBufferBps),
      momentumLookback: toPositiveInt(strategyRaw.momentumLookback, strategyDefaults.momentumLookback),
      volatilityLookback: toPositiveInt(strategyRaw.volatilityLookback, strategyDefaults.volatilityLookback),
      momentumEntryBps: toPositiveNumber(strategyRaw.momentumEntryBps, strategyDefaults.momentumEntryBps),
      momentumExitBps: toPositiveNumber(strategyRaw.momentumExitBps, strategyDefaults.momentumExitBps),
      meanLookback: toPositiveInt(strategyRaw.meanLookback ?? strategyRaw.meanReversionLookback, strategyDefaults.meanLookback),
      meanEntryBps: toPositiveNumber(strategyRaw.meanEntryBps ?? strategyRaw.meanReversionEntryBps, strategyDefaults.meanEntryBps),
      meanExitBps: toNonNegativeNumber(
        strategyRaw.meanExitBps ?? strategyRaw.meanReversionExitBps,
        strategyDefaults.meanExitBps,
      ),
      targetVolatilityPct: toPositiveNumber(strategyRaw.targetVolatilityPct, strategyDefaults.targetVolatilityPct),
      riskManagedMinMultiplier: toPositiveNumber(
        strategyRaw.riskManagedMinMultiplier,
        strategyDefaults.riskManagedMinMultiplier,
      ),
      riskManagedMaxMultiplier: toPositiveNumber(
        strategyRaw.riskManagedMaxMultiplier,
        strategyDefaults.riskManagedMaxMultiplier,
      ),
      autoSellEnabled: toBoolean(strategyRaw.autoSellEnabled, strategyDefaults.autoSellEnabled),
      sellAllOnExit: toBoolean(strategyRaw.sellAllOnExit, strategyDefaults.sellAllOnExit),
      sellAllQtyPrecision: toPositiveInt(strategyRaw.sellAllQtyPrecision, strategyDefaults.sellAllQtyPrecision),
      baseOrderAmountKrw: toPositiveNumber(strategyRaw.baseOrderAmountKrw, strategyDefaults.baseOrderAmountKrw),
      cashUsagePct: toPositiveNumber(strategyRaw.cashUsagePct, strategyDefaults.cashUsagePct),
    };

    if (optimizerManaged) {
      const targetConcurrentSymbols = Math.max(
        1,
        Math.min(
          execution.symbols.length || 1,
          toPositiveInt(execution.maxSymbolsPerWindow, execution.symbols.length || 1),
        ),
      );

      if (targetConcurrentSymbols > 1) {
        const diversifiedCashUsagePct = Math.max(1, Math.floor(100 / targetConcurrentSymbols));
        const nextAttempts = Math.max(
          toPositiveInt(execution.maxOrderAttemptsPerWindow, 1),
          targetConcurrentSymbols,
        );

        if (execution.maxOrderAttemptsPerWindow !== nextAttempts) {
          this.logger.warn("strategy settings: optimizer snapshot raised order attempts for multi-symbol execution", {
            symbols: execution.symbols,
            previous: execution.maxOrderAttemptsPerWindow,
            adjusted: nextAttempts,
            targetConcurrentSymbols,
          });
          execution.maxOrderAttemptsPerWindow = nextAttempts;
        }

        if (strategy.cashUsagePct > diversifiedCashUsagePct) {
          this.logger.warn("strategy settings: optimizer snapshot capped cash usage for multi-symbol diversification", {
            symbols: execution.symbols,
            previous: strategy.cashUsagePct,
            adjusted: diversifiedCashUsagePct,
            targetConcurrentSymbols,
          });
          strategy.cashUsagePct = diversifiedCashUsagePct;
        }
      }
    }

    for (const [field, range] of Object.entries(STRATEGY_SAFE_RANGES)) {
      const value = strategy[field];
      if (typeof value !== "number") {
        continue;
      }
      const clamped = Math.max(range.min, Math.min(range.max, value));
      if (clamped !== value) {
        this.logger.warn("strategy settings: strategy parameter out of safe range, clamping", {
          field,
          received: value,
          clamped,
          safeMin: range.min,
          safeMax: range.max,
        });
        strategy[field] = clamped;
      }
    }

    const controls = {
      killSwitch: normalizeKillSwitch(raw?.controls?.killSwitch),
    };

    return {
      source: "strategy_settings_file",
      loadedAt: nowIso(),
      meta,
      execution,
      strategy,
      controls,
    };
  }

  async read() {
    if (!this.enabled || !this.settingsFile) {
      return this.defaultSnapshot("disabled");
    }

    try {
      const parsed = await readJsonWithWriteStabilityGuard(this.settingsFile);
      const contract = this.validateContract(parsed);
      if (!contract.ok) {
        if (this.lastError !== contract.reason) {
          this.lastError = contract.reason;
          this.logger.warn("invalid strategy settings snapshot; fallback to defaults", {
            file: this.settingsFile,
            reason: contract.reason,
          });
        }
        return this.defaultSnapshot("invalid_contract_fallback");
      }
      if (this.isStale(parsed)) {
        if (this.lastError !== "stale_snapshot") {
          this.lastError = "stale_snapshot";
          this.logger.warn("stale strategy settings snapshot; fallback to defaults", {
            file: this.settingsFile,
            maxAgeSec: this.maxAgeSec,
          });
        }
        return this.defaultSnapshot("stale_snapshot_fallback");
      }
      this.lastError = null;
      return this.normalize(parsed);
    } catch (error) {
      if (this.lastError !== error.message) {
        this.lastError = error.message;
        this.logger.warn("failed to read strategy settings; fallback to defaults", {
          file: this.settingsFile,
          reason: error.message,
        });
      }
      return this.defaultSnapshot("read_error_fallback");
    }
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import { normalizeSymbol } from "../config/defaults.js";
import { nowIso } from "../lib/time.js";

function toBoolean(value, fallback = null) {
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
  return normalized.length > 0 ? Array.from(new Set(normalized)) : base;
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

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export class StrategySettingsSource {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger || { info() {}, warn() {} };
    this.enabled = config.strategySettings?.enabled !== false;
    this.settingsFile = config.strategySettings?.settingsFile
      || path.join(process.cwd(), ".trader", "strategy-settings.json");
    this.maxAgeSec = toNonNegativeInt(config.strategySettings?.maxAgeSec, 0);
    this.allowSymbolOverride = config.strategySettings?.allowSymbolOverride === true;
    this.lastError = null;
    this.lastStaleWarningKey = null;
  }

  defaultExecution() {
    const symbol = normalizeSymbol(this.config.execution?.symbol || this.config.strategy?.defaultSymbol || "BTC_KRW");
    return {
      enabled: Boolean(this.config.execution?.enabled),
      symbol,
      symbols: [symbol],
      orderAmountKrw: this.config.execution?.orderAmountKrw,
      windowSec: this.config.execution?.windowSec,
      cooldownSec: this.config.execution?.cooldownSec,
      maxSymbolsPerWindow: 1,
      maxOrderAttemptsPerWindow: 1,
    };
  }

  defaultStrategy() {
    return {
      name: "mean_reversion",
      defaultSymbol: normalizeSymbol(this.config.strategy?.defaultSymbol || this.config.execution?.symbol || "BTC_KRW"),
      candleInterval: this.config.strategy?.candleInterval || "15m",
      candleCount: this.config.strategy?.candleCount || 180,
      meanLookback: this.config.strategy?.meanLookback || 20,
      meanEntryBps: this.config.strategy?.meanEntryBps || 60,
      meanExitBps: this.config.strategy?.meanExitBps || 10,
      autoSellEnabled: this.config.strategy?.autoSellEnabled !== false,
      sellAllOnExit: this.config.strategy?.sellAllOnExit !== false,
      sellAllQtyPrecision: this.config.strategy?.sellAllQtyPrecision || 8,
      baseOrderAmountKrw: this.config.strategy?.baseOrderAmountKrw || this.config.execution?.orderAmountKrw || 12_000,
      cashUsagePct: this.config.strategy?.cashUsagePct || 20,
    };
  }

  defaultControls() {
    return {
      pauseEntries: null,
    };
  }

  defaultSnapshot(source = "defaults") {
    return {
      source,
      loadedAt: nowIso(),
      meta: null,
      execution: this.defaultExecution(),
      strategy: this.defaultStrategy(),
      controls: this.defaultControls(),
    };
  }

  defaultTemplate() {
    return {
      version: 1,
      updatedAt: nowIso(),
      meta: {
        source: "operator",
        version: "strategy-settings/v2",
      },
      execution: {
        enabled: this.config.execution?.enabled !== false,
        symbol: this.config.execution?.symbol || "BTC_KRW",
        orderAmountKrw: this.config.execution?.orderAmountKrw || 12_000,
      },
      controls: {
        pauseEntries: null,
      },
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
      await writeJsonAtomic(this.settingsFile, this.defaultTemplate());
      this.logger.info("strategy settings template created", {
        file: this.settingsFile,
      });
    }
  }

  isStale(raw = {}) {
    if (!Number.isFinite(this.maxAgeSec) || this.maxAgeSec <= 0) {
      return false;
    }
    const updatedAt = parseTimestamp(raw.updatedAt) ?? parseTimestamp(raw?.meta?.updatedAt);
    if (!Number.isFinite(updatedAt)) {
      return false;
    }
    return Date.now() - updatedAt > this.maxAgeSec * 1_000;
  }

  normalize(raw = {}) {
    const defaults = this.defaultSnapshot("settings_file");
    const executionRaw = raw?.execution && typeof raw.execution === "object" ? raw.execution : {};
    const controlsRaw = raw?.controls && typeof raw.controls === "object" ? raw.controls : {};

    const explicitSymbol = this.allowSymbolOverride && executionRaw.symbol ? normalizeSymbol(executionRaw.symbol) : null;
    const symbols = this.allowSymbolOverride
      ? toSymbolArray(executionRaw.symbols, explicitSymbol ? [explicitSymbol] : defaults.execution.symbols)
      : defaults.execution.symbols;
    const symbol = explicitSymbol || symbols[0] || defaults.execution.symbol;

    return {
      source: "settings_file",
      loadedAt: nowIso(),
      meta: raw?.meta && typeof raw.meta === "object" ? raw.meta : null,
      execution: {
        enabled: toBoolean(executionRaw.enabled, defaults.execution.enabled),
        symbol,
        symbols: [symbol],
        orderAmountKrw: toPositiveNumber(executionRaw.orderAmountKrw, defaults.execution.orderAmountKrw),
        windowSec: toPositiveInt(executionRaw.windowSec, defaults.execution.windowSec),
        cooldownSec: toNonNegativeInt(executionRaw.cooldownSec, defaults.execution.cooldownSec),
        maxSymbolsPerWindow: 1,
        maxOrderAttemptsPerWindow: 1,
      },
      strategy: defaults.strategy,
      controls: {
        pauseEntries: toBoolean(controlsRaw.pauseEntries ?? controlsRaw.killSwitch, null),
      },
    };
  }

  async read() {
    if (!this.enabled || !this.settingsFile) {
      return this.defaultSnapshot("disabled");
    }

    try {
      const parsed = await readJson(this.settingsFile);
      if (this.isStale(parsed)) {
        const warningKey = `${parsed?.updatedAt || parsed?.meta?.updatedAt || "unknown"}:${this.maxAgeSec}`;
        if (this.lastStaleWarningKey !== warningKey) {
          this.lastStaleWarningKey = warningKey;
          this.logger.warn("strategy settings snapshot is stale; fallback to runtime defaults", {
            file: this.settingsFile,
            updatedAt: parsed?.updatedAt || parsed?.meta?.updatedAt || null,
            maxAgeSec: this.maxAgeSec,
          });
        }
        return this.defaultSnapshot("stale_snapshot_fallback");
      }
      this.lastStaleWarningKey = null;
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

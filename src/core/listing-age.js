const DAY_MS = 24 * 60 * 60 * 1000;

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeMinListingAgeDays(value, fallback = 0) {
  const parsed = asNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(parsed));
}

export function getListingAgeFetchSpec(minListingAgeDays) {
  const normalizedDays = normalizeMinListingAgeDays(minListingAgeDays, 0);
  if (normalizedDays <= 0) {
    return null;
  }

  if (normalizedDays <= 200) {
    return {
      interval: "day",
      count: Math.min(200, Math.max(2, normalizedDays + 2)),
    };
  }

  return {
    interval: "week",
    count: Math.min(200, Math.max(2, Math.ceil(normalizedDays / 7) + 2)),
  };
}

export function toCandleTimestampMs(candle = {}) {
  const timestamp = asNumber(candle?.timestamp, null);
  if (timestamp !== null && timestamp > 0) {
    return timestamp;
  }

  const candidates = [
    candle?.candleTimeKst,
    candle?.candleTimeUtc,
    candle?.firstDayOfPeriod,
  ];

  for (const candidate of candidates) {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

export function estimateListingAgeDays(candles = [], nowMs = Date.now()) {
  let oldestMs = null;
  for (const candle of Array.isArray(candles) ? candles : []) {
    const candleMs = toCandleTimestampMs(candle);
    if (!Number.isFinite(candleMs) || candleMs <= 0) {
      continue;
    }
    oldestMs = oldestMs === null ? candleMs : Math.min(oldestMs, candleMs);
  }

  if (!Number.isFinite(oldestMs)) {
    return {
      listingAgeDays: null,
      oldestCandleAt: null,
    };
  }

  return {
    listingAgeDays: Math.max(0, (nowMs - oldestMs) / DAY_MS),
    oldestCandleAt: new Date(oldestMs).toISOString(),
  };
}

export async function assessListingAge({
  marketData,
  symbol,
  minListingAgeDays,
  nowMs = Date.now(),
} = {}) {
  const normalizedDays = normalizeMinListingAgeDays(minListingAgeDays, 0);
  if (normalizedDays <= 0) {
    return {
      ok: true,
      skipped: "disabled",
      symbol,
      minListingAgeDays: 0,
      listingAgeDays: null,
      oldestCandleAt: null,
      candleCount: 0,
      interval: null,
    };
  }

  const fetchSpec = getListingAgeFetchSpec(normalizedDays);
  if (!marketData || typeof marketData.getCandles !== "function" || !fetchSpec) {
    return {
      ok: false,
      reason: "listing_age_unverified",
      symbol,
      minListingAgeDays: normalizedDays,
      listingAgeDays: null,
      oldestCandleAt: null,
      candleCount: 0,
      interval: fetchSpec?.interval || null,
    };
  }

  const response = await marketData.getCandles({
    symbol,
    interval: fetchSpec.interval,
    count: fetchSpec.count,
  });
  const candles = Array.isArray(response?.candles) ? response.candles : [];
  const estimated = estimateListingAgeDays(candles, nowMs);
  const listingAgeDays = estimated.listingAgeDays;

  return {
    ok: Number.isFinite(listingAgeDays) && listingAgeDays >= normalizedDays,
    reason: Number.isFinite(listingAgeDays) ? "insufficient_listing_age" : "listing_age_unverified",
    symbol,
    minListingAgeDays: normalizedDays,
    listingAgeDays,
    oldestCandleAt: estimated.oldestCandleAt,
    candleCount: candles.length,
    interval: response?.interval || fetchSpec.interval,
  };
}

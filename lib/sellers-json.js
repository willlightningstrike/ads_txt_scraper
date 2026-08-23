const {
  createHttpError,
  fetchJsonText,
  validateExternalUrl
} = require("./http-client");
const { normalizeHostname } = require("./validation");

const MAX_CACHEABLE_JSON_BYTES = Number(process.env.MAX_CACHEABLE_JSON_BYTES || 10 * 1024 * 1024);
const SELLERS_CACHE_TTL_MS = 60 * 60 * 1000;
const SELLERS_CACHE_SIZE = Number(process.env.SELLERS_CACHE_SIZE || 10);

const KNOWN_SELLERS_JSON_OVERRIDES = {
  "google.com": {
    sellerJsonUrl: "https://storage.googleapis.com/adx-rtb-dictionaries/sellers.json",
    reason: "Google publishes sellers.json from its Authorized Buyers storage endpoint."
  },
  "www.google.com": {
    sellerJsonUrl: "https://storage.googleapis.com/adx-rtb-dictionaries/sellers.json",
    reason: "Google publishes sellers.json from its Authorized Buyers storage endpoint."
  }
};

class LruTtlCache {
  constructor(limit, ttlMs) {
    this.limit = limit;
    this.ttlMs = ttlMs;
    this.items = new Map();
  }

  get(key) {
    const cached = this.items.get(key);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.items.delete(key);
      return null;
    }

    this.items.delete(key);
    this.items.set(key, cached);
    return cached.value;
  }

  set(key, value) {
    if (this.items.has(key)) {
      this.items.delete(key);
    }

    this.items.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs
    });

    if (this.items.size > this.limit) {
      const oldestKey = this.items.keys().next().value;
      this.items.delete(oldestKey);
    }
  }
}

const sellersCache = new LruTtlCache(SELLERS_CACHE_SIZE, SELLERS_CACHE_TTL_MS);
const inFlightSellersFetches = new Map();

function resolveSellersJsonTarget(adSystemDomain) {
  const normalizedDomain = normalizeHostname(adSystemDomain);
  const override = KNOWN_SELLERS_JSON_OVERRIDES[normalizedDomain];

  if (override) {
    return {
      adSystemDomain: normalizedDomain,
      sellerJsonUrl: override.sellerJsonUrl,
      strategy: "override",
      reason: override.reason
    };
  }

  return {
    adSystemDomain: normalizedDomain,
    sellerJsonUrl: `https://${normalizedDomain}/sellers.json`,
    strategy: "standard",
    reason: null
  };
}

async function fetchSellersJson(url) {
  const cached = sellersCache.get(url);
  if (cached) {
    return cached;
  }

  // Many ads.txt rows share one sellers.json endpoint, and none of them can hit
  // the cache until the first fetch resolves. Share the request instead.
  const pending = inFlightSellersFetches.get(url);
  if (pending) {
    return pending;
  }

  const request = loadSellersJson(url).finally(() => {
    inFlightSellersFetches.delete(url);
  });

  inFlightSellersFetches.set(url, request);
  return request;
}

// Deliberately not cancellable: this promise is shared between every matching
// ads.txt row that points at the same endpoint, so one caller giving up must not
// abort the fetch the others are still waiting on. REQUEST_TIMEOUT_MS bounds it.
async function loadSellersJson(url) {
  const validatedTarget = await validateExternalUrl(url);
  const raw = await fetchJsonText(validatedTarget);
  let payload;

  try {
    payload = JSON.parse(raw);
  } catch {
    throw createHttpError(502, "sellers.json was not valid JSON.");
  }

  if (!payload || !Array.isArray(payload.sellers)) {
    throw createHttpError(502, "sellers.json did not include a valid sellers array.");
  }

  // Measure the decoded body. Content-Length reports compressed bytes, so a
  // gzip response could otherwise admit far more than the cap into the cache.
  if (Buffer.byteLength(raw) <= MAX_CACHEABLE_JSON_BYTES) {
    sellersCache.set(url, payload);
  }

  return payload;
}

module.exports = {
  fetchSellersJson,
  resolveSellersJsonTarget,
  LruTtlCache,
  sellersCache
};

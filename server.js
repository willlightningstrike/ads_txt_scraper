const cors = require("cors");
const dns = require("dns").promises;
const express = require("express");
const axios = require("axios");
const https = require("https");
const net = require("net");
const path = require("path");

const app = express();
const HOST = process.env.HOST || "127.0.0.1";
const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20_000);
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_JSON_BYTES = Number(process.env.MAX_JSON_BYTES || 128 * 1024 * 1024);
const MAX_CACHEABLE_JSON_BYTES = Number(process.env.MAX_CACHEABLE_JSON_BYTES || 10 * 1024 * 1024);
const SELLERS_CACHE_TTL_MS = 60 * 60 * 1000;
const SELLERS_CACHE_SIZE = Number(process.env.SELLERS_CACHE_SIZE || 10);

// ECONNABORTED is axios's own timeout, ERR_CANCELED is the abort signal, and
// ETIMEDOUT is the OS connect timeout. Any of them means the deadline passed.
const TIMEOUT_ERROR_CODES = new Set(["ECONNABORTED", "ERR_CANCELED", "ETIMEDOUT"]);

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

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

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

const privateIpv4Blocklist = new net.BlockList();
privateIpv4Blocklist.addSubnet("10.0.0.0", 8, "ipv4");
privateIpv4Blocklist.addSubnet("127.0.0.0", 8, "ipv4");
privateIpv4Blocklist.addSubnet("169.254.0.0", 16, "ipv4");
privateIpv4Blocklist.addSubnet("172.16.0.0", 12, "ipv4");
privateIpv4Blocklist.addSubnet("192.168.0.0", 16, "ipv4");

const privateIpv6Blocklist = new net.BlockList();
privateIpv6Blocklist.addAddress("::", "ipv6");
privateIpv6Blocklist.addAddress("::1", "ipv6");
privateIpv6Blocklist.addSubnet("fc00::", 7, "ipv6");
privateIpv6Blocklist.addSubnet("fe80::", 10, "ipv6");
privateIpv6Blocklist.addSubnet("fec0::", 10, "ipv6");

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/validate", async (req, res) => {
  const adsTxtUrl = typeof req.body?.adsTxtUrl === "string" ? req.body.adsTxtUrl.trim() : "";
  const accountId = typeof req.body?.accountId === "string" ? req.body.accountId.trim() : "";

  if (!adsTxtUrl || !accountId) {
    return res.status(400).json({
      error: "Both ads.txt URL and account ID are required."
    });
  }

  try {
    const adsTarget = await validateExternalUrl(adsTxtUrl);
    const publisherDomain = adsTarget.hostname;
    const adsTxtRaw = await fetchText(adsTarget);
    const adsEntries = parseAdsTxt(adsTxtRaw);
    const matchingEntries = adsEntries.filter((entry) => entry.accountId === accountId);

    const records = await Promise.all(
      matchingEntries.map((entry) => validateEntry(entry, publisherDomain))
    );

    const summary = summarize(records);

    return res.json({
      adsTxtUrl: adsTarget.url.toString(),
      publisherDomain,
      accountId,
      adsTxtEntryCount: adsEntries.length,
      matchedEntryCount: matchingEntries.length,
      summary,
      records
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({
      error: error.message || "Validation failed."
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Ads.txt validator running at http://${HOST}:${PORT}`);
  });
}

async function validateEntry(entry, publisherDomain) {
  const sellersTarget = resolveSellersJsonTarget(entry.adSystemDomain);
  const sellerJsonUrl = sellersTarget.sellerJsonUrl;

  try {
    const sellersPayload = await fetchSellersJson(sellerJsonUrl);
    const seller = sellersPayload.sellers.find(
      (candidate) => String(candidate.seller_id || "").trim() === entry.accountId
    );

    if (!seller) {
      return buildBaseRecord(entry, publisherDomain, sellerJsonUrl, {
        status: "not_found",
        statusLabel: "Not Found",
        message: "Seller ID was not found in sellers.json."
      });
    }

    const sellerType = normalizeSellerType(seller.seller_type);
    const validation = validateSellerType(entry.relationship, sellerType);
    const sellerDomain = seller.domain ? normalizeHostname(seller.domain) : null;
    const domainCheck = compareDomains(publisherDomain, sellerDomain);
    const confidential = String(seller.is_confidential || "0") === "1";

    return buildBaseRecord(entry, publisherDomain, sellerJsonUrl, {
      sellerJsonStrategy: sellersTarget.strategy,
      sellerJsonOverrideReason: sellersTarget.reason,
      status: validation.status,
      statusLabel: validation.statusLabel,
      message: validation.message,
      seller: {
        sellerId: String(seller.seller_id || ""),
        name: seller.name || "Unknown seller",
        sellerType,
        domain: sellerDomain,
        isConfidential: confidential,
        comment: seller.comment || null
      },
      domainCheck,
      confidential
    });
  } catch (error) {
    return buildBaseRecord(entry, publisherDomain, sellerJsonUrl, {
      sellerJsonStrategy: sellersTarget.strategy,
      sellerJsonOverrideReason: sellersTarget.reason,
      status: "unreachable",
      statusLabel: "Unreachable",
      message: error.message || "Unable to fetch sellers.json."
    });
  }
}

function buildBaseRecord(entry, publisherDomain, sellerJsonUrl, overrides) {
  return {
    adSystemDomain: normalizeHostname(entry.adSystemDomain),
    sellerJsonUrl,
    sellerJsonStrategy: "standard",
    sellerJsonOverrideReason: null,
    accountId: entry.accountId,
    relationship: entry.relationship,
    certificationAuthorityId: entry.certificationAuthorityId,
    publisherDomain,
    lineNumber: entry.lineNumber,
    raw: entry.raw,
    seller: null,
    domainCheck: {
      status: "unknown",
      message: "No seller domain provided in sellers.json."
    },
    confidential: false,
    ...overrides
  };
}

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

function parseAdsTxt(input) {
  return input
    .split(/\r?\n/)
    .map((line, index) => parseAdsTxtLine(line, index + 1))
    .filter(Boolean);
}

function parseAdsTxtLine(line, lineNumber) {
  const commentIndex = line.indexOf("#");
  const withoutComment = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const trimmed = withoutComment.trim();

  if (!trimmed) {
    return null;
  }

  const fields = trimmed.split(",").map((part) => part.trim());
  if (fields.length < 3) {
    return null;
  }

  return {
    adSystemDomain: normalizeHostname(fields[0]),
    accountId: fields[1],
    relationship: fields[2].toUpperCase(),
    certificationAuthorityId: fields[3] || null,
    lineNumber,
    raw: line.trim()
  };
}

function validateSellerType(relationship, sellerType) {
  const expectedTypes = relationship === "DIRECT"
    ? ["PUBLISHER", "BOTH"]
    : relationship === "RESELLER"
      ? ["INTERMEDIARY", "BOTH"]
      : [];

  if (expectedTypes.includes(sellerType)) {
    return {
      status: "valid",
      statusLabel: "Valid",
      message: `ads.txt relationship ${relationship} matches sellers.json seller_type ${sellerType}.`
    };
  }

  if (!expectedTypes.length) {
    return {
      status: "mismatch",
      statusLabel: "Mismatch",
      message: `Unsupported ads.txt relationship ${relationship} cannot be validated confidently.`
    };
  }

  return {
    status: "mismatch",
    statusLabel: "Mismatch",
    message: `ads.txt relationship ${relationship} does not align with sellers.json seller_type ${sellerType || "UNKNOWN"}.`
  };
}

function summarize(records) {
  return records.reduce(
    (summary, record) => {
      summary.total += 1;
      summary[record.status] += 1;

      if (record.confidential) {
        summary.confidential += 1;
      }

      if (record.domainCheck?.status === "match") {
        summary.domainMatches += 1;
      }

      if (record.domainCheck?.status === "mismatch") {
        summary.domainMismatches += 1;
      }

      return summary;
    },
    {
      total: 0,
      valid: 0,
      mismatch: 0,
      not_found: 0,
      unreachable: 0,
      confidential: 0,
      domainMatches: 0,
      domainMismatches: 0
    }
  );
}

function compareDomains(publisherDomain, sellerDomain) {
  if (!sellerDomain) {
    return {
      status: "unknown",
      message: "No seller domain provided in sellers.json."
    };
  }

  if (
    publisherDomain === sellerDomain ||
    publisherDomain.endsWith(`.${sellerDomain}`) ||
    sellerDomain.endsWith(`.${publisherDomain}`)
  ) {
    return {
      status: "match",
      message: `Seller domain ${sellerDomain} aligns with publisher domain ${publisherDomain}.`,
      sellerDomain
    };
  }

  return {
    status: "mismatch",
    message: `Seller domain ${sellerDomain} does not match publisher domain ${publisherDomain}.`,
    sellerDomain
  };
}

async function fetchSellersJson(url) {
  const cached = sellersCache.get(url);
  if (cached) {
    return cached;
  }

  const validatedTarget = await validateExternalUrl(url);
  const response = await fetchJson(validatedTarget);
  const payload = response.data;

  if (!payload || !Array.isArray(payload.sellers)) {
    throw createHttpError(502, "sellers.json did not include a valid sellers array.");
  }

  const contentLength = Number(response.headers?.["content-length"] || 0);
  if (contentLength > 0 && contentLength <= MAX_CACHEABLE_JSON_BYTES) {
    sellersCache.set(url, payload);
  }

  return payload;
}

async function fetchText(url) {
  const response = await fetchWithRedirects(url, MAX_TEXT_BYTES);
  return typeof response.data === "string" ? response.data : String(response.data || "");
}

async function fetchJson(url) {
  return fetchWithRedirects(url, MAX_JSON_BYTES, "json");
}

function buildAxiosOptions(maxBytes, responseType = "text", pinnedAddress = null) {
  const options = {
    timeout: REQUEST_TIMEOUT_MS,
    // axios's timeout is a socket-inactivity timer and never arms while a TCP
    // handshake is still stalling, which lets the OS connect timeout (75s on
    // macOS) govern instead. The signal is a hard wall-clock deadline.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    responseType,
    maxRedirects: 0,
    headers: {
      "User-Agent": "ads-sellers-validator/1.0",
      Accept: responseType === "json" ? "application/json,text/plain;q=0.8,*/*;q=0.5" : "text/plain,*/*;q=0.5"
    },
    validateStatus: (status) => status >= 200 && status < 400
  };

  if (pinnedAddress) {
    options.httpsAgent = new https.Agent({
      lookup: createPinnedLookup(pinnedAddress)
    });
  }

  return options;
}

async function fetchWithRedirects(url, maxBytes, responseType = "text") {
  let currentTarget = isValidatedTarget(url) ? url : await validateExternalUrl(url);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await requestValidatedUrl(currentTarget, maxBytes, responseType);

      if (response.status >= 200 && response.status < 300) {
        return response;
      }

      const location = response.headers?.location;
      if (!location) {
        throw createHttpError(502, "Remote server responded with a redirect but no location header.");
      }

      const redirectedUrl = new URL(location, currentTarget.url);
      currentTarget = await validateExternalUrl(redirectedUrl.toString());
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }

      if (TIMEOUT_ERROR_CODES.has(error.code)) {
        throw createHttpError(504, `Remote server timed out while fetching ${currentTarget.url.hostname}.`);
      }

      if (error.code === "ERR_BAD_RESPONSE" || error.code === "ERR_BAD_REQUEST") {
        const status = error.response?.status;
        throw createHttpError(502, `Remote server returned HTTP ${status || "error"} for ${currentTarget.url.hostname}.`);
      }

      throw createHttpError(502, `Unable to reach ${currentTarget.url.hostname}.`);
    }
  }

  throw createHttpError(502, "Too many redirects while fetching a required file.");
}

async function requestValidatedUrl(target, maxBytes, responseType) {
  let lastError = null;

  // Pin each outbound connection to an address we already validated to avoid DNS rebinding.
  for (const address of target.addresses) {
    try {
      return await axios.get(
        target.url.toString(),
        buildAxiosOptions(maxBytes, responseType, address)
      );
    } catch (error) {
      lastError = error;

      if (!shouldRetryWithAnotherAddress(error)) {
        throw error;
      }
    }
  }

  throw lastError || createHttpError(502, `Unable to reach ${target.url.hostname}.`);
}

function shouldRetryWithAnotherAddress(error) {
  if (error.response || error.statusCode) {
    return false;
  }

  // A timeout already spent the whole budget. Replaying it against a sibling
  // address multiplies the wait by the number of resolved IPs without making
  // an unresponsive host any more likely to answer.
  return !TIMEOUT_ERROR_CODES.has(error.code);
}

async function validateExternalUrl(rawUrl) {
  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw createHttpError(400, "Enter a valid HTTPS URL.");
  }

  if (parsed.protocol !== "https:") {
    throw createHttpError(400, "Only HTTPS URLs are allowed.");
  }

  if (parsed.username || parsed.password) {
    throw createHttpError(400, "URLs with embedded credentials are not allowed.");
  }

  if (parsed.port && parsed.port !== "443") {
    throw createHttpError(400, "Only standard HTTPS endpoints on port 443 are allowed.");
  }

  const hostname = normalizeLookupHost(parsed.hostname);
  if (!hostname || isLocalHostname(hostname)) {
    throw createHttpError(400, "Local or internal hostnames are not allowed.");
  }

  const ipVersion = net.isIP(hostname);
  if (ipVersion) {
    if (isPrivateIp(hostname)) {
      throw createHttpError(400, "Private or loopback IP addresses are not allowed.");
    }

    return {
      url: parsed,
      hostname,
      addresses: [hostname]
    };
  }

  let resolvedAddresses;

  try {
    resolvedAddresses = (await dns.lookup(hostname, { all: true, verbatim: true }))
      .map((address) => normalizeLookupHost(address.address))
      .filter(Boolean);
  } catch {
    throw createHttpError(400, "Could not resolve the target hostname.");
  }

  if (!resolvedAddresses.length) {
    throw createHttpError(400, "Could not resolve the target hostname.");
  }

  const uniqueAddresses = [...new Set(resolvedAddresses)];
  for (const address of uniqueAddresses) {
    if (isPrivateIp(address)) {
      throw createHttpError(400, "Target hostname resolved to a private or loopback IP address.");
    }
  }

  return {
    url: parsed,
    hostname,
    addresses: uniqueAddresses
  };
}

function normalizeHostname(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
}

function normalizeSellerType(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function isLocalHostname(hostname) {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local");
}

function isPrivateIp(address) {
  const normalized = normalizeLookupHost(address);
  const version = net.isIP(normalized);

  if (version === 4) {
    return privateIpv4Blocklist.check(normalized, "ipv4");
  }

  if (version === 6) {
    if (privateIpv6Blocklist.check(normalized, "ipv6")) {
      return true;
    }

    const embeddedIpv4 = extractEmbeddedIpv4(normalized);
    if (embeddedIpv4) {
      return privateIpv4Blocklist.check(embeddedIpv4, "ipv4");
    }
  }

  return false;
}

function normalizeLookupHost(value) {
  return stripIpv6Brackets(normalizeHostname(value));
}

function stripIpv6Brackets(value) {
  const stringValue = String(value || "").trim();
  return stringValue.startsWith("[") && stringValue.endsWith("]")
    ? stringValue.slice(1, -1)
    : stringValue;
}

function extractEmbeddedIpv4(address) {
  const bytes = parseIpv6(address);
  if (!bytes) {
    return null;
  }

  const hasMappedPrefix = bytes.subarray(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  const hasCompatiblePrefix = bytes.subarray(0, 12).every((byte) => byte === 0);

  if (!hasMappedPrefix && !hasCompatiblePrefix) {
    return null;
  }

  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

function parseIpv6(address) {
  const normalized = stripIpv6Brackets(address).toLowerCase();
  if (net.isIP(normalized) !== 6) {
    return null;
  }

  let candidate = normalized;
  if (candidate.includes(".")) {
    const lastColon = candidate.lastIndexOf(":");
    const ipv4Tail = lastColon >= 0 ? candidate.slice(lastColon + 1) : "";
    if (net.isIP(ipv4Tail) !== 4) {
      return null;
    }

    const [first, second, third, fourth] = ipv4Tail.split(".").map(Number);
    candidate = `${candidate.slice(0, lastColon)}:${((first << 8) + second).toString(16)}:${((third << 8) + fourth).toString(16)}`;
  }

  const parts = candidate.split("::");
  if (parts.length > 2) {
    return null;
  }

  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];
  if (!left.every(isValidHextet) || !right.every(isValidHextet)) {
    return null;
  }

  const missingGroupCount = 8 - (left.length + right.length);
  if ((parts.length === 1 && missingGroupCount !== 0) || (parts.length === 2 && missingGroupCount < 1)) {
    return null;
  }

  const groups = parts.length === 2
    ? [...left, ...Array(missingGroupCount).fill("0"), ...right]
    : left;
  if (groups.length !== 8) {
    return null;
  }

  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => {
    const value = parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[(index * 2) + 1] = value & 0xff;
  });

  return bytes;
}

function isValidHextet(value) {
  return /^[0-9a-f]{1,4}$/i.test(value);
}

function isValidatedTarget(value) {
  return Boolean(value && value.url instanceof URL && Array.isArray(value.addresses));
}

function createPinnedLookup(address) {
  const family = net.isIP(address);

  return (_hostname, options, callback) => {
    let resolvedOptions = options;
    let resolvedCallback = callback;

    if (typeof resolvedOptions === "function") {
      resolvedCallback = resolvedOptions;
      resolvedOptions = {};
    } else if (typeof resolvedOptions === "number") {
      resolvedOptions = { family: resolvedOptions };
    }

    if (resolvedOptions?.all) {
      resolvedCallback(null, [{ address, family }]);
      return;
    }

    resolvedCallback(null, address, family);
  };
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  app,
  buildAxiosOptions,
  createPinnedLookup,
  fetchWithRedirects,
  isPrivateIp,
  shouldRetryWithAnotherAddress,
  validateExternalUrl
};

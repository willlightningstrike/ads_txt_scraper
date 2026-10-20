const dns = require("dns").promises;
const axios = require("axios");
const https = require("https");
const net = require("net");

const { normalizeHostname } = require("./validation");

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20_000);
const MAX_TEXT_BYTES = 512 * 1024;
// Store listings include page layout, scripts and images' metadata; Amazon's
// normal Fire TV pages exceed 1 MiB. Keep this separate from the ads.txt limit.
const MAX_STORE_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BYTES = Number(process.env.MAX_JSON_BYTES || 128 * 1024 * 1024);
const MAX_REDIRECT_HOPS = 4;

// ECONNABORTED is axios's own timeout, ERR_CANCELED is the abort signal, and
// ETIMEDOUT is the OS connect timeout. Any of them means the deadline passed.
const TIMEOUT_ERROR_CODES = new Set(["ECONNABORTED", "ERR_CANCELED", "ETIMEDOUT"]);

const privateIpv4Blocklist = new net.BlockList();
privateIpv4Blocklist.addSubnet("0.0.0.0", 8, "ipv4");
privateIpv4Blocklist.addSubnet("10.0.0.0", 8, "ipv4");
privateIpv4Blocklist.addSubnet("100.64.0.0", 10, "ipv4");
privateIpv4Blocklist.addSubnet("127.0.0.0", 8, "ipv4");
privateIpv4Blocklist.addSubnet("169.254.0.0", 16, "ipv4");
privateIpv4Blocklist.addSubnet("172.16.0.0", 12, "ipv4");
privateIpv4Blocklist.addSubnet("192.0.0.0", 24, "ipv4");
privateIpv4Blocklist.addSubnet("192.168.0.0", 16, "ipv4");
privateIpv4Blocklist.addSubnet("198.18.0.0", 15, "ipv4");
privateIpv4Blocklist.addSubnet("224.0.0.0", 4, "ipv4");
privateIpv4Blocklist.addSubnet("240.0.0.0", 4, "ipv4");

const privateIpv6Blocklist = new net.BlockList();
privateIpv6Blocklist.addAddress("::", "ipv6");
privateIpv6Blocklist.addAddress("::1", "ipv6");
privateIpv6Blocklist.addSubnet("fc00::", 7, "ipv6");
privateIpv6Blocklist.addSubnet("fe80::", 10, "ipv6");
privateIpv6Blocklist.addSubnet("fec0::", 10, "ipv6");

async function fetchText(url, signal = null) {
  const response = await fetchWithRedirects(url, MAX_TEXT_BYTES, "text", signal);
  return typeof response.data === "string" ? response.data : String(response.data || "");
}

async function fetchStoreHtml(url, signal = null) {
  const response = await fetchWithRedirects(url, MAX_STORE_PAGE_BYTES, "text", signal);
  return typeof response.data === "string" ? response.data : String(response.data || "");
}

async function fetchJsonText(url, signal = null) {
  const response = await fetchWithRedirects(url, MAX_JSON_BYTES, "json", signal);
  return typeof response.data === "string" ? response.data : String(response.data || "");
}

function buildAxiosOptions(maxBytes, acceptType = "text", pinnedAddress = null, signal = null) {
  // axios's timeout is a socket-inactivity timer and never arms while a TCP
  // handshake is still stalling, which lets the OS connect timeout (75s on
  // macOS) govern instead. The signal is a hard wall-clock deadline.
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  const options = {
    timeout: REQUEST_TIMEOUT_MS,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    // Always take the body as raw text. sellers.json is parsed by hand so its
    // decoded size can be measured before the cache admits it, and axios would
    // otherwise JSON.parse the string implicitly whatever responseType said.
    responseType: "text",
    transformResponse: [(data) => data],
    maxRedirects: 0,
    // Axios otherwise honours HTTPS_PROXY, which routes around httpsAgent and
    // lets the proxy re-resolve the hostname, defeating the pinned lookup below.
    proxy: false,
    headers: {
      "User-Agent": "ads-sellers-validator/1.0",
      Accept: acceptType === "json" ? "application/json,text/plain;q=0.8,*/*;q=0.5" : "text/plain,*/*;q=0.5"
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

async function fetchWithRedirects(url, maxBytes, acceptType = "text", signal = null) {
  let currentTarget = isValidatedTarget(url) ? url : await validateExternalUrl(url);

  // One request for the original URL, plus one for each redirect we agree to follow.
  for (let attempt = 0; attempt <= MAX_REDIRECT_HOPS; attempt += 1) {
    try {
      const response = await requestValidatedUrl(currentTarget, maxBytes, acceptType, signal);

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

      if (isResponseTooLarge(error)) {
        const sizeError = createHttpError(502, `Response from ${currentTarget.url.hostname} exceeds the ${maxBytes}-byte download limit.`);
        sizeError.code = "RESPONSE_TOO_LARGE";
        throw sizeError;
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

async function requestValidatedUrl(target, maxBytes, acceptType, signal = null) {
  let lastError = null;

  // Pin each outbound connection to an address we already validated to avoid DNS rebinding.
  for (const address of target.addresses) {
    try {
      return await axios.get(
        target.url.toString(),
        buildAxiosOptions(maxBytes, acceptType, address, signal)
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
  if (error.response || error.statusCode || isResponseTooLarge(error)) {
    return false;
  }

  // A timeout already spent the whole budget. Replaying it against a sibling
  // address multiplies the wait by the number of resolved IPs without making
  // an unresponsive host any more likely to answer.
  return !TIMEOUT_ERROR_CODES.has(error.code);
}

function isResponseTooLarge(error) {
  // Axios uses ERR_BAD_RESPONSE for both HTTP errors and its decoded-body cap.
  // A size failure has no response object, but retrying another IP cannot fix it.
  return error.code === "ERR_BAD_RESPONSE" && /^maxContentLength size of \d+ exceeded$/.test(error.message);
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
  validateExternalUrl,
  fetchText,
  fetchStoreHtml,
  fetchJsonText,
  fetchWithRedirects,
  buildAxiosOptions,
  createPinnedLookup,
  isPrivateIp,
  shouldRetryWithAnotherAddress,
  createHttpError
};

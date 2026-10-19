const { fetchJsonText, fetchText, validateExternalUrl } = require("./http-client");
const { normalizeHostname } = require("./validation");
const { awaitWithSignal } = require("./abort");

// Verified fallback for CTV package IDs without a reliable store lookup. Apple IDs
// stay out of this table so they continue to use the live iTunes lookup.
const KNOWN_APP_DEVELOPER_DOMAINS = {
  "tv.pluto.android": "pluto.tv"
};

// Store-scoped ASIN fallback: Amazon may return a shopping gate instead of metadata.
// Verified 2026-10-19: https://tubitv.com/static/devices links B075NTHVJW, and
// https://tubitv.com/app-ads.txt publishes OWNERDOMAIN=tubitv.com. Live metadata wins.
const KNOWN_AMAZON_DEVELOPER_DOMAINS = {
  B075NTHVJW: "tubitv.com"
};

async function resolveAppDomain(origin, options = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  const lookupItunes = options.lookupItunes || ((id) => lookupItunesSellerDomain(id, signal));

  if (origin.domain) {
    return { domain: origin.domain, resolvedFrom: origin.resolvedFrom };
  }

  if (origin.kind !== "app") {
    return { domain: null, resolvedFrom: null };
  }

  const mapped = origin.bundle ? KNOWN_APP_DEVELOPER_DOMAINS[origin.bundle] : null;
  if (mapped) {
    return { domain: mapped, resolvedFrom: "known-map" };
  }

  const store = storeOf(origin.storeurl);
  // An ASIN is an Amazon identifier, including when the exchange omits storeurl.
  // An explicit URL for another store always wins over identifier-shape inference.
  if (store === "amazon" || (!origin.storeurl && normalizeAmazonAsin(origin.bundle))) {
    return resolveAmazonDomain(origin, options);
  }

  // A store URL that names a CTV store settles which lookup applies. Its bundle is that
  // store's ID (Roku and LG use bare numbers), so it must never reach Apple's lookup —
  // a numeric CTV ID that happened to equal an Apple track ID would silently resolve
  // to an unrelated developer's domain.
  if (store && store !== "apple") {
    const lookupStorePage = options.lookupStorePage || ((url) => fetchStorePage(url, signal));
    try {
      const host = developerHost(parseDeveloperUrlMeta(await awaitWithSignal(lookupStorePage(storePageUrl(origin.storeurl)), signal)));
      return host ? { domain: host, resolvedFrom: "store-listing" } : { domain: null, resolvedFrom: null };
    } catch {
      signal?.throwIfAborted();
      // Same rule as the iTunes path: an unreadable listing degrades to asking the user,
      // never to a guess.
      return { domain: null, resolvedFrom: null };
    }
  }

  // Two candidates, because app.bundle and app.storeurl disagree more often than not.
  // The bundle is tried first when present; the store URL's track ID covers both the
  // case where there is no bundle at all and the case where the bundle is a reverse-DNS
  // string Apple cannot key on while the store URL is perfectly valid.
  const candidates = [];
  if (origin.bundle) {
    candidates.push(String(origin.bundle).trim());
  }
  const trackId = appleTrackId(origin.storeurl);
  if (trackId && !candidates.includes(trackId)) {
    candidates.push(trackId);
  }

  for (const candidate of candidates) {
    signal?.throwIfAborted();
    let sellerUrl = null;
    try {
      sellerUrl = await awaitWithSignal(lookupItunes(candidate), signal);
    } catch {
      signal?.throwIfAborted();
      // A store lookup failure must degrade to asking the user, never to a guess and
      // never to a 500. The manual input is always available behind this. Keep going:
      // a failure on one candidate says nothing about the next.
      continue;
    }

    const host = hostOf(sellerUrl);
    if (host) {
      return { domain: host, resolvedFrom: "itunes" };
    }
  }

  return { domain: null, resolvedFrom: null };
}

function normalizeAmazonAsin(value) {
  return typeof value === "string" && /^B[A-Z0-9]{9}$/i.test(value.trim())
    ? value.trim().toUpperCase() : null;
}

function amazonAsin(storeurl) {
  if (storeOf(storeurl) !== "amazon") return null;
  const url = new URL(storeurl);
  if (!["http:", "https:"].includes(url.protocol)) return null;
  const product = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i);
  if (product) return normalizeAmazonAsin(product[1]);
  // Amazon's documented web deep link. A random page's query string is not an app ID.
  return /^\/gp\/mas\/dl\/android\/?$/i.test(url.pathname)
    ? normalizeAmazonAsin(url.searchParams.get("asin")) : null;
}

async function resolveAmazonDomain(origin, options) {
  const unresolved = { domain: null, resolvedFrom: null };
  const bundleAsin = normalizeAmazonAsin(origin.bundle);
  const listingAsin = amazonAsin(origin.storeurl);
  // Do not certify one app using a different app's listing or fallback.
  if (bundleAsin && listingAsin && bundleAsin !== listingAsin) return unresolved;
  const asin = origin.storeurl ? listingAsin : bundleAsin;
  const url = origin.storeurl ? storePageUrl(origin.storeurl) : `https://www.amazon.com/dp/${asin}`;
  const signal = options.signal;
  const lookupStorePage = options.lookupStorePage || ((target) => fetchStorePage(target, signal));
  try {
    const html = await awaitWithSignal(lookupStorePage(url), signal);
    signal?.throwIfAborted();
    const host = developerHost(parseDeveloperUrlMeta(html));
    if (host) return { domain: host, resolvedFrom: "store-listing" };
  } catch {
    signal?.throwIfAborted();
  }
  // No challenge retries or Apple lookup. Unknown apps keep the manual domain path.
  return asin && Object.hasOwn(KNOWN_AMAZON_DEVELOPER_DOMAINS, asin)
    ? { domain: KNOWN_AMAZON_DEVELOPER_DOMAINS[asin], resolvedFrom: "known-map" }
    : unresolved;
}

// Apple keys NUMERIC App Store IDs as `id` and reverse-DNS identifiers as `bundleId`,
// and silently returns resultCount 0 for the wrong one. Exchanges routinely put the
// numeric track ID in app.bundle for iOS and CTV, so the parameter must be chosen by
// SHAPE rather than assumed. Verified 2026-08-23 against a real Paramount+ bid request:
//   ?bundleId=530168168 -> resultCount 0
//   ?id=530168168       -> Paramount+, sellerUrl https://www.paramountplus.com/
function buildItunesLookupUrl(identifier) {
  const key = /^\d+$/.test(identifier) ? "id" : "bundleId";
  return `https://itunes.apple.com/lookup?${key}=${encodeURIComponent(identifier)}`;
}

// An Apple store URL carries the numeric track ID as a /id<digits> path segment.
// The host is matched exactly (or as a true subdomain) rather than by suffix, so
// notapps.apple.com and apps.apple.com.evil.test are not mistaken for Apple.
function appleTrackId(storeurl) {
  if (!storeurl) {
    return null;
  }

  try {
    const parsed = new URL(String(storeurl));
    const host = parsed.hostname.toLowerCase();
    const isApple = ["apps.apple.com", "itunes.apple.com"].some(
      (apple) => host === apple || host.endsWith(`.${apple}`)
    );

    if (!isApple) {
      return null;
    }

    const match = parsed.pathname.match(/\/id(\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Stores whose listings publish the IAB app-ads.txt meta tag
//   <meta name="appstore:developer_url" content="...">
// so a crawler can find where the developer's app-ads.txt lives. Verified 2026-10-07
// against live listings: Roku 151908, LG 474301, Samsung G18229011675 and Amazon
// B07DBBTDBS all carry it. Apple does not, but its lookup API returns the same thing.
// Matching is exact or true-subdomain: the meta tag is trusted only because the page
// is the store's own, so a lookalike host must never qualify.
const STORE_HOSTS = [
  ["apple", ["apps.apple.com", "itunes.apple.com"]],
  ["roku", ["channelstore.roku.com"]],
  ["lg", ["lgappstv.com"]],
  ["samsung", ["samsung.com"]],
  ["amazon", ["amazon.com"]]
];

function storeOf(storeurl) {
  if (!storeurl) {
    return null;
  }

  let host;
  try {
    host = new URL(String(storeurl)).hostname.toLowerCase();
  } catch {
    return null;
  }

  for (const [store, domains] of STORE_HOSTS) {
    if (domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
      return store;
    }
  }
  return null;
}

// Listings are occasionally linked over plain http; outbound fetches are https-only.
function storePageUrl(storeurl) {
  const url = new URL(String(storeurl));
  url.protocol = "https:";
  return url.toString();
}

async function fetchStorePage(url, signal) {
  const target = await awaitWithSignal(validateExternalUrl(url), signal);
  signal?.throwIfAborted();
  return fetchText(target, signal);
}

// Stores format the tag differently — attribute order, quoting and closing all vary —
// so each <meta> tag is read attribute by attribute rather than by one exact pattern.
function parseDeveloperUrlMeta(html) {
  for (const tag of String(html || "").match(/<meta\b[^>]*>/gi) || []) {
    if ((metaAttribute(tag, "name") || "").toLowerCase() === "appstore:developer_url") {
      return metaAttribute(tag, "content");
    }
  }
  return null;
}

function metaAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return match ? (match[1] ?? match[2]).trim() || null : null;
}

// The tag's value is a bare host ("paramount.com"), a site URL ("http://lgchannels.com")
// or the app-ads.txt file itself ("https://therokuchannel.roku.com/app-ads.txt"). Only
// the host matters: app-ads.txt lives at the root of the developer's domain.
function developerHost(value) {
  if (!value || /\s/.test(value)) {
    return null;
  }
  return hostOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
}

async function lookupItunesSellerDomain(identifier, signal) {
  const target = await awaitWithSignal(validateExternalUrl(buildItunesLookupUrl(identifier)), signal);
  signal?.throwIfAborted();
  const raw = await fetchJsonText(target, signal);
  const payload = JSON.parse(raw);
  const first = Array.isArray(payload.results) ? payload.results[0] : null;
  return first && first.sellerUrl ? first.sellerUrl : null;
}

function hostOf(value) {
  if (!value) {
    return null;
  }

  try {
    return normalizeHostname(new URL(String(value)).hostname) || null;
  } catch {
    return null;
  }
}

module.exports = {
  KNOWN_APP_DEVELOPER_DOMAINS,
  appleTrackId,
  buildItunesLookupUrl,
  developerHost,
  lookupItunesSellerDomain,
  parseDeveloperUrlMeta,
  resolveAppDomain,
  storeOf
};

const { fetchJsonText, validateExternalUrl } = require("./http-client");
const { normalizeHostname } = require("./validation");

// CTV app stores publish no usable developer-domain lookup. A 2026-08-23 probe found
// Roku's channel API returning 404, Samsung and LG serving client-rendered shells, and
// Vizio and Fire TV offering nothing fetchable. See the spec's spike appendix. This map
// is the deliberate substitute: one publisher's app across Roku, Samsung, LG and Fire TV
// almost always resolves to a single developer domain, so a small table goes a long way.
// iOS bundles deliberately do NOT belong here: the map exists for platforms with no
// usable lookup, and iTunes resolves iOS bundles at runtime. Seeding an iOS bundle would
// shadow the live lookup, since the map is consulted first.
const KNOWN_APP_DEVELOPER_DOMAINS = {
  "tv.pluto.android": "pluto.tv"
};

async function resolveAppDomain(origin, options = {}) {
  const lookupItunes = options.lookupItunes || lookupItunesSellerDomain;

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
    let sellerUrl = null;
    try {
      sellerUrl = await lookupItunes(candidate);
    } catch {
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

async function lookupItunesSellerDomain(identifier) {
  const target = await validateExternalUrl(buildItunesLookupUrl(identifier));
  const raw = await fetchJsonText(target);
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
  lookupItunesSellerDomain,
  resolveAppDomain
};

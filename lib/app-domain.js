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

  if (origin.kind !== "app" || !origin.bundle) {
    return { domain: null, resolvedFrom: null };
  }

  const mapped = KNOWN_APP_DEVELOPER_DOMAINS[origin.bundle];
  if (mapped) {
    return { domain: mapped, resolvedFrom: "known-map" };
  }

  let sellerUrl = null;
  try {
    sellerUrl = await lookupItunes(origin.bundle);
  } catch {
    // A store lookup failure must degrade to asking the user, never to a guess and
    // never to a 500. The manual input is always available behind this.
    return { domain: null, resolvedFrom: null };
  }

  const host = hostOf(sellerUrl);
  return host ? { domain: host, resolvedFrom: "itunes" } : { domain: null, resolvedFrom: null };
}

// itunes.apple.com/lookup is queryable by bundle ID, so app.storeurl is not needed.
// Verified 2026-08-23: tv.pluto.ios -> sellerUrl "https://pluto.tv".
async function lookupItunesSellerDomain(bundleId) {
  const url = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}`;
  const target = await validateExternalUrl(url);
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

module.exports = { KNOWN_APP_DEVELOPER_DOMAINS, resolveAppDomain, lookupItunesSellerDomain };

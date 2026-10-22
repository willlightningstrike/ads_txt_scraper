const { normalizeHostname } = require("./validation");

function extractBidRequest(reduced) {
  const input = reduced && typeof reduced === "object" ? reduced : {};
  const warnings = [];
  const origin = extractOrigin(input, warnings);
  const schain = extractSchain(input.source, warnings);

  return {
    origin,
    nodes: schain.nodes,
    complete: schain.complete,
    schainVersion: schain.ver,
    schainSource: schain.source,
    warnings
  };
}

function extractOrigin(input, warnings) {
  if (input.site && typeof input.site === "object") {
    return siteOrigin(input.site, warnings);
  }
  if (input.app && typeof input.app === "object") {
    return appOrigin(input.app, warnings);
  }
  if (input.dooh && typeof input.dooh === "object") {
    return doohOrigin(input.dooh);
  }

  return baseOrigin({ kind: "unknown", file: "ads.txt" });
}

function siteOrigin(site, warnings) {
  const declared = resolveSiteDomain(site.domain);
  const pageHost = hostOf(site.page);

  if (declared && pageHost && declared !== pageHost) {
    warnings.push({
      code: "site_domain_page_mismatch",
      message: `site.domain is ${declared} but site.page is served from ${pageHost}.`
    });
  }

  const domain = declared || pageHost || null;

  return baseOrigin({
    kind: "site",
    file: "ads.txt",
    domain,
    resolvedFrom: declared ? "site.domain" : pageHost ? "site.page" : null,
    page: stringOrNull(site.page),
    name: stringOrNull(site.name),
    inventoryPartnerDomain: partnerDomain(site, domain)
  });
}

// Publishers commonly send a full page URL in site.domain instead of a bare host
// (e.g. "https://news.example/"). normalizeHostname only trims/lowercases, so a URL
// there would otherwise flow straight into a nonsense ads.txt lookup.
function resolveSiteDomain(domainValue) {
  const raw = typeof domainValue === "string" ? domainValue : "";
  if (raw.includes("/") || raw.includes("://")) {
    const parsedHost = hostOf(domainValue);
    if (parsedHost) {
      return parsedHost;
    }
  }
  // domainValue is JSON-derived and may be a non-string that would throw inside
  // normalizeHostname's own String() coercion; stringOrNull absorbs that first.
  return normalizeHostname(stringOrNull(domainValue));
}

function appOrigin(app, warnings) {
  // domain/bundle are JSON-derived and may be non-strings that would throw inside
  // normalizeHostname's/String()'s own coercion; stringOrNull absorbs that first.
  const declared = normalizeHostname(stringOrNull(app.domain));
  const bundle = app.bundle ? stringOrNull(app.bundle) : null;

  // Only Play store URLs carry the bundle ID in a comparable form (?id=com.foo.bar).
  // Apple's carry a numeric track ID that a reverse-DNS bundle cannot be checked
  // against, so claiming a mismatch there would be inventing a finding.
  const storeBundle = playStoreBundle(app.storeurl);
  if (bundle && storeBundle && bundle !== storeBundle) {
    warnings.push({
      code: "app_bundle_storeurl_mismatch",
      message: `app.bundle is ${bundle} but app.storeurl points at ${storeBundle}.`
    });
  }

  return baseOrigin({
    kind: "app",
    file: "app-ads.txt",
    domain: declared || null,
    resolvedFrom: declared ? "app.domain" : null,
    bundle,
    storeurl: stringOrNull(app.storeurl),
    name: stringOrNull(app.name),
    inventoryPartnerDomain: partnerDomain(app, declared || null)
  });
}

// OpenRTB 2.6 inventorypartnerdomain names the domain whose ads.txt authorizes this
// inventory under a sharing arrangement between a site owner and a content owner.
// Accept the ext form too; a nonempty direct field takes precedence.
// A value equal to the origin itself is not a partnership, so it is dropped rather
// than triggering a redundant second fetch of the same file.
// The value is interpolated into https://<partner>/ads.txt, so anything that is not a
// bare hostname (a path, query, fragment, credentials or port) is dropped: it would
// fetch a different resource than the partner/ads.txt the report names.
function partnerDomain(inventory, originDomain) {
  const value = stringOrNull(inventory.inventorypartnerdomain) || stringOrNull(inventory.ext?.inventorypartnerdomain);
  const partner = normalizeHostname(value) || null;
  if (!partner || /[/?#@:\\\s]/.test(partner)) {
    return null;
  }
  return partner !== originDomain ? partner : null;
}

function playStoreBundle(storeurl) {
  if (!storeurl) {
    return null;
  }

  try {
    const parsed = new URL(String(storeurl));
    if (!parsed.hostname.endsWith("play.google.com")) {
      return null;
    }
    const id = parsed.searchParams.get("id");
    return id ? id.trim() : null;
  } catch {
    return null;
  }
}

function doohOrigin(dooh) {
  // dooh.domain is JSON-derived and may be a non-string; see appOrigin/resolveSiteDomain.
  const declared = normalizeHostname(stringOrNull(dooh.domain));

  return baseOrigin({
    kind: "dooh",
    file: "ads.txt",
    domain: declared || null,
    resolvedFrom: declared ? "dooh.domain" : null,
    name: stringOrNull(dooh.name)
  });
}

function baseOrigin(overrides) {
  return {
    kind: "unknown",
    domain: null,
    file: "ads.txt",
    resolvedFrom: null,
    page: null,
    bundle: null,
    storeurl: null,
    name: null,
    inventoryPartnerDomain: null,
    ...overrides
  };
}

// This module is the sanitizing boundary for a later task that will call .trim() or
// escapeHtml() on these fields, so anything that isn't already a string must come back
// as a string or null here rather than passing through as an object/array/number. It is
// also the boundary that keeps hostile JSON values (e.g. {"toString":1}, which throws
// TypeError out of a bare String()/normalizeHostname() call) from ever reaching those
// unguarded coercions — every JSON-derived value must pass through here first.
function stringOrNull(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim() || null;
  }
  try {
    return String(value).trim() || null;
  } catch {
    return null;
  }
}

// source.ext.schain is preferred over source.schain. ORTB 2.6 moved the object to
// source.schain, but live traffic overwhelmingly still carries the ext form, and a
// validator should read what is on the wire. A disagreement is surfaced, not hidden.
function extractSchain(source, warnings) {
  const empty = { nodes: [], complete: null, ver: null, source: null };
  if (!source || typeof source !== "object") {
    warnings.push({ code: "no_schain", message: "The bid request declares no supply chain." });
    return empty;
  }

  const ext = source.ext && typeof source.ext === "object" ? source.ext.schain : null;
  const native = source.schain;
  const chosen = isSchain(ext) ? ext : isSchain(native) ? native : null;

  if (!chosen) {
    warnings.push({ code: "no_schain", message: "The bid request declares no supply chain." });
    return empty;
  }

  if (isSchain(ext) && isSchain(native) && JSON.stringify(ext) !== JSON.stringify(native)) {
    warnings.push({
      code: "schain_source_disagreement",
      message: "source.ext.schain and source.schain differ. Auditing source.ext.schain."
    });
  }

  return {
    nodes: normalizeNodes(chosen.nodes, warnings),
    // "not declared" (undefined/null) is distinct from "declared incomplete" (anything
    // else that isn't 1/"1") — collapsing the two would manufacture an incomplete-chain
    // finding out of a field the request never populated.
    complete: chosen.complete == null ? null : (chosen.complete === 1 || chosen.complete === "1" ? 1 : 0),
    ver: chosen.ver ? stringOrNull(chosen.ver) : null,
    source: isSchain(ext) ? "source.ext.schain" : "source.schain"
  };
}

function isSchain(value) {
  return Boolean(value && typeof value === "object" && Array.isArray(value.nodes));
}

// auditChain does one sequential network round-trip (validateExternalUrl + DNS + HTTPS)
// per surviving node. Real supply chains run 1-5 hops; 32 is generous headroom while
// still bounding a request that pads schain.nodes with thousands of distinct asi values
// purely to drive unbounded outbound fan-out.
const MAX_SCHAIN_NODES = 32;

function normalizeNodes(nodes, warnings) {
  let droppedCount = 0;

  const normalized = nodes
    .map((node) => {
      if (!node || typeof node !== "object") {
        droppedCount += 1;
        return null;
      }

      // asi/sid are JSON-derived and may be non-strings; see appOrigin/resolveSiteDomain.
      const asi = normalizeHostname(stringOrNull(node.asi));
      const sid = stringOrNull(node.sid) || "";

      if (!asi || !sid) {
        droppedCount += 1;
        return null;
      }

      return {
        asi,
        sid,
        hp: node.hp == null ? null : (node.hp === 1 || node.hp === "1" ? 1 : 0),
        name: stringOrNull(node.name),
        domain: node.domain ? (normalizeHostname(stringOrNull(node.domain)) || null) : null,
        rid: stringOrNull(node.rid)
      };
    })
    .filter(Boolean);

  if (droppedCount > 0) {
    warnings.push({
      code: "invalid_schain_node",
      message: droppedCount === 1
        ? "1 schain node without both asi and sid was dropped."
        : `${droppedCount} schain nodes without both asi and sid were dropped.`
    });
  }

  if (normalized.length > MAX_SCHAIN_NODES) {
    const truncatedCount = normalized.length - MAX_SCHAIN_NODES;
    warnings.push({
      code: "schain_truncated",
      message: truncatedCount === 1
        ? `1 schain node beyond the ${MAX_SCHAIN_NODES}-node limit was dropped.`
        : `${truncatedCount} schain nodes beyond the ${MAX_SCHAIN_NODES}-node limit were dropped.`
    });
    return normalized.slice(0, MAX_SCHAIN_NODES);
  }

  return normalized;
}

function hostOf(value) {
  if (!value) {
    return null;
  }

  try {
    return normalizeHostname(new URL(String(value)).hostname);
  } catch {
    return null;
  }
}

module.exports = { extractBidRequest };

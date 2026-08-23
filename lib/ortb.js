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

  return baseOrigin({
    kind: "site",
    file: "ads.txt",
    domain: declared || pageHost || null,
    resolvedFrom: declared ? "site.domain" : pageHost ? "site.page" : null,
    page: stringOrNull(site.page),
    name: stringOrNull(site.name)
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
  return normalizeHostname(domainValue);
}

function appOrigin(app, warnings) {
  const declared = normalizeHostname(app.domain);
  const bundle = app.bundle ? String(app.bundle).trim() : null;

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
    name: stringOrNull(app.name)
  });
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
  const declared = normalizeHostname(dooh.domain);

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
    ...overrides
  };
}

// This module is the sanitizing boundary for a later task that will call .trim() or
// escapeHtml() on these fields, so anything that isn't already a string must come back
// as a string or null here rather than passing through as an object/array/number.
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
    ver: chosen.ver ? String(chosen.ver) : null,
    source: isSchain(ext) ? "source.ext.schain" : "source.schain"
  };
}

function isSchain(value) {
  return Boolean(value && typeof value === "object" && Array.isArray(value.nodes));
}

function normalizeNodes(nodes, warnings) {
  let droppedCount = 0;

  const normalized = nodes
    .map((node) => {
      if (!node || typeof node !== "object") {
        droppedCount += 1;
        return null;
      }

      const asi = normalizeHostname(node.asi);
      const sid = node.sid === undefined || node.sid === null ? "" : String(node.sid).trim();

      if (!asi || !sid) {
        droppedCount += 1;
        return null;
      }

      return {
        asi,
        sid,
        hp: node.hp == null ? null : (node.hp === 1 || node.hp === "1" ? 1 : 0),
        name: node.name || null,
        domain: node.domain ? normalizeHostname(node.domain) : null,
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

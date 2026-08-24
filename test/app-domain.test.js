const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveAppDomain, KNOWN_APP_DEVELOPER_DOMAINS } = require("../lib/app-domain");

const neverCalled = async () => {
  throw new Error("iTunes lookup should not have been called");
};

test("an already-resolved origin is returned untouched", async () => {
  const result = await resolveAppDomain(
    { kind: "app", domain: "zynga.com", resolvedFrom: "app.domain", bundle: "com.zynga.words" },
    { lookupItunes: neverCalled }
  );

  assert.deepEqual(result, { domain: "zynga.com", resolvedFrom: "app.domain" });
});

test("the curated map resolves a CTV bundle without any lookup", async () => {
  const bundle = Object.keys(KNOWN_APP_DEVELOPER_DOMAINS)[0];
  const result = await resolveAppDomain(
    { kind: "app", domain: null, bundle },
    { lookupItunes: neverCalled }
  );

  assert.equal(result.domain, KNOWN_APP_DEVELOPER_DOMAINS[bundle]);
  assert.equal(result.resolvedFrom, "known-map");
});

test("the curated map is consulted before iTunes", async () => {
  const bundle = Object.keys(KNOWN_APP_DEVELOPER_DOMAINS)[0];
  const result = await resolveAppDomain({ kind: "app", domain: null, bundle }, {
    lookupItunes: neverCalled
  });

  assert.equal(result.resolvedFrom, "known-map");
});

test("iTunes resolves an unmapped bundle and only its hostname is kept", async () => {
  const result = await resolveAppDomain(
    { kind: "app", domain: null, bundle: "tv.pluto.ios" },
    { lookupItunes: async (bundleId) => (bundleId === "tv.pluto.ios" ? "https://pluto.tv/watch" : null) }
  );

  assert.deepEqual(result, { domain: "pluto.tv", resolvedFrom: "itunes" });
});

test("an unresolved bundle returns null rather than guessing from the bundle ID", async () => {
  const result = await resolveAppDomain(
    { kind: "app", domain: null, bundle: "com.acme.someapp" },
    { lookupItunes: async () => null }
  );

  assert.deepEqual(result, { domain: null, resolvedFrom: null });
});

test("an iTunes failure degrades to asking rather than throwing", async () => {
  const result = await resolveAppDomain(
    { kind: "app", domain: null, bundle: "com.acme.someapp" },
    { lookupItunes: async () => { throw new Error("network down"); } }
  );

  assert.deepEqual(result, { domain: null, resolvedFrom: null });
});

test("non-app origins are passed through without a lookup", async () => {
  const result = await resolveAppDomain(
    { kind: "site", domain: "dailynews.example", resolvedFrom: "site.domain" },
    { lookupItunes: neverCalled }
  );

  assert.deepEqual(result, { domain: "dailynews.example", resolvedFrom: "site.domain" });
});

test("a bundle-less app origin does no lookup", async () => {
  const result = await resolveAppDomain(
    { kind: "app", domain: null, bundle: null },
    { lookupItunes: neverCalled }
  );

  assert.deepEqual(result, { domain: null, resolvedFrom: null });
});

// --- Apple lookup keying (bug found 2026-08-23 from a real Paramount+ bid request) ---
// Apple keys numeric App Store IDs as `id` and reverse-DNS identifiers as `bundleId`.
// Exchanges routinely put the numeric track ID in app.bundle for iOS and CTV.

const { buildItunesLookupUrl, appleTrackId } = require("../lib/app-domain");

test("a numeric app.bundle is looked up by id, not bundleId", () => {
  const url = buildItunesLookupUrl("530168168");
  assert.match(url, /[?&]id=530168168/);
  assert.equal(/bundleId=/.test(url), false);
});

test("a reverse-DNS app.bundle is still looked up by bundleId", () => {
  const url = buildItunesLookupUrl("tv.pluto.ios");
  assert.match(url, /[?&]bundleId=tv\.pluto\.ios/);
});

test("a numeric bundle reaches the lookup and resolves", async () => {
  const seen = [];
  const result = await resolveAppDomain(
    { kind: "app", domain: null, bundle: "530168168", storeurl: "https://apps.apple.com/us/app/paramount/id530168168" },
    { lookupItunes: async (identifier) => { seen.push(identifier); return "https://www.paramountplus.com/"; } }
  );

  assert.deepEqual(result, { domain: "www.paramountplus.com", resolvedFrom: "itunes" });
  assert.deepEqual(seen, ["530168168"]);
});

test("the Apple store URL supplies the track id when app.bundle is absent", async () => {
  const seen = [];
  const result = await resolveAppDomain(
    { kind: "app", domain: null, bundle: null, storeurl: "https://apps.apple.com/us/app/paramount/id530168168" },
    { lookupItunes: async (identifier) => { seen.push(identifier); return "https://www.paramountplus.com/"; } }
  );

  assert.equal(result.domain, "www.paramountplus.com");
  assert.deepEqual(seen, ["530168168"]);
});

test("the store URL is tried after a bundle Apple does not know", async () => {
  const seen = [];
  const result = await resolveAppDomain(
    { kind: "app", domain: null, bundle: "com.unknown.app", storeurl: "https://apps.apple.com/us/app/paramount/id530168168" },
    { lookupItunes: async (identifier) => { seen.push(identifier); return identifier === "530168168" ? "https://www.paramountplus.com/" : null; } }
  );

  assert.equal(result.domain, "www.paramountplus.com");
  assert.deepEqual(seen, ["com.unknown.app", "530168168"]);
});

test("appleTrackId ignores a non-Apple store URL", () => {
  assert.equal(appleTrackId("https://play.google.com/store/apps/details?id=com.a.b"), null);
});

test("appleTrackId does not trust a lookalike Apple host", () => {
  assert.equal(appleTrackId("https://notapps.apple.com/us/app/x/id530168168"), null);
  assert.equal(appleTrackId("https://apps.apple.com.evil.test/us/app/x/id530168168"), null);
});

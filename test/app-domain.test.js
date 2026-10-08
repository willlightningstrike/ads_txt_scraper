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

// --- CTV store listings: the IAB appstore:developer_url meta tag ---
// Fixture lines are copied verbatim from the live listings on 2026-10-07; each store
// formats the tag differently (self-closing with a space, unclosed, bare host, full URL).

const { storeOf, parseDeveloperUrlMeta, developerHost } = require("../lib/app-domain");

// resolveAppDomain deliberately swallows lookup failures, so a stub that THROWS cannot
// prove a lookup was skipped — the throw is caught and the test passes either way.
// Record calls instead, and assert on the record.
function itunesSpy() {
  const calls = [];
  const lookup = async (identifier) => { calls.push(identifier); return null; };
  return { lookup, calls };
}

const LISTING = {
  roku: '<head><meta name="appstore:store_id" content="151908" />\n<meta name="appstore:developer_url" content="https://therokuchannel.roku.com/app-ads.txt" /></head>',
  lg: '<meta name="appstore:developer_url" content="http://lgchannels.com">\n<meta name="appstore:bundle_id" content="474301">',
  samsung: '<meta name="appstore:developer_url" content="paramount.com"/><meta name="appstore:store_id" content="G18229011675"/>'
};

test("storeOf identifies each store by exact host or true subdomain", () => {
  assert.equal(storeOf("https://channelstore.roku.com/details/151908"), "roku");
  assert.equal(storeOf("https://us.lgappstv.com/main/tvapp/detail?appId=474301"), "lg");
  assert.equal(storeOf("https://www.samsung.com/us/appstore/app/G18229011675"), "samsung");
  assert.equal(storeOf("https://www.amazon.com/dp/B07DBBTDBS"), "amazon");
  assert.equal(storeOf("https://apps.apple.com/us/app/paramount/id530168168"), "apple");
  assert.equal(storeOf("https://play.google.com/store/apps/details?id=com.a.b"), null);
  assert.equal(storeOf(null), null);
});

test("storeOf does not trust lookalike store hosts", () => {
  assert.equal(storeOf("https://channelstore.roku.com.evil.test/details/1"), null);
  assert.equal(storeOf("https://evilchannelstore.roku.com/details/1"), null);
  assert.equal(storeOf("https://notlgappstv.com/x"), null);
  assert.equal(storeOf("https://samsung.com.evil.test/us/appstore/app/G1"), null);
});

test("parseDeveloperUrlMeta reads the tag as each store actually serves it", () => {
  assert.equal(parseDeveloperUrlMeta(LISTING.roku), "https://therokuchannel.roku.com/app-ads.txt");
  assert.equal(parseDeveloperUrlMeta(LISTING.lg), "http://lgchannels.com");
  assert.equal(parseDeveloperUrlMeta(LISTING.samsung), "paramount.com");
});

test("parseDeveloperUrlMeta tolerates attribute order and quoting, and ignores other tags", () => {
  assert.equal(parseDeveloperUrlMeta(`<meta content='dev.example' NAME='appstore:developer_url'>`), "dev.example");
  assert.equal(parseDeveloperUrlMeta('<meta name="appstore:bundle_id" content="x.example">'), null);
  assert.equal(parseDeveloperUrlMeta("<html><title>no tag</title></html>"), null);
});

test("developerHost reduces bare hosts, scheme URLs and full file URLs to a host", () => {
  assert.equal(developerHost("paramount.com"), "paramount.com");
  assert.equal(developerHost("http://lgchannels.com"), "lgchannels.com");
  assert.equal(developerHost("https://therokuchannel.roku.com/app-ads.txt"), "therokuchannel.roku.com");
  assert.equal(developerHost(""), null);
  assert.equal(developerHost("not a host at all"), null);
});

for (const [store, app, html, expected] of [
  ["Roku", { bundle: "151908", storeurl: "https://channelstore.roku.com/details/151908" }, LISTING.roku, "therokuchannel.roku.com"],
  ["LG", { bundle: "474301", storeurl: "https://us.lgappstv.com/main/tvapp/detail?appId=474301" }, LISTING.lg, "lgchannels.com"],
  ["Samsung", { bundle: "G18229011675", storeurl: "https://www.samsung.com/us/appstore/app/G18229011675" }, LISTING.samsung, "paramount.com"]
]) {
  test(`a ${store} listing resolves from its appstore:developer_url tag, and never asks Apple`, async () => {
    const fetched = [];
    const itunes = itunesSpy();
    const result = await resolveAppDomain(
      { kind: "app", domain: null, ...app },
      { lookupItunes: itunes.lookup, lookupStorePage: async (url) => { fetched.push(url); return html; } }
    );

    assert.deepEqual(result, { domain: expected, resolvedFrom: "store-listing" });
    assert.deepEqual(fetched, [app.storeurl]);
    assert.deepEqual(itunes.calls, []);
  });
}

test("a store page that cannot be fetched (e.g. Amazon's bot wall) degrades to asking, and never asks Apple", async () => {
  const itunes = itunesSpy();
  const result = await resolveAppDomain(
    { kind: "app", domain: null, bundle: "firetv.filmrise", storeurl: "https://www.amazon.com/dp/B07DBBTDBS" },
    { lookupItunes: itunes.lookup, lookupStorePage: async () => { throw new Error("HTTP 500"); } }
  );

  assert.deepEqual(result, { domain: null, resolvedFrom: null });
  assert.deepEqual(itunes.calls, []);
});

test("a store page without the tag degrades to asking", async () => {
  const itunes = itunesSpy();
  const result = await resolveAppDomain(
    { kind: "app", domain: null, bundle: "151908", storeurl: "https://channelstore.roku.com/details/151908" },
    { lookupItunes: itunes.lookup, lookupStorePage: async () => "<html><title>Roku</title></html>" }
  );

  assert.deepEqual(result, { domain: null, resolvedFrom: null });
  assert.deepEqual(itunes.calls, []);
});

test("an http:// store URL is fetched over https", async () => {
  const itunes = itunesSpy();
  const fetched = [];
  await resolveAppDomain(
    { kind: "app", domain: null, bundle: "151908", storeurl: "http://channelstore.roku.com/details/151908" },
    { lookupItunes: itunes.lookup, lookupStorePage: async (url) => { fetched.push(url); return LISTING.roku; } }
  );

  assert.deepEqual(fetched, ["https://channelstore.roku.com/details/151908"]);
});

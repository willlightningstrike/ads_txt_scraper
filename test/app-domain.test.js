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

test("the curated map is consulted before iTunes when no store URL is supplied", async () => {
  const bundle = Object.keys(KNOWN_APP_DEVELOPER_DOMAINS)[0];
  const result = await resolveAppDomain({ kind: "app", domain: null, bundle }, {
    lookupItunes: neverCalled
  });

  assert.equal(result.resolvedFrom, "known-map");
});

const PLUTO_GOOGLE_URL = "https://play.google.com/store/apps/details?id=tv.pluto.android";

for (const [store, storeurl, html, resolvedFrom] of [
  ["google", PLUTO_GOOGLE_URL, '<meta name="appstore:developer_url" content="https://live.example/">', "store-listing"],
  ["amazon", "https://www.amazon.com/dp/B00KDSGIPK", '<meta name="appstore:developer_url" content="https://live.example/">', "store-listing"],
  ["vizio", "https://www.vizio.com/en/smart-tv-apps?appId=tv.pluto.android", '<div data-app-id="tv.pluto.android" data-developer-url="https://live.example/"></div>', "store-listing"],
  ["apple", "https://apps.apple.com/app/pluto/id12345", null, "itunes"]
]) {
  test(`an explicit ${store} listing takes priority over Pluto's package mapping`, async () => {
    const lookups = [], fetched = [];
    const result = await resolveAppDomain({ kind: "app", bundle: "tv.pluto.android", storeurl }, {
      lookupStorePage: async (url) => { fetched.push(url); return html; },
      lookupItunes: async () => "https://live.example/",
      onStoreLookup: (lookup) => lookups.push(lookup)
    });
    assert.deepEqual(result, { domain: "live.example", resolvedFrom });
    assert.equal(lookups.length, 1);
    assert.equal(lookups[0].store, store);
    assert.deepEqual(fetched, store === "apple" ? [] : [storeurl]);
  });
}

for (const failure of ["missing metadata", "fetch failure"]) {
  test(`Pluto's package mapping is used only after a Google Play ${failure}`, async () => {
    const fetched = [], lookups = [], apple = [];
    const result = await resolveAppDomain({ kind: "app", bundle: "tv.pluto.android", storeurl: PLUTO_GOOGLE_URL }, {
      lookupStorePage: async (url) => {
        fetched.push(url);
        if (failure === "fetch failure") throw new Error("network down");
        return "<html>No developer URL</html>";
      },
      lookupItunes: async (id) => { apple.push(id); return null; },
      onStoreLookup: (lookup) => lookups.push(lookup)
    });
    assert.deepEqual(result, { domain: "pluto.tv", resolvedFrom: "known-map" });
    assert.deepEqual(fetched, [PLUTO_GOOGLE_URL]);
    assert.deepEqual(lookups, [{ store: "google", url: PLUTO_GOOGLE_URL }]);
    assert.deepEqual(apple, []);
  });
}

test("cancelling Pluto's store lookup cannot return its package mapping", async () => {
  const controller = new AbortController();
  await assert.rejects(resolveAppDomain({ kind: "app", bundle: "tv.pluto.android", storeurl: PLUTO_GOOGLE_URL }, {
    signal: controller.signal,
    lookupStorePage: async () => { controller.abort(new Error("cancelled")); return "<html>No metadata</html>"; }
  }), /cancelled/);
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
  assert.equal(storeOf("https://play.google.com/store/apps/details?id=com.a.b"), "google");
  assert.equal(storeOf(null), null);
});

test("storeOf does not trust lookalike store hosts", () => {
  assert.equal(storeOf("https://channelstore.roku.com.evil.test/details/1"), null);
  assert.equal(storeOf("https://evilchannelstore.roku.com/details/1"), null);
  assert.equal(storeOf("https://notlgappstv.com/x"), null);
  assert.equal(storeOf("https://samsung.com.evil.test/us/appstore/app/G1"), null);
  assert.equal(storeOf("https://play.google.com.evil.test/store/apps/details?id=com.a.b"), null);
  assert.equal(storeOf("https://notplay.google.com/store/apps/details?id=com.a.b"), null);
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

const PHILO_GOOGLE_URL = "https://play.google.com/store/apps/details?id=com.philo.philo.google";
const PHILO_GOOGLE_HTML = require("node:fs").readFileSync(require("node:path").join(__dirname, "fixtures/google-play-philo.html"), "utf8");

for (const [store, app, html, expected] of [
  ["Google Play", { bundle: "com.philo.philo.google", storeurl: PHILO_GOOGLE_URL }, PHILO_GOOGLE_HTML, "help.philo.com"],
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

for (const failure of ["missing metadata", "fetch failure"]) {
  test(`Google Play ${failure} stays unresolved without querying Apple`, async () => {
    const itunes = itunesSpy();
    const lookedUp = [];
    const result = await resolveAppDomain({ kind: "app", bundle: "com.philo.philo.google", storeurl: PHILO_GOOGLE_URL }, {
      lookupItunes: itunes.lookup,
      onStoreLookup: (lookup) => lookedUp.push(lookup),
      lookupStorePage: async () => {
        if (failure === "fetch failure") throw new Error("HTTP 503");
        return '<meta name="appstore:developer_url" content="">';
      }
    });
    assert.deepEqual(result, { domain: null, resolvedFrom: null });
    assert.deepEqual(lookedUp, [{ store: "google", url: PHILO_GOOGLE_URL }]);
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

// LG's Philo listing and retrieveAppInfo.ajax both omit devUrl (2026-10-20).
const PHILO_LG_URL = "https://us.lgappstv.com/main/tvapp/detail?appId=1244756";
const EMPTY_LG_METADATA = '<meta name="appstore:developer_url" content=""><meta name="appstore:bundle_id" content=""><meta name="appstore:store_id" content="">';

test("the supplied LG Philo request resolves when LG omits developer metadata", async () => {
  const itunes = itunesSpy();
  const fetched = [];
  const result = await resolveAppDomain({ kind: "app", bundle: "1244756", storeurl: PHILO_LG_URL }, {
    lookupItunes: itunes.lookup,
    lookupStorePage: async (url) => { fetched.push(url); return EMPTY_LG_METADATA; }
  });
  assert.deepEqual(result, { domain: "philo.com", resolvedFrom: "known-map" });
  assert.deepEqual(fetched, [PHILO_LG_URL]);
  assert.deepEqual(itunes.calls, []);
});

test("LG's listing ID supplies the Philo fallback without a numeric bundle", async () => {
  for (const bundle of [null, "com.philo.lg"]) {
    const result = await resolveAppDomain({ kind: "app", bundle, storeurl: PHILO_LG_URL }, {
      lookupStorePage: async () => EMPTY_LG_METADATA
    });
    assert.deepEqual(result, { domain: "philo.com", resolvedFrom: "known-map" });
  }
});

test("a failed LG request can use the verified Philo fallback", async () => {
  const result = await resolveAppDomain({ kind: "app", bundle: "1244756", storeurl: PHILO_LG_URL }, {
    lookupStorePage: async () => { throw new Error("connection reset"); }
  });
  assert.deepEqual(result, { domain: "philo.com", resolvedFrom: "known-map" });
});

test("live LG developer metadata takes precedence over the fallback", async () => {
  const result = await resolveAppDomain({ kind: "app", bundle: "1244756", storeurl: PHILO_LG_URL }, {
    lookupStorePage: async () => '<meta name="appstore:developer_url" content="https://new-developer.example">'
  });
  assert.deepEqual(result, { domain: "new-developer.example", resolvedFrom: "store-listing" });
});

test("conflicting numeric LG bundle and listing IDs do not resolve either app", async () => {
  for (const [bundle, storeurl] of [
    ["1234567", PHILO_LG_URL],
    ["1244756", "https://us.lgappstv.com/main/tvapp/detail?appId=474301"]
  ]) {
    const fetched = [];
    const result = await resolveAppDomain({ kind: "app", bundle, storeurl }, {
      lookupStorePage: async (url) => { fetched.push(url); return LISTING.lg; }
    });
    assert.deepEqual(result, { domain: null, resolvedFrom: null });
    assert.deepEqual(fetched, []);
  }
});

test("the Philo fallback requires an unambiguous LG detail listing", async () => {
  for (const storeurl of [
    null,
    "https://apps.apple.com/us/app/id1244756",
    "https://channelstore.roku.com/details/1244756",
    "https://us.lgappstv.com.evil.test/main/tvapp/detail?appId=1244756",
    "https://notlgappstv.com/main/tvapp/detail?appId=1244756",
    "https://us.lgappstv.com/main/tvapp?appId=1244756",
    "https://us.lgappstv.com/main/tvapp/detail",
    "https://us.lgappstv.com/main/tvapp/detail?appId=1244756&appId=474301",
    "ftp://us.lgappstv.com/main/tvapp/detail?appId=1244756"
  ]) {
    const result = await resolveAppDomain({ kind: "app", bundle: "1244756", storeurl }, {
      lookupItunes: async () => null, lookupStorePage: async () => EMPTY_LG_METADATA
    });
    assert.deepEqual(result, { domain: null, resolvedFrom: null }, String(storeurl));
  }
});

test("an unknown LG app with empty metadata remains unresolved", async () => {
  const itunes = itunesSpy();
  const result = await resolveAppDomain({ kind: "app", bundle: "1234567", storeurl: "https://us.lgappstv.com/main/tvapp/detail?appId=1234567" }, {
    lookupItunes: itunes.lookup, lookupStorePage: async () => EMPTY_LG_METADATA
  });
  assert.deepEqual(result, { domain: null, resolvedFrom: null });
  assert.deepEqual(itunes.calls, []);
});

test("cancelling an LG lookup cannot return the Philo fallback", async () => {
  const controller = new AbortController();
  await assert.rejects(resolveAppDomain({ kind: "app", bundle: "1244756", storeurl: PHILO_LG_URL }, {
    signal: controller.signal,
    lookupStorePage: async () => { controller.abort(new Error("cancelled")); return EMPTY_LG_METADATA; }
  }), /cancelled/);
});

// Tubi's own devices page links this ASIN, and tubitv.com serves app-ads.txt.
// Amazon may return a successful HTTP response containing only its shopping gate.
const TUBI_STORE_URL = "https://www.amazon.com/Tubi-Inc/dp/B075NTHVJW/";
const AMAZON_GATE = '<html><title>Amazon.com</title><form action="/errors_page/validateCaptcha">Continue shopping</form></html>';

test("existing CTV package mappings still resolve with a blocked Amazon listing", async () => {
  const itunes = itunesSpy();
  const fetched = [];
  const result = await resolveAppDomain({ kind: "app", bundle: "tv.pluto.android", storeurl: "https://www.amazon.com/dp/B00KDSGIPK" }, {
    lookupItunes: itunes.lookup, lookupStorePage: async (url) => { fetched.push(url); return AMAZON_GATE; }
  });
  assert.deepEqual(result, { domain: "pluto.tv", resolvedFrom: "known-map" });
  assert.deepEqual(fetched, ["https://www.amazon.com/dp/B00KDSGIPK"]);
  assert.deepEqual(itunes.calls, []);
});

test("the supplied Fire TV request resolves Tubi when Amazon returns its shopping gate", async () => {
  const itunes = itunesSpy();
  const result = await resolveAppDomain(
    { kind: "app", bundle: "B075NTHVJW", storeurl: TUBI_STORE_URL },
    { lookupItunes: itunes.lookup, lookupStorePage: async () => AMAZON_GATE }
  );
  assert.deepEqual(result, { domain: "tubitv.com", resolvedFrom: "known-map" });
  assert.deepEqual(itunes.calls, []);
});

test("a failed Amazon request can use a verified ASIN fallback", async () => {
  const result = await resolveAppDomain(
    { kind: "app", bundle: "B075NTHVJW", storeurl: TUBI_STORE_URL },
    { lookupStorePage: async () => { throw new Error("HTTP 503"); } }
  );
  assert.deepEqual(result, { domain: "tubitv.com", resolvedFrom: "known-map" });
});

test("a lowercase Fire TV bundle alone is looked up on Amazon, not Apple", async () => {
  const itunes = itunesSpy();
  const fetched = [];
  const result = await resolveAppDomain({ kind: "app", bundle: "b012345678" }, {
    lookupItunes: itunes.lookup,
    lookupStorePage: async (url) => {
      fetched.push(url);
      return '<body><meta name="appstore:developer_url" content="https://developer.example/"></body>';
    }
  });
  assert.deepEqual(result, { domain: "developer.example", resolvedFrom: "store-listing" });
  assert.deepEqual(fetched, ["https://www.amazon.com/dp/B012345678"]);
  assert.deepEqual(itunes.calls, []);
});

test("a known lowercase ASIN alone still resolves when its listing is blocked", async () => {
  const result = await resolveAppDomain({ kind: "app", bundle: "b075nthvjw" }, {
    lookupItunes: async () => null, lookupStorePage: async () => AMAZON_GATE
  });
  assert.deepEqual(result, { domain: "tubitv.com", resolvedFrom: "known-map" });
});

test("Amazon product and deep-link URLs supply the ASIN without a bundle", async () => {
  for (const storeurl of [TUBI_STORE_URL, "https://www.amazon.com/dp/b075nthvjw", "https://www.amazon.com/gp/product/B075NTHVJW/ref=test", "http://www.amazon.com/gp/mas/dl/android?asin=B075NTHVJW"]) {
    const itunes = itunesSpy();
    const result = await resolveAppDomain({ kind: "app", storeurl }, {
      lookupItunes: itunes.lookup, lookupStorePage: async () => AMAZON_GATE
    });
    assert.deepEqual(result, { domain: "tubitv.com", resolvedFrom: "known-map" }, storeurl);
    assert.deepEqual(itunes.calls, []);
  }
});

test("live Amazon developer metadata takes precedence over the verified fallback", async () => {
  const result = await resolveAppDomain({ kind: "app", bundle: "B075NTHVJW", storeurl: TUBI_STORE_URL }, {
    lookupStorePage: async () => '<meta name="appstore:developer_url" content="https://new-developer.example/">'
  });
  assert.deepEqual(result, { domain: "new-developer.example", resolvedFrom: "store-listing" });
});

test("an unknown ASIN without a store URL never falls through to Apple", async () => {
  const itunes = itunesSpy();
  const result = await resolveAppDomain({ kind: "app", bundle: "B012345678" }, {
    lookupItunes: itunes.lookup, lookupStorePage: async () => AMAZON_GATE
  });
  assert.equal(result.domain, null);
  assert.equal(result.resolvedFrom, null);
  assert.equal(result.resolutionError?.code, "amazon_challenge");
  assert.deepEqual(itunes.calls, []);
});

test("an Amazon shopping or verification gate is explained when no fallback exists", async () => {
  for (const html of [AMAZON_GATE, "<html><title>Robot Check</title></html>"]) {
    const result = await resolveAppDomain({ kind: "app", bundle: "firetv.fawesome.tv", storeurl: "https://www.amazon.com/dp/B076X8FKXP" }, {
      lookupStorePage: async () => html
    });
    assert.equal(result.domain, null);
    assert.equal(result.resolutionError?.code, "amazon_challenge");
    assert.match(result.resolutionError.message, /Amazon.*shopping or verification page/);
  }
});

test("ordinary shopping text is not mistaken for an Amazon challenge", async () => {
  const result = await resolveAppDomain({ kind: "app", bundle: "B012345678" }, {
    lookupStorePage: async () => "<html><title>App details</title><a>Continue shopping</a></html>"
  });
  assert.deepEqual(result, { domain: null, resolvedFrom: null });
});

test("usable Amazon metadata wins even if the page contains a challenge form", async () => {
  const result = await resolveAppDomain({ kind: "app", bundle: "B012345678" }, {
    lookupStorePage: async () => `${AMAZON_GATE}<meta name="appstore:developer_url" content="futuretodayinc.com">`
  });
  assert.deepEqual(result, { domain: "futuretodayinc.com", resolvedFrom: "store-listing" });
});

test("conflicting Amazon bundle and listing ASINs cannot select either app's domain", async () => {
  const result = await resolveAppDomain({ kind: "app", bundle: "B012345678", storeurl: TUBI_STORE_URL }, {
    lookupStorePage: async () => '<meta name="appstore:developer_url" content="tubitv.com">'
  });
  assert.deepEqual(result, { domain: null, resolvedFrom: null });
});

test("a Fire TV fallback is not applied to another store or a lookalike Amazon host", async () => {
  for (const storeurl of ["https://amazon.com.evil.test/dp/B075NTHVJW", "https://notamazon.com/dp/B075NTHVJW", "https://channelstore.roku.com/details/B075NTHVJW", "https://www.amazon.com/search?asin=B075NTHVJW"]) {
    const result = await resolveAppDomain({ kind: "app", bundle: "B075NTHVJW", storeurl }, {
      lookupItunes: async () => null, lookupStorePage: async () => AMAZON_GATE
    });
    assert.equal(result.domain, null, storeurl);
    assert.equal(result.resolvedFrom, null, storeurl);
  }
});

test("cancelling an Amazon lookup does not return a mapped success", async () => {
  const controller = new AbortController();
  await assert.rejects(resolveAppDomain({ kind: "app", bundle: "B075NTHVJW", storeurl: TUBI_STORE_URL }, {
    signal: controller.signal,
    lookupStorePage: async () => { controller.abort(new Error("cancelled")); return AMAZON_GATE; }
  }), /cancelled/);
});

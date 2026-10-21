const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveAppDomain, storeOf } = require("../lib/app-domain");

const catalog = fs.readFileSync(path.join(__dirname, "fixtures/vizio-catalog.html"), "utf8");
const storeurl = "https://www.vizio.com/en/smart-tv-apps?appName=paramountplus&appId=vizio.paramountplus";
const origin = { kind: "app", bundle: "vizio.paramountplus", storeurl };
const watchfreeCatalog = fs.readFileSync(path.join(__dirname, "fixtures/vizio-watchfree.html"), "utf8");
const watchfree = { kind: "app", bundle: "vizio.watchfree", storeurl: "https://www.vizio.com/en/smart-tv-apps?appName=watchfree&appId=vizio.watchfree" };

test("WatchFree+ resolves through its verified mapping when matching catalog entries omit the developer URL", async () => {
  for (const app of [watchfree, { ...watchfree, bundle: null }, { ...watchfree, storeurl: "https://www.vizio.com/en/smart-tv-apps" }]) {
    const lookups = [], apple = [];
    const result = await resolveAppDomain(app, {
      lookupStorePage: async () => catalog + watchfreeCatalog + watchfreeCatalog,
      onStoreLookup: (lookup) => lookups.push(lookup),
      lookupItunes: async (id) => { apple.push(id); return null; }
    });
    assert.deepEqual(result, { domain: "www.vizio.com", resolvedFrom: "known-map" });
    assert.deepEqual(lookups, [{ store: "vizio", url: app.storeurl }]);
    assert.deepEqual(apple, []);
  }
});

test("WatchFree+ live developer metadata takes precedence over its verified mapping", async () => {
  const live = watchfreeCatalog.replace('data-app-id="vizio.watchfree"', 'data-app-id="vizio.watchfree" data-developer-url="https://live.example/"');
  for (const html of [live, live + watchfreeCatalog, watchfreeCatalog + live]) {
    const result = await resolveAppDomain(watchfree, { lookupStorePage: async () => html });
    assert.deepEqual(result, { domain: "live.example", resolvedFrom: "store-listing" });
  }
});

test("the WatchFree+ mapping cannot resolve unknown apps or mismatched listing identifiers", async () => {
  for (const app of [
    { ...watchfree, bundle: "vizio.unknown" },
    { ...watchfree, storeurl: watchfree.storeurl.replace("appId=vizio.watchfree", "appId=vizio.unknown") },
    { ...watchfree, storeurl: watchfree.storeurl.replace("appName=watchfree", "appName=other") },
    { ...watchfree, storeurl: `${watchfree.storeurl}&appId=vizio.watchfree` },
    { ...watchfree, storeurl: "https://www.vizio.com/en/other-page?appId=vizio.watchfree" }
  ]) {
    assert.deepEqual(await resolveAppDomain(app, { lookupStorePage: async () => catalog + watchfreeCatalog }), { domain: null, resolvedFrom: null });
  }
  const unknown = { ...watchfree, bundle: "vizio.unknown", storeurl: "https://www.vizio.com/en/smart-tv-apps?appName=unknown&appId=vizio.unknown" };
  const unknownEntry = watchfreeCatalog.replaceAll("vizio.watchfree", "vizio.unknown").replace('data-app-name="watchfree"', 'data-app-name="unknown"');
  assert.deepEqual(await resolveAppDomain(unknown, { lookupStorePage: async () => unknownEntry }), { domain: null, resolvedFrom: null });
});

test("the WatchFree+ mapping requires an actual live catalog entry", async () => {
  const markup = watchfreeCatalog.replace(/<!--[\s\S]*?-->/g, "");
  for (const html of [catalog, `<!--${markup}-->`, `<script>${JSON.stringify(markup)}</script>`]) {
    assert.deepEqual(await resolveAppDomain(watchfree, { lookupStorePage: async () => html }), { domain: null, resolvedFrom: null });
  }
  assert.deepEqual(await resolveAppDomain(watchfree, { lookupStorePage: async () => { throw new Error("connection reset"); } }), { domain: null, resolvedFrom: null });
});

test("WatchFree+ invalid or conflicting metadata cannot be hidden by the fallback", async () => {
  const withUrl = (url) => watchfreeCatalog.replace('data-app-id="vizio.watchfree"', `data-app-id="vizio.watchfree" data-developer-url="${url}"`);
  for (const html of [
    withUrl("javascript:alert(1)"), withUrl("ftp://wrong.example/"),
    withUrl("https://one.example/") + withUrl("https://two.example/"),
    watchfreeCatalog.replace('data-app-id="vizio.watchfree"', 'data-app-id="vizio.watchfree" data-app-id="vizio.other"')
  ]) {
    assert.deepEqual(await resolveAppDomain(watchfree, { lookupStorePage: async () => watchfreeCatalog + html }), { domain: null, resolvedFrom: null });
  }
});

test("cancelling a WatchFree+ catalog lookup cannot return the verified mapping", async () => {
  const controller = new AbortController();
  await assert.rejects(resolveAppDomain(watchfree, {
    signal: controller.signal,
    lookupStorePage: async () => { controller.abort(new Error("cancelled")); return watchfreeCatalog; }
  }), /cancelled/);
});

test("Vizio store recognition rejects lookalike hosts", () => {
  assert.equal(storeOf(storeurl), "vizio");
  assert.equal(storeOf("https://vizio.com/en/smart-tv-apps"), "vizio");
  assert.equal(storeOf("https://notvizio.com/en/smart-tv-apps"), null);
  assert.equal(storeOf("https://www.vizio.com.evil.test/en/smart-tv-apps"), null);
});

test("Vizio Paramount+ resolves the matching catalog entry without an Apple lookup", async () => {
  const fetched = [], apple = [], lookups = [];
  const result = await resolveAppDomain(origin, {
    lookupStorePage: async (url) => { fetched.push(url); return catalog; },
    lookupItunes: async (id) => { apple.push(id); return null; },
    onStoreLookup: (lookup) => lookups.push(lookup)
  });
  assert.deepEqual(result, { domain: "www.paramount.com", resolvedFrom: "store-listing" });
  assert.deepEqual(fetched, [storeurl]);
  assert.deepEqual(lookups, [{ store: "vizio", url: storeurl }]);
  assert.deepEqual(apple, []);
});

test("Vizio accepts its published bundle alias, app ID alone, or a bundle on the catalog URL", async () => {
  for (const app of [
    { ...origin, bundle: "vizio.paramount+" },
    { ...origin, bundle: null },
    { ...origin, storeurl: "https://www.vizio.com/en/smart-tv-apps" }
  ]) {
    const result = await resolveAppDomain(app, { lookupStorePage: async () => catalog });
    assert.equal(result.domain, "www.paramount.com");
  }
});

test("Vizio resolution uses live app metadata rather than a Paramount-specific mapping", async () => {
  const result = await resolveAppDomain({ ...origin, bundle: "vizio.other", storeurl: "https://www.vizio.com/en/smart-tv-apps?appId=vizio.other" }, {
    lookupStorePage: async () => catalog
  });
  assert.deepEqual(result, { domain: "other.example", resolvedFrom: "store-listing" });
});

test("unknown Vizio apps remain unresolved and never fall back to Apple", async () => {
  const apple = [];
  const result = await resolveAppDomain({ ...origin, bundle: "vizio.unknown", storeurl: "https://www.vizio.com/en/smart-tv-apps?appId=vizio.unknown" }, {
    lookupStorePage: async () => catalog,
    lookupItunes: async (id) => { apple.push(id); return "https://unrelated.example"; }
  });
  assert.deepEqual(result, { domain: null, resolvedFrom: null });
  assert.deepEqual(apple, []);
});

test("conflicting or ambiguous Vizio identifiers cannot select a different catalog app", async () => {
  for (const app of [
    { ...origin, bundle: "vizio.other" },
    { ...origin, storeurl: `${storeurl}&appId=vizio.other` },
    { ...origin, storeurl: `${storeurl}&appName=other` },
    { ...origin, storeurl: storeurl.replace("appName=paramountplus", "appName=other") },
    { ...origin, storeurl: "https://www.vizio.com/en/smart-tv-apps?appId=" },
    { ...origin, storeurl: "https://www.vizio.com/en/other-page?appId=vizio.paramountplus" },
    { ...origin, storeurl: storeurl.replace("https:", "ftp:") },
    { ...origin, bundle: null, storeurl: "https://www.vizio.com/en/smart-tv-apps?appName=paramountplus" }
  ]) {
    const apple = [];
    const result = await resolveAppDomain(app, {
      lookupStorePage: async () => catalog,
      lookupItunes: async (id) => { apple.push(id); return null; }
    });
    assert.deepEqual(result, { domain: null, resolvedFrom: null }, JSON.stringify(app));
    assert.deepEqual(apple, []);
  }
});

test("Vizio requires a usable developer URL on the identified app entry", async () => {
  for (const html of [
    '<meta name="appstore:developer_url" content="https://unrelated.example">',
    catalog.replace('data-developer-url="https://www.paramount.com/"', 'data-developer-url=""'),
    catalog.replace('data-developer-url="https://www.paramount.com/"', 'data-developer-url="javascript:alert(1)"'),
    catalog.replace('data-developer-url="https://www.paramount.com/"', 'data-developer-url="ftp://wrong.example/"')
  ]) {
    const result = await resolveAppDomain(origin, { lookupStorePage: async () => html, lookupItunes: async () => null });
    assert.deepEqual(result, { domain: null, resolvedFrom: null });
  }
});

test("duplicate catalog layouts agree on the developer, conflicting entries stay unresolved", async () => {
  const options = { lookupItunes: async () => null };
  const duplicate = await resolveAppDomain(origin, { ...options, lookupStorePage: async () => catalog + catalog });
  assert.equal(duplicate.domain, "www.paramount.com");
  const conflicting = await resolveAppDomain(origin, { ...options, lookupStorePage: async () => catalog + catalog.replace('https://www.paramount.com/', 'https://different.example/') });
  assert.equal(conflicting.domain, null);
});

test("Vizio ignores app-shaped markup in comments and scripts", async () => {
  const markup = catalog.replace(/<!--[\s\S]*?-->/g, "");
  const result = await resolveAppDomain(origin, {
    lookupStorePage: async () => `<!--${markup}--><script>const template = ${JSON.stringify(markup)};</script>`,
    lookupItunes: async () => null
  });
  assert.equal(result.domain, null);
});

test("a failed Vizio fetch remains unresolved without querying Apple", async () => {
  const apple = [];
  const result = await resolveAppDomain(origin, {
    lookupStorePage: async () => { throw new Error("connection reset"); },
    lookupItunes: async (id) => { apple.push(id); return null; }
  });
  assert.deepEqual(result, { domain: null, resolvedFrom: null });
  assert.deepEqual(apple, []);
});

test("cancelling the Vizio catalog lookup cannot return a developer domain", async () => {
  const controller = new AbortController();
  await assert.rejects(resolveAppDomain(origin, {
    signal: controller.signal,
    lookupItunes: async () => null,
    lookupStorePage: async () => { controller.abort(new Error("cancelled")); return catalog; }
  }), /cancelled/);
});

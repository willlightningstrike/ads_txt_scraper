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

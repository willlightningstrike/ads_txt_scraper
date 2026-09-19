const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const dns = require("dns");

const { app } = require("../server");

const SCHAIN = { ver: "1.0", complete: 1, nodes: [{ asi: "exchange-a.com", sid: "12345" }] };

const ADS_TXT = "exchange-a.com, 12345, DIRECT\n";
const SELLERS_JSON = JSON.stringify({
  sellers: [{ seller_id: "12345", name: "Daily News", domain: "dailynews.example", seller_type: "PUBLISHER" }]
});

const realGet = axios.get;
const realDnsLookup = dns.promises.lookup;

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  axios.get = realGet;
  dns.promises.lookup = realDnsLookup;
  server.close();
});

test.afterEach(() => {
  axios.get = realGet;
  dns.promises.lookup = realDnsLookup;
});

const STUBBED_HOSTNAMES = new Set(["dailynews.example", "exchange-a.com", "partner.example"]);

// Stubs the outbound fetches only. axios.post is untouched, so the test client still works.
// dailynews.example (RFC 2606 reserved) and exchange-a.com (unregistered) never resolve
// over real DNS, so the lookup validateExternalUrl performs is stubbed too, for those
// hostnames only — every other hostname (e.g. the real itunes.apple.com lookup exercised
// elsewhere in this file) still resolves for real.
// adsTxtByHost lets one host serve a different ads.txt than another, which the
// inventory-partner tests need; failHosts makes a host's fetch throw.
function stubOutbound({ adsTxtByHost = null, failHosts = [] } = {}) {
  axios.get = async (url) => {
    const host = new URL(url).hostname;
    if (failHosts.includes(host)) {
      throw new Error(`connection refused to ${host}`);
    }
    // Matches both /ads.txt and /app-ads.txt — origin.file is "app-ads.txt" for
    // app-kind bid requests, and a plain "/ads.txt" substring check misses that path.
    if (/\/(app-)?ads\.txt$/.test(url)) {
      const data = adsTxtByHost && host in adsTxtByHost ? adsTxtByHost[host] : ADS_TXT;
      return { status: 200, data, headers: {}, request: { res: { responseUrl: url } } };
    }
    if (url.includes("/sellers.json")) {
      return { status: 200, data: SELLERS_JSON, headers: {}, request: { res: { responseUrl: url } } };
    }
    throw new Error(`unexpected outbound request to ${url}`);
  };

  dns.promises.lookup = async (hostname, options) => {
    if (STUBBED_HOSTNAMES.has(hostname)) {
      return [{ address: "93.184.216.34", family: 4 }];
    }
    return realDnsLookup(hostname, options);
  };
}

test("a site bid request is audited without an ads.txt URL", async () => {
  stubOutbound();

  const response = await axios.post(`${baseUrl}/api/audit-chain`, {
    bidRequest: { site: { domain: "dailynews.example" }, source: { ext: { schain: SCHAIN } } }
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.origin.domain, "dailynews.example");
  assert.equal(response.data.hops.length, 1);
  assert.equal(response.data.verdict, "pass");
});

test("a request with no schain is rejected with guidance rather than audited", async () => {
  const response = await axios.post(
    `${baseUrl}/api/audit-chain`,
    { bidRequest: { site: { domain: "dailynews.example" } } },
    { validateStatus: () => true }
  );

  assert.equal(response.status, 422);
  assert.equal(response.data.reason, "no_schain");
  assert.match(response.data.error, /supply chain/i);
});

test("an app request with no resolvable domain asks for one", async () => {
  // Stubbed so the unmapped bundle's itunes.apple.com lookup hits the stub's
  // "unexpected outbound request" throw instead of a live network call. resolveAppDomain
  // swallows that into the same domain:null result, so the assertions below are unchanged.
  stubOutbound();

  const response = await axios.post(
    `${baseUrl}/api/audit-chain`,
    {
      bidRequest: {
        app: { bundle: "com.unmapped.app", storeurl: "https://example.com/app" },
        source: { ext: { schain: SCHAIN } }
      }
    },
    { validateStatus: () => true }
  );

  assert.equal(response.status, 422);
  assert.equal(response.data.reason, "origin_domain_required");
  assert.equal(response.data.origin.file, "app-ads.txt");
});

test("originDomainOverride supplies the missing app domain", async () => {
  stubOutbound();

  const response = await axios.post(`${baseUrl}/api/audit-chain`, {
    bidRequest: {
      app: { bundle: "com.unmapped.app" },
      source: { ext: { schain: SCHAIN } }
    },
    originDomainOverride: "dailynews.example"
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.origin.domain, "dailynews.example");
  assert.equal(response.data.origin.resolvedFrom, "user");
});

test("origin.domain reports the domain actually audited, not the raw override", async () => {
  stubOutbound();

  const response = await axios.post(`${baseUrl}/api/audit-chain`, {
    bidRequest: {
      app: { bundle: "com.unmapped.app" },
      source: { ext: { schain: SCHAIN } }
    },
    // A stray path segment on the override must not leak into the reported origin —
    // the URL actually fetched and audited is https://dailynews.example/ignored/app-ads.txt,
    // whose hostname is dailynews.example, not "dailynews.example/ignored".
    originDomainOverride: "dailynews.example/ignored"
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.origin.domain, "dailynews.example");
});

test("a missing bidRequest body is a 400", async () => {
  const response = await axios.post(
    `${baseUrl}/api/audit-chain`,
    {},
    { validateStatus: () => true }
  );

  assert.equal(response.status, 400);
});

test("an originDomainOverride pointing at a private address is refused", async () => {
  const response = await axios.post(
    `${baseUrl}/api/audit-chain`,
    {
      bidRequest: { app: { bundle: "com.unmapped.app" }, source: { ext: { schain: SCHAIN } } },
      originDomainOverride: "127.0.0.1"
    },
    { validateStatus: () => true }
  );

  assert.equal(response.status, 400);
  assert.match(response.data.error, /private|loopback|local/i);
});

// This is the exact thing the per-route parser ruling turned on: a limit sitting behind
// a global parser is dead code, because the global one would 413 the request first.
test("a body over 100kb still reaches /api/audit-chain's route logic", async () => {
  const padding = "x".repeat(150 * 1024);

  const response = await axios.post(
    `${baseUrl}/api/audit-chain`,
    { bidRequest: { site: { domain: "dailynews.example", name: padding } } },
    { validateStatus: () => true }
  );

  assert.equal(response.status, 422);
  assert.equal(response.data.reason, "no_schain");
});

test("a body over 100kb to /api/validate is rejected with 413, as JSON rather than an HTML stack trace", async () => {
  const padding = "x".repeat(150 * 1024);

  const response = await axios.post(
    `${baseUrl}/api/validate`,
    { adsTxtUrl: "https://example.com/ads.txt", accountId: "acct-1", padding },
    { validateStatus: () => true }
  );

  assert.equal(response.status, 413);
  assert.match(response.headers["content-type"], /application\/json/);
  assert.equal(typeof response.data.error, "string");
  assert.ok(!response.data.error.includes("node_modules"));
});

// --- inventorypartnerdomain: a two-file audit ---
// The owner's ads.txt must declare INVENTORYPARTNERDOMAIN=<partner>; the schain is then
// checked against the union of the owner's and the partner's entries.

const PARTNER_REQUEST = {
  site: { domain: "dailynews.example", inventorypartnerdomain: "partner.example" },
  source: { ext: { schain: SCHAIN } }
};

test("a declared inventory partner's ads.txt authorizes the schain", async () => {
  stubOutbound({ adsTxtByHost: {
    "dailynews.example": "INVENTORYPARTNERDOMAIN=partner.example\nother.com, 1, DIRECT\n",
    "partner.example": "exchange-a.com, 12345, DIRECT\n"
  } });

  const response = await axios.post(`${baseUrl}/api/audit-chain`, { bidRequest: PARTNER_REQUEST });

  assert.equal(response.status, 200);
  assert.equal(response.data.verdict, "pass");
  const check = response.data.hops[0].checks.adsTxtDeclared;
  assert.equal(check.status, "pass");
  assert.match(check.message, /partner\.example\/ads\.txt/);
  const adsTxtSources = response.data.sources.filter((s) => s.kind === "ads-txt").map((s) => s.url);
  assert.deepEqual(adsTxtSources, ["https://dailynews.example/ads.txt", "https://partner.example/ads.txt"]);
  assert.equal(response.data.chainChecks.some((c) => c.code === "inventory_partner_undeclared"), false);
});

test("an inventory partner the owner never declared breaks the chain", async () => {
  stubOutbound({ adsTxtByHost: {
    "dailynews.example": "other.com, 1, DIRECT\n",
    "partner.example": "exchange-a.com, 12345, DIRECT\n"
  } });

  const response = await axios.post(`${baseUrl}/api/audit-chain`, { bidRequest: PARTNER_REQUEST });

  assert.equal(response.status, 200);
  const check = response.data.chainChecks.find((c) => c.code === "inventory_partner_undeclared");
  assert.equal(check.status, "fail");
  assert.match(check.message, /INVENTORYPARTNERDOMAIN=partner\.example/);
  assert.equal(response.data.verdict, "broken");
  assert.equal(response.data.firstFailedHop, null);
});

test("the owner's own entries still count when the partner file does not list the seller", async () => {
  stubOutbound({ adsTxtByHost: {
    "dailynews.example": "INVENTORYPARTNERDOMAIN=partner.example\nexchange-a.com, 12345, DIRECT\n",
    "partner.example": "other.com, 9, DIRECT\n"
  } });

  const response = await axios.post(`${baseUrl}/api/audit-chain`, { bidRequest: PARTNER_REQUEST });

  assert.equal(response.status, 200);
  const check = response.data.hops[0].checks.adsTxtDeclared;
  assert.equal(check.status, "pass");
  assert.match(check.message, /dailynews\.example\/ads\.txt/);
  assert.equal(response.data.verdict, "pass");
});

test("an unreachable partner file is a warning, and the owner's entries are still audited", async () => {
  stubOutbound({
    adsTxtByHost: { "dailynews.example": "INVENTORYPARTNERDOMAIN=partner.example\nexchange-a.com, 12345, DIRECT\n" },
    failHosts: ["partner.example"]
  });

  const response = await axios.post(`${baseUrl}/api/audit-chain`, { bidRequest: PARTNER_REQUEST });

  assert.equal(response.status, 200);
  const check = response.data.chainChecks.find((c) => c.code === "inventory_partner_unreachable");
  assert.equal(check.status, "warn");
  assert.equal(response.data.hops[0].checks.adsTxtDeclared.status, "pass");
  assert.equal(response.data.verdict, "pass");
});

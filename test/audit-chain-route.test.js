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

const STUBBED_HOSTNAMES = new Set(["dailynews.example", "exchange-a.com"]);

// Stubs the outbound fetches only. axios.post is untouched, so the test client still works.
// dailynews.example (RFC 2606 reserved) and exchange-a.com (unregistered) never resolve
// over real DNS, so the lookup validateExternalUrl performs is stubbed too, for those
// hostnames only — every other hostname (e.g. the real itunes.apple.com lookup exercised
// elsewhere in this file) still resolves for real.
function stubOutbound() {
  axios.get = async (url) => {
    // Matches both /ads.txt and /app-ads.txt — origin.file is "app-ads.txt" for
    // app-kind bid requests, and a plain "/ads.txt" substring check misses that path.
    if (/\/(app-)?ads\.txt$/.test(url)) {
      return { status: 200, data: ADS_TXT, headers: {}, request: { res: { responseUrl: url } } };
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

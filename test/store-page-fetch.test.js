const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const dns = require("node:dns");
const { gzipSync } = require("node:zlib");
const axios = require("axios");

const { resolveAppDomain } = require("../lib/app-domain");
const { fetchText, fetchJsonText } = require("../lib/http-client");

const realGet = axios.get;
const realLookup = dns.promises.lookup;
const AMAZON_ORIGIN = { kind: "app", bundle: "firetv.fawesome.tv", storeurl: "https://www.amazon.com/dp/B076X8FKXP" };
let server;
let fixtureUrl;
let body;
let headers;
let requested;
let redirect;

test.before(async () => {
  server = http.createServer((req, res) => {
    requested.push(req.url);
    if (redirect && req.url === "/start") {
      res.writeHead(302, { Location: redirect });
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixtureUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(() => {
  body = "";
  headers = {};
  requested = [];
  redirect = null;
  dns.promises.lookup = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "93.184.216.35", family: 4 }
  ];
  // Only the destination is replaced. Axios still downloads and decompresses the
  // fixture over a real socket using the production size limits and abort signal.
  axios.get = (url, options) => realGet(`${fixtureUrl}${new URL(url).pathname}`, options);
});

test.afterEach(() => {
  axios.get = realGet;
  dns.promises.lookup = realLookup;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

function largeListing(domain) {
  // Metadata beyond the old 512 KiB cap proves the complete listing was read.
  return `<!--${"x".repeat(1300 * 1024)}--><meta name="appstore:developer_url" content="https://${domain}/">`;
}

for (const [name, origin, domain] of [
  ["Fawesome", AMAZON_ORIGIN, "futuretodayinc.com"],
  ["FilmRise", { kind: "app", bundle: "firetv.filmrise", storeurl: "https://www.amazon.com/dp/B07DBBTDBS" }, "futuretodayinc.com"],
  ["Tubi", { kind: "app", bundle: "B075NTHVJW", storeurl: "https://www.amazon.com/Tubi-Inc/dp/B075NTHVJW/" }, "tubitv.com"],
  ["Roku", { kind: "app", bundle: "151908", storeurl: "https://channelstore.roku.com/details/151908" }, "therokuchannel.roku.com"]
]) {
  test(`${name} resolves metadata from a store page larger than 512 KiB`, async () => {
    body = largeListing(domain);
    assert.deepEqual(await resolveAppDomain(origin), { domain, resolvedFrom: "store-listing" });
    assert.equal(requested.length, 1);
  });
}

test("a redirected listing retains the larger store-page limit", async () => {
  body = largeListing("futuretodayinc.com");
  redirect = AMAZON_ORIGIN.storeurl;
  const result = await resolveAppDomain({ ...AMAZON_ORIGIN, storeurl: "https://www.amazon.com/start" });
  assert.deepEqual(result, { domain: "futuretodayinc.com", resolvedFrom: "store-listing" });
  assert.deepEqual(requested, ["/start", "/dp/B076X8FKXP"]);
});

test("store-page redirects still reject private destinations before requesting them", async () => {
  redirect = "https://127.0.0.1/private";
  body = largeListing("untrusted.example");
  const result = await resolveAppDomain({ ...AMAZON_ORIGIN, storeurl: "https://www.amazon.com/start" });
  assert.deepEqual(result, { domain: null, resolvedFrom: null });
  assert.deepEqual(requested, ["/start"]);
});

for (const [store, origin] of [
  ["Amazon", AMAZON_ORIGIN],
  ["Roku", { kind: "app", bundle: "151908", storeurl: "https://channelstore.roku.com/details/151908" }]
]) {
  test(`${store} reports a decompressed page above 4 MiB without retrying another address`, async () => {
    body = gzipSync("x".repeat(4 * 1024 * 1024 + 1));
    headers = { "Content-Encoding": "gzip" };
    const result = await resolveAppDomain(origin);
    assert.equal(result.domain, null);
    assert.equal(result.resolutionError?.code, "store_page_too_large");
    assert.match(result.resolutionError.message, /4194304-byte download limit/);
    assert.equal(requested.length, 1);
  });
}

test("ads.txt still accepts a response exactly at 512 KiB", async () => {
  body = "x".repeat(512 * 1024);
  assert.equal(await fetchText("https://publisher.example/ads.txt"), body);
});

test("ads.txt above 512 KiB reports the size limit without retrying another address", async () => {
  body = "x".repeat(512 * 1024 + 1);
  await assert.rejects(fetchText("https://publisher.example/ads.txt"), (error) => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, "RESPONSE_TOO_LARGE");
    assert.match(error.message, /524288-byte download limit/);
    return true;
  });
  assert.equal(requested.length, 1);
});

test("sellers.json retains its separate limit above the store-page cap", async () => {
  body = JSON.stringify({ padding: "x".repeat(4 * 1024 * 1024 + 1), sellers: [] });
  assert.equal(await fetchJsonText("https://exchange.example/sellers.json"), body);
});

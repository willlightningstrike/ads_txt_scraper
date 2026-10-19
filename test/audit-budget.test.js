const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const dns = require("dns");
process.env.AUDIT_BUDGET_MS = "40";
const { app } = require("../server");
const { auditChain } = require("../lib/chain-audit");
const { sellersCache } = require("../lib/sellers-json");
const realGet = axios.get;
const realLookup = dns.promises.lookup;
const seller = { sellers: [{ seller_id: "1", seller_type: "PUBLISHER", domain: "publisher.example" }] };
const node = { asi: "ssp.example", sid: "1" };
const bidRequest = { site: { domain: "publisher.example" }, source: { schain: { complete: 1, nodes: [node] } } };
const adsEntries = [{ adSystemDomain: "ssp.example", accountId: "1", relationship: "DIRECT", lineNumber: 1, raw: "ssp.example, 1, DIRECT" }];
let server, baseUrl;
test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(() => {
  sellersCache.items.clear();
  dns.promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
});
test.afterEach(() => { axios.get = realGet; dns.promises.lookup = realLookup; });
test.after(() => { server.close(); server.closeAllConnections(); });
const response = (data) => ({ status: 200, headers: {}, data });
const post = (request = bidRequest) => axios.post(`${baseUrl}/api/audit-chain`, { bidRequest: request }, { validateStatus: () => true });
function deferred(value) {
  let release;
  const promise = new Promise((resolve) => { release = () => resolve(value); });
  const fallback = setTimeout(release, 400);
  return { promise, release: () => { clearTimeout(fallback); release(); } };
}

test("the route returns a partial result while the final shared seller fetch is still pending", async () => {
  const pending = deferred(response(JSON.stringify(seller)));
  axios.get = async (url) => url.endsWith("/ads.txt") ? response("ssp.example, 1, DIRECT") : pending.promise;
  try {
    const result = await post();
    assert.equal(result.status, 200);
    assert.equal(result.data.verdict, "unverifiable");
    assert.ok(result.data.chainChecks.some((check) => check.code === "audit_budget_exceeded"));
    assert.equal(result.data.hops[0].checks.sellerIdPresent.status, "skip");
  } finally { pending.release(); }
});

test("the audit budget includes fetching the owner file", async () => {
  const pending = deferred(response("ssp.example, 1, DIRECT"));
  const requests = [];
  axios.get = async (url) => { requests.push(url); return url.endsWith("/ads.txt") ? pending.promise : response(JSON.stringify(seller)); };
  try {
    const result = await post();
    assert.equal(result.status, 504);
    assert.equal(result.data.reason, "audit_budget_exceeded");
    assert.deepEqual(requests, ["https://publisher.example/ads.txt"]);
  } finally { pending.release(); }
});

test("the audit budget includes app resolution and stops further lookup candidates", async () => {
  const pending = deferred(response(JSON.stringify({ results: [] })));
  const requests = [];
  axios.get = async (url) => { requests.push(url); return pending.promise; };
  try {
    const result = await post({ app: { bundle: "com.example.app", storeurl: "https://apps.apple.com/app/id123" }, source: bidRequest.source });
    assert.equal(result.status, 504);
    assert.equal(result.data.reason, "audit_budget_exceeded");
    pending.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
  } finally { pending.release(); }
});

test("one aborted audit stops waiting without aborting the shared seller result for another", async () => {
  const pending = deferred(seller);
  const controller = new AbortController();
  const normalized = { origin: { file: "ads.txt" }, complete: 1, nodes: [node], warnings: [] };
  const options = { adsEntries, originDomain: "publisher.example", loadSellers: () => pending.promise };
  const first = auditChain(normalized, { ...options, signal: controller.signal });
  const second = auditChain(normalized, options);
  try {
    controller.abort();
    const result = await first;
    assert.equal(result.verdict, "unverifiable");
    assert.equal(result.hops[0].checks.sellerIdPresent.status, "skip");
    pending.release();
    assert.equal((await second).verdict, "pass");
  } finally { pending.release(); await second; }
});

test("an expired audit cannot downgrade an already broken chain", async () => {
  const pending = deferred(response(JSON.stringify({ sellers: [] })));
  axios.get = async (url) => {
    if (url.endsWith("/ads.txt")) return response("ssp.example, 1, INVALID\nlast.example, 2, RESELLER");
    return url.includes("last.example") ? pending.promise : response(JSON.stringify(seller));
  };
  try {
    const result = await post({ ...bidRequest, source: { schain: { complete: 1, nodes: [node, { asi: "last.example", sid: "2" }] } } });
    assert.equal(result.data.verdict, "broken");
    assert.ok(result.data.chainChecks.some((check) => check.code === "audit_budget_exceeded"));
  } finally { pending.release(); }
});

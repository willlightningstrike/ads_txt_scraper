// Must be set before requiring the server so the module picks up the small cap.
process.env.MAX_CACHEABLE_JSON_BYTES = "200";

const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

const { fetchSellersJson } = require("../server");

const realGet = axios.get;

function stubSellersResponse(body, headers) {
  let calls = 0;

  axios.get = async () => {
    calls += 1;
    return { status: 200, headers, data: body };
  };

  return () => calls;
}

test.afterEach(() => {
  axios.get = realGet;
});

test("a body larger than the cap is not cached even when Content-Length under-reports it", async () => {
  // Far past the 200-byte cap, behind a Content-Length that claims otherwise —
  // which is what a gzip response looks like after axios has decompressed it.
  const body = JSON.stringify({
    sellers: [{ seller_id: "acct-1", name: "x".repeat(4000), seller_type: "PUBLISHER" }]
  });
  const calls = stubSellersResponse(body, { "content-length": "100" });

  const first = await fetchSellersJson("https://8.8.8.8/oversize-sellers.json");
  const second = await fetchSellersJson("https://8.8.8.8/oversize-sellers.json");

  assert.equal(first.sellers[0].seller_id, "acct-1");
  assert.equal(second.sellers[0].seller_id, "acct-1");
  assert.equal(calls(), 2, "the oversized body should have been refetched, not served from cache");
});

test("a body under the cap is cached even when the response has no Content-Length", async () => {
  const body = JSON.stringify({ sellers: [{ seller_id: "acct-2", seller_type: "BOTH" }] });
  const calls = stubSellersResponse(body, {});

  await fetchSellersJson("https://8.8.8.8/small-sellers.json");
  await fetchSellersJson("https://8.8.8.8/small-sellers.json");

  assert.equal(calls(), 1, "a chunked response under the cap should still be cached");
});

test("a body that is not JSON reports a clear error", async () => {
  stubSellersResponse("<html>404</html>", {});

  await assert.rejects(
    () => fetchSellersJson("https://8.8.8.8/html-sellers.json"),
    (error) => error.statusCode === 502 && /not valid JSON/.test(error.message)
  );
});

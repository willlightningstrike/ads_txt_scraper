const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const axios = require("axios");

const {
  app,
  buildAxiosOptions,
  compareDomains,
  fetchWithRedirects,
  isPrivateIp,
  mapWithConcurrency,
  parseAdsTxt,
  validateExternalUrl
} = require("../server");

const realGet = axios.get;

test.afterEach(() => {
  axios.get = realGet;
});

test("isPrivateIp blocks the special-use IPv4 ranges outside RFC 1918", () => {
  assert.equal(isPrivateIp("0.0.0.0"), true);
  assert.equal(isPrivateIp("0.1.2.3"), true);
  assert.equal(isPrivateIp("100.64.0.1"), true);
  assert.equal(isPrivateIp("192.0.0.1"), true);
  assert.equal(isPrivateIp("198.18.0.1"), true);
  assert.equal(isPrivateIp("224.0.0.1"), true);
  assert.equal(isPrivateIp("255.255.255.255"), true);
});

test("isPrivateIp does not overmatch neighbouring public IPv4 addresses", () => {
  assert.equal(isPrivateIp("1.1.1.1"), false);
  assert.equal(isPrivateIp("100.63.255.255"), false);
  assert.equal(isPrivateIp("192.0.1.1"), false);
  assert.equal(isPrivateIp("198.20.0.1"), false);
  assert.equal(isPrivateIp("223.255.255.255"), false);
});

test("validateExternalUrl rejects 0.0.0.0 and its IPv6 mapped form", async () => {
  await assert.rejects(
    () => validateExternalUrl("https://0.0.0.0/"),
    (error) => error.statusCode === 400 && /Private or loopback/.test(error.message)
  );

  await assert.rejects(
    () => validateExternalUrl("https://[::ffff:0.0.0.0]/"),
    (error) => error.statusCode === 400 && /Private or loopback/.test(error.message)
  );
});

test("buildAxiosOptions disables proxy env vars so the pinned lookup governs", () => {
  assert.equal(buildAxiosOptions(1024).proxy, false);
  assert.equal(buildAxiosOptions(1024, "json", "8.8.8.8").proxy, false);
});

test("mapWithConcurrency preserves order and never exceeds the limit", async () => {
  const items = Array.from({ length: 50 }, (_value, index) => index);
  let active = 0;
  let peak = 0;

  const results = await mapWithConcurrency(items, 6, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return item * 2;
  });

  assert.equal(peak, 6);
  assert.deepEqual(results, items.map((item) => item * 2));
});

test("mapWithConcurrency handles an empty input without hanging", async () => {
  assert.deepEqual(await mapWithConcurrency([], 6, async () => "unused"), []);
});

test("a chain of exactly four redirects still reaches its destination", async () => {
  let calls = 0;

  axios.get = async () => {
    calls += 1;
    return calls <= 4
      ? { status: 302, headers: { location: `https://8.8.8.8/hop-${calls}` }, data: "" }
      : { status: 200, headers: {}, data: "arrived" };
  };

  const response = await fetchWithRedirects("https://8.8.8.8/start", 1024);

  assert.equal(response.data, "arrived");
  assert.equal(calls, 5, "one request for the original URL plus one per redirect hop");
});

test("a fifth redirect is still refused", async () => {
  axios.get = async () => ({
    status: 302,
    headers: { location: "https://8.8.8.8/next" },
    data: ""
  });

  await assert.rejects(
    () => fetchWithRedirects("https://8.8.8.8/start", 1024),
    (error) => error.statusCode === 502 && /Too many redirects/.test(error.message)
  );
});

test("parseAdsTxt drops rows that cannot identify a lookup", () => {
  const entries = parseAdsTxt([
    "# a comment",
    "",
    ", seller-1, DIRECT",
    "example.com, , DIRECT",
    "example.com, seller-1",
    "example.com, seller-1, DIRECT",
    "example.com, seller-2, INVALID"
  ].join("\n"));

  assert.deepEqual(
    entries.map((entry) => [entry.adSystemDomain, entry.accountId, entry.relationship]),
    [
      ["example.com", "seller-1", "DIRECT"],
      // Kept on purpose: validateSellerType reports it as a mismatch, which is
      // more useful to a publisher than dropping the row without a word.
      ["example.com", "seller-2", "INVALID"]
    ]
  );
});

test("compareDomains separates an exact match from a shared suffix", () => {
  assert.equal(compareDomains("example.com", "example.com").status, "match");
  assert.equal(compareDomains("tenant.github.io", "github.io").status, "related");
  assert.equal(compareDomains("example.com", "ads.example.com").status, "related");
  assert.equal(compareDomains("example.com", "unrelated.net").status, "mismatch");
  assert.equal(compareDomains("example.com", null).status, "unknown");

  assert.match(
    compareDomains("tenant.github.io", "github.io").message,
    /does not establish common ownership/
  );
});

test("the API does not advertise cross-origin access", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const response = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path: "/api/health",
          method: "GET",
          headers: { Origin: "https://evil.example" }
        },
        resolve
      );

      request.on("error", reject);
      request.end();
    });

    response.resume();
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  } finally {
    server.close();
  }
});

test("closing the connection stops the queued sellers.json lookups", async () => {
  const ROW_COUNT = 60;
  const rows = Array.from({ length: ROW_COUNT }, (_value, index) => `8.8.1.${index}, acct-1, DIRECT`).join("\n");
  let sellersFetches = 0;

  axios.get = async (url) => {
    if (url.endsWith("/ads.txt")) {
      return { status: 200, headers: {}, data: rows };
    }

    sellersFetches += 1;
    await new Promise((resolve) => setTimeout(resolve, 60));
    return {
      status: 200,
      headers: {},
      data: JSON.stringify({ sellers: [{ seller_id: "acct-1", seller_type: "PUBLISHER" }] })
    };
  };

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const body = JSON.stringify({ adsTxtUrl: "https://8.8.8.8/ads.txt", accountId: "acct-1" });
    const request = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      path: "/api/validate",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    });

    request.on("error", () => {});
    request.end(body);

    await new Promise((resolve) => setTimeout(resolve, 200));
    request.destroy();
    const atCancel = sellersFetches;

    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.ok(atCancel > 0, "the fan-out should have started before the connection closed");
    assert.ok(
      sellersFetches < ROW_COUNT,
      `expected the queued lookups to stop, but ${sellersFetches}/${ROW_COUNT} ran anyway`
    );
  } finally {
    server.close();
  }
});

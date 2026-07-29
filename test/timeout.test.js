// Must be set before requiring the server so the module picks up the short timeout.
process.env.REQUEST_TIMEOUT_MS = "1000";

const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

const {
  buildAxiosOptions,
  fetchWithRedirects,
  shouldRetryWithAnotherAddress
} = require("../server");

// RFC 5737 TEST-NET-1. Reserved for documentation, never routed, so connections
// to it stall in the TCP handshake exactly like a derelict ad system domain.
const BLACKHOLE_IP = "192.0.2.1";

test("outbound requests abort at REQUEST_TIMEOUT_MS when the peer never completes the TCP handshake", async () => {
  const startedAt = Date.now();

  await assert.rejects(
    () => axios.get("https://example.com/sellers.json", buildAxiosOptions(1024, "json", BLACKHOLE_IP))
  );

  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < 5000,
    `expected the request to abort near the 1000ms timeout, but it took ${elapsed}ms`
  );
});

test("shouldRetryWithAnotherAddress does not retry after a timeout", () => {
  assert.equal(shouldRetryWithAnotherAddress({ code: "ETIMEDOUT" }), false);
  assert.equal(shouldRetryWithAnotherAddress({ code: "ECONNABORTED" }), false);
  assert.equal(shouldRetryWithAnotherAddress({ code: "ERR_CANCELED" }), false);
});

test("shouldRetryWithAnotherAddress still retries after a refused or reset connection", () => {
  assert.equal(shouldRetryWithAnotherAddress({ code: "ECONNREFUSED" }), true);
  assert.equal(shouldRetryWithAnotherAddress({ code: "ECONNRESET" }), true);
});

test("shouldRetryWithAnotherAddress does not retry once the server has responded", () => {
  assert.equal(shouldRetryWithAnotherAddress({ response: { status: 500 } }), false);
  assert.equal(shouldRetryWithAnotherAddress({ statusCode: 502 }), false);
});

test("a timed-out fetch reports 504 regardless of which deadline fired", async () => {
  const target = {
    url: new URL("https://example.com/sellers.json"),
    hostname: "example.com",
    addresses: [BLACKHOLE_IP]
  };

  await assert.rejects(
    () => fetchWithRedirects(target, 1024, "json"),
    (error) => error.statusCode === 504 && /timed out/i.test(error.message)
  );
});

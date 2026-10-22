const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const {
  createPinnedLookup,
  isPrivateIp,
  validateExternalUrl
} = require("../server");

for (const name of ["MAX_CONCURRENT_LOOKUPS", "AUDIT_BUDGET_MS"]) {
  test(`the server refuses to start with a non-positive or non-numeric ${name}`, () => {
    for (const value of ["0", "-1", "abc", "1.5"]) {
      const result = spawnSync(process.execPath, ["-e", "require('./server')"], {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, [name]: value },
        encoding: "utf8"
      });
      assert.notEqual(result.status, 0, `${name}=${value}`);
      assert.match(result.stderr, new RegExp(`${name} must be a positive integer`));
    }
  });
}

test("isPrivateIp blocks private and loopback IPv6 forms", () => {
  assert.equal(isPrivateIp("fc00::1"), true);
  assert.equal(isPrivateIp("fd12::1"), true);
  assert.equal(isPrivateIp("fe80::1"), true);
  assert.equal(isPrivateIp("fec0::1"), true);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("0:0:0:0:0:0:0:1"), true);
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("::ffff:169.254.169.254"), true);
  assert.equal(isPrivateIp("::169.254.169.254"), true);
  assert.equal(isPrivateIp("::"), true);
});

test("isPrivateIp does not overmatch public IPv6 addresses", () => {
  assert.equal(isPrivateIp("2001:4860::8888"), false);
  assert.equal(isPrivateIp("fca::1"), false);
  assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
});

test("validateExternalUrl rejects bracketed private IPv6 literals", async () => {
  await assert.rejects(
    () => validateExternalUrl("https://[::ffff:127.0.0.1]/"),
    (error) => error.statusCode === 400 && /Private or loopback/.test(error.message)
  );

  await assert.rejects(
    () => validateExternalUrl("https://[0:0:0:0:0:0:0:1]/"),
    (error) => error.statusCode === 400 && /Private or loopback/.test(error.message)
  );
});

test("validateExternalUrl returns pinned addresses for public IP literals", async () => {
  const target = await validateExternalUrl("https://8.8.8.8/path");

  assert.equal(target.url.toString(), "https://8.8.8.8/path");
  assert.deepEqual(target.addresses, ["8.8.8.8"]);
});

test("createPinnedLookup always returns the validated address", async () => {
  const lookup = createPinnedLookup("93.184.216.34");

  const singleResult = await new Promise((resolve, reject) => {
    lookup("example.com", {}, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({ address, family });
    });
  });

  const allResult = await new Promise((resolve, reject) => {
    lookup("example.com", { all: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(addresses);
    });
  });

  assert.deepEqual(singleResult, {
    address: "93.184.216.34",
    family: 4
  });
  assert.deepEqual(allResult, [{
    address: "93.184.216.34",
    family: 4
  }]);
});

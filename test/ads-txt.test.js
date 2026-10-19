const test = require("node:test");
const assert = require("node:assert/strict");

const { parseAdsTxt, parseAdsTxtVariables } = require("../lib/ads-txt");

const FILE = [
  "# owner file",
  "google.com, pub-1, DIRECT",
  "INVENTORYPARTNERDOMAIN=partner.example",
  "inventorypartnerdomain = Second.Example   # trailing comment",
  "CONTACT=ads@owner.example",
  "OWNERDOMAIN=owner.example",
  "freewheel.tv, 384777, RESELLER"
].join("\n");

test("parseAdsTxtVariables collects ads.txt 1.1 variable lines by lower-cased name", () => {
  const variables = parseAdsTxtVariables(FILE);

  assert.deepEqual(variables.inventorypartnerdomain, ["partner.example", "Second.Example"]);
  assert.deepEqual(variables.contact, ["ads@owner.example"]);
  assert.deepEqual(variables.ownerdomain, ["owner.example"]);
});

test("variable lines never leak into the data entries and data lines are never variables", () => {
  const entries = parseAdsTxt(FILE);
  assert.deepEqual(entries.map((entry) => entry.adSystemDomain), ["google.com", "freewheel.tv"]);

  const variables = parseAdsTxtVariables("google.com, pub-1, DIRECT\n");
  assert.deepEqual(variables, {});
});

test("a file with no variables yields an empty object, not undefined lookups that throw", () => {
  const variables = parseAdsTxtVariables("google.com, pub-1, DIRECT");
  assert.equal(variables.inventorypartnerdomain, undefined);
});

test("constructor variable does not interfere with inventory partner parsing", () => {
  const variables = parseAdsTxtVariables("constructor=hello\nINVENTORYPARTNERDOMAIN=partner.example\nconstructor=again");
  assert.deepEqual(variables.inventorypartnerdomain, ["partner.example"]);
  assert.deepEqual(variables.constructor, ["hello", "again"]);
});

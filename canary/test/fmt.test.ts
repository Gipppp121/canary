import { test } from "node:test";
import assert from "node:assert/strict";
import { pct, eth, units, short, ago, bar } from "../src/util/fmt.js";

test("percentages carry their sign", () => {
  assert.equal(pct(12.34), "+12.3%");
  assert.equal(pct(-8), "-8.0%");
});

test("wei renders without floating point drift", () => {
  assert.equal(eth(4_200_000_000_000_000_000n), "4.2000");
  assert.equal(eth(1n), "0.0000");
});

test("addresses shorten, short ones are left alone", () => {
  assert.equal(short("0x" + "a".repeat(40)), "0xaaaa…aaaa");
  assert.equal(short("0xabc"), "0xabc");
});

test("ago reads like a human wrote it", () => {
  assert.equal(ago(45_000), "45s");
  assert.equal(ago(9 * 60_000), "9m");
  assert.equal(ago(5 * 3600_000), "5h");
});

test("the bar never overflows its width", () => {
  assert.equal(bar(0, 10).length, 10);
  assert.equal(bar(100, 10), "█".repeat(10));
  assert.equal(bar(999, 10).length, 10);
});


test("generic token units respect decimals", () => {
  assert.equal(units(1_234_567n, 6, 4), "1.2345");
  assert.equal(units(42n, 0, 4), "42");
});

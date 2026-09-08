import { test } from "node:test";
import assert from "node:assert/strict";
import { controlAuthorized, secureTokenEqual } from "../src/ui/control-auth.js";

test("direct localhost control works without a configured key", () => {
  assert.equal(controlAuthorized({
    boundHost: "127.0.0.1",
    configuredToken: "",
    suppliedToken: "",
    forwardedFor: "",
    remoteAddress: "127.0.0.1",
  }), true);
});

test("a proxied public request is locked when no control key is configured", () => {
  assert.equal(controlAuthorized({
    boundHost: "127.0.0.1",
    configuredToken: "",
    suppliedToken: "",
    forwardedFor: "203.0.113.9",
    remoteAddress: "127.0.0.1",
  }), false);
});

test("a public/proxied request can control only with the configured key", () => {
  assert.equal(controlAuthorized({
    boundHost: "127.0.0.1",
    configuredToken: "secret-123",
    suppliedToken: "secret-123",
    forwardedFor: "203.0.113.9",
    remoteAddress: "127.0.0.1",
  }), true);
  assert.equal(controlAuthorized({
    boundHost: "127.0.0.1",
    configuredToken: "secret-123",
    suppliedToken: "wrong",
    forwardedFor: "203.0.113.9",
    remoteAddress: "127.0.0.1",
  }), false);
});

test("control token comparison is exact", () => {
  assert.equal(secureTokenEqual("abc", "abc"), true);
  assert.equal(secureTokenEqual("abc", "abcd"), false);
});

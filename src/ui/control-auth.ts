/** Canary v0.4 control-plane authorization helpers. */

import { timingSafeEqual } from "node:crypto";

function normalizeIp(value: string): string {
  const v = value.trim();
  return v.startsWith("::ffff:") ? v.slice(7) : v;
}

export function isLoopbackIp(value: string): boolean {
  const v = normalizeIp(value);
  return v === "127.0.0.1" || v === "::1" || v === "localhost";
}

export function secureTokenEqual(expected: string, supplied: string): boolean {
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(supplied, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface ControlAuthInput {
  boundHost: string;
  configuredToken: string;
  suppliedToken: string;
  forwardedFor: string;
  remoteAddress: string;
}

/**
 * Direct localhost control works without a key.
 * Any request arriving through a proxy or a non-loopback bind requires the
 * configured CANARY_CONTROL_TOKEN and a matching x-canary-control header.
 */
export function controlAuthorized(input: ControlAuthInput): boolean {
  if (input.configuredToken) {
    return secureTokenEqual(input.configuredToken, input.suppliedToken);
  }

  if (!isLoopbackIp(input.boundHost)) return false;
  if (input.forwardedFor.trim() !== "") return false;
  return isLoopbackIp(input.remoteAddress);
}

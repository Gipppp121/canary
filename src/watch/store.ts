/** Snapshots on disk, so a restart does not lose what changed while you slept. */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Snapshot } from "./signals.js";

const DIR = ".canary";
const FILE = "snapshots.json";

export interface StoreShape {
  version: 1;
  updatedAt: number;
  positions: Record<string, Snapshot>;
}

function replacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? `${v.toString()}n` : v;
}
function reviver(_k: string, v: unknown) {
  return typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
}

export class Store {
  private path: string;
  private data: StoreShape;

  constructor(root: string = process.cwd()) {
    this.path = join(root, DIR, FILE);
    this.data = { version: 1, updatedAt: 0, positions: {} };
    if (existsSync(this.path)) {
      try {
        this.data = JSON.parse(readFileSync(this.path, "utf8"), reviver) as StoreShape;
      } catch {
        /* a corrupt file is not worth crashing over; start clean */
      }
    }
  }

  get(token: string): Snapshot | undefined {
    return this.data.positions[token.toLowerCase()];
  }

  put(s: Snapshot): void {
    this.data.positions[s.token.toLowerCase()] = s;
    this.data.updatedAt = Date.now();
  }

  all(): Snapshot[] {
    return Object.values(this.data.positions);
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, replacer, 2));
  }
}

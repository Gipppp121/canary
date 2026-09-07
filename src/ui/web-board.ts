#!/usr/bin/env node
/** Canary v0.3 local read-only web board with persistent memory and local watcher control. */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { evaluate, DEFAULT_THRESHOLDS, type Alert, type Snapshot } from "../watch/signals.js";
import { isAddress } from "../util/env.js";
import { units } from "../util/fmt.js";

const ROOT = process.cwd();
const STORE_FILE = join(ROOT, ".canary", "snapshots.json");
const MEMORY_FILE = join(ROOT, ".canary", "board-memory.json");
const PHASE = ["CURVE", "SWEPT", "POOL", "RESCUED"];
const SAMPLE_LIMIT = 240;
const ALERT_LIMIT = 500;
const WATCH_INTERVAL_SECONDS = 10;

interface StoreFile {
  version: number;
  updatedAt: number;
  positions: Record<string, Snapshot>;
}

interface RememberedAlert extends Alert {
  at: number;
}

interface MemoryFile {
  version: 1;
  updatedAt: number;
  samples: Record<string, Snapshot[]>;
  alerts: RememberedAlert[];
}

interface ActiveWatcher {
  token: string;
  startedAt: number;
  child: ChildProcess;
}

const watchers = new Map<string, ActiveWatcher>();

function replacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? `${v.toString()}n` : v;
}

function reviver(_k: string, v: unknown): unknown {
  return typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8"), reviver) as T; }
  catch { return fallback; }
}

function storeState(): StoreFile {
  return readJson<StoreFile>(STORE_FILE, { version: 1, updatedAt: 0, positions: {} });
}

function memoryState(): MemoryFile {
  return readJson<MemoryFile>(MEMORY_FILE, { version: 1, updatedAt: 0, samples: {}, alerts: [] });
}

function writeMemory(memory: MemoryFile): void {
  mkdirSync(dirname(MEMORY_FILE), { recursive: true });
  writeFileSync(MEMORY_FILE, JSON.stringify(memory, replacer, 2));
}

function sampleMemory(): MemoryFile {
  const store = storeState();
  const memory = memoryState();
  let changed = false;

  for (const snapshot of Object.values(store.positions)) {
    const key = snapshot.token.toLowerCase();
    const samples = memory.samples[key] ?? [];
    const previous = samples.at(-1);
    if (previous?.at === snapshot.at) continue;

    const alerts = evaluate(previous, snapshot, DEFAULT_THRESHOLDS, snapshot.at || Date.now());
    for (const alert of alerts) {
      const duplicate = memory.alerts.some((x) =>
        x.token.toLowerCase() === alert.token.toLowerCase() &&
        x.rule === alert.rule &&
        Math.abs(x.at - (snapshot.at || Date.now())) < 1_000
      );
      if (!duplicate) memory.alerts.push({ ...alert, at: snapshot.at || Date.now() });
    }

    samples.push(snapshot);
    memory.samples[key] = samples.slice(-SAMPLE_LIMIT);
    changed = true;
  }

  if (memory.alerts.length > ALERT_LIMIT) memory.alerts = memory.alerts.slice(-ALERT_LIMIT);
  if (changed) {
    memory.updatedAt = Date.now();
    writeMemory(memory);
  }
  return memory;
}

function compact(v: bigint | undefined): string {
  if (v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return v.toString();
  if (n >= 1e15) return `${(n / 1e15).toFixed(2)}q`;
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}t`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return v.toString();
}

function price(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1) return v.toFixed(6);
  if (v >= 0.000001) return v.toFixed(8);
  return v.toExponential(3);
}

function numericUnits(v: bigint, decimals: number): number | null {
  const scale = 10 ** Math.min(30, Math.max(0, decimals));
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isFinite(scale) || scale === 0) return null;
  const out = n / scale;
  return Number.isFinite(out) ? out : null;
}

function statusFor(token: string, alerts: RememberedAlert[], now: number): "LEAVE" | "WATCH" | "INFO" | "QUIET" {
  const recent = alerts.filter((a) => a.token.toLowerCase() === token.toLowerCase() && now - a.at < 15 * 60_000);
  if (recent.some((a) => a.level === "leave")) return "LEAVE";
  if (recent.some((a) => a.level === "warn")) return "WATCH";
  if (recent.some((a) => a.level === "info")) return "INFO";
  return "QUIET";
}

function viewSnapshot(s: Snapshot, alerts: RememberedAlert[], now: number) {
  const phase = s.phase === undefined ? "UNKNOWN" : (PHASE[s.phase] ?? String(s.phase));
  const pair = s.pairSymbol ?? "QUOTE";
  return {
    token: s.token,
    symbol: s.symbol,
    phase,
    status: statusFor(s.token, alerts, now),
    dev: s.devHoldPct,
    trades: s.trades,
    lastTradeAt: s.lastTradeAt,
    at: s.at,
    deployer: s.deployer ?? "",
    deployerLaunches: s.deployerLaunches,
    deployerGraduated: s.deployerGraduated ?? null,
    creatorTaxPct: s.creatorTaxBps === undefined ? null : s.creatorTaxBps / 100,
    pair,
    reserve: s.phase === 2 ? "—" : `${units(s.liquidityWei, s.pairDecimals ?? 18)} ${pair}`,
    price: s.phase === 2 ? `${price(s.poolPriceQuotePerToken)} ${pair}/token` : "—",
    liquidity: s.phase === 2 ? compact(s.poolLiquidity) : "—",
    quoteFees: `${units(s.feesPendingWei, s.pairDecimals ?? 18)} ${pair}`,
    tokenFees: s.poolPendingTokenFeesWei === undefined ? "—" : `${units(s.poolPendingTokenFeesWei, s.tokenDecimals ?? 18)} ${s.symbol}`,
    tick: s.poolTick ?? null,
  };
}

function activeWatcherState() {
  return [...watchers.values()].map((w) => ({ token: w.token, startedAt: w.startedAt }));
}

function apiState() {
  const store = storeState();
  const memory = sampleMemory();
  const now = Date.now();
  const positions = Object.values(store.positions)
    .sort((a, b) => b.at - a.at)
    .map((s) => viewSnapshot(s, memory.alerts, now));
  const alerts = [...memory.alerts].sort((a, b) => b.at - a.at).slice(0, 120);
  const histories: Record<string, unknown[]> = {};
  for (const [token, samples] of Object.entries(memory.samples)) {
    histories[token] = samples.slice(-120).map((s) => ({
      at: s.at,
      dev: s.devHoldPct,
      trades: s.trades,
      phase: s.phase === undefined ? "UNKNOWN" : (PHASE[s.phase] ?? String(s.phase)),
      price: s.poolPriceQuotePerToken ?? null,
      reserve: s.phase === 2 ? null : numericUnits(s.liquidityWei, s.pairDecimals ?? 18),
    }));
  }
  return {
    generatedAt: now,
    writerUpdatedAt: store.updatedAt,
    memoryUpdatedAt: memory.updatedAt,
    stats: {
      tracked: positions.length,
      leave: alerts.filter((a) => a.level === "leave" && now - a.at < 86_400_000).length,
      watch: alerts.filter((a) => a.level === "warn" && now - a.at < 86_400_000).length,
      samples: Object.values(memory.samples).reduce((n, xs) => n + xs.length, 0),
      activeWatchers: watchers.size,
    },
    positions,
    alerts,
    histories,
    watchers: activeWatcherState(),
  };
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, replacer);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function text(res: ServerResponse, status: number, value: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(value);
}

function readBody(req: IncomingMessage, limit = 2_048): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > limit) reject(new Error("request too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function startWatcher(token: string): { ok: true; started: boolean } | { ok: false; error: string } {
  const key = token.toLowerCase();
  if (watchers.has(key)) return { ok: true, started: false };
  if (!isAddress(token)) return { ok: false, error: "not a valid EVM address" };

  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["run", "canary", "--", "watch", "--token", token, "--interval", String(WATCH_INTERVAL_SECONDS)];
  try {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "ignore",
      windowsHide: true,
    });
    const active: ActiveWatcher = { token, startedAt: Date.now(), child };
    watchers.set(key, active);
    child.once("exit", () => watchers.delete(key));
    child.once("error", () => watchers.delete(key));
    return { ok: true, started: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function parseArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function hasArg(name: string): boolean { return process.argv.includes(name); }

const port = Math.max(1, Math.min(65535, Number.parseInt(parseArg("--port", "4663"), 10) || 4663));
const host = parseArg("--host", "127.0.0.1");
const localControlEnabled = isLoopbackHost(host);

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>canary board</title>
<style>
:root{--bg:#090a08;--panel:#11130e;--panel2:#151810;--line:#2c3025;--text:#e7e9df;--muted:#7c8274;--lime:#b7ff00;--red:#ff5148;--yellow:#e6d657;--cyan:#5cc8ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}button,input{font:inherit}.wrap{max-width:1500px;margin:0 auto;padding:16px}.top{display:flex;align-items:center;gap:16px;border-bottom:1px solid var(--line);padding:0 0 12px}.bird{color:var(--lime);font-size:20px}.brand{font-family:Georgia,serif;font-size:20px}.sub{color:var(--muted);font-size:11px}.pill{border:1px solid #385000;color:var(--lime);border-radius:999px;padding:5px 9px}.spacer{flex:1}.heartbeat{font-size:11px;color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:14px 0}.card,.panel{background:linear-gradient(180deg,var(--panel),#0d0f0b);border:1px solid var(--line);border-radius:12px}.card{padding:13px 15px}.num{font:24px Georgia,serif}.label{font-size:10px;color:var(--muted);margin-top:3px}.layout{display:grid;grid-template-columns:minmax(0,2.1fr) minmax(360px,.9fr);gap:12px}.panel{overflow:hidden}.panel h2{font:18px Georgia,serif;margin:0;padding:14px 16px;border-bottom:1px solid var(--line)}.watchbar,.tools{display:flex;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}.watchbar{background:#0c0e0a}.watchbar input{flex:1}.watchbtn{background:var(--lime);color:#090a08;border:0;border-radius:8px;padding:8px 12px;font-weight:800;cursor:pointer;white-space:nowrap}.watchbtn:disabled{opacity:.45;cursor:default}.watchmsg{font-size:10px;color:var(--muted);padding:0 12px 9px;background:#0c0e0a}input{width:100%;background:#0b0d09;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 10px;outline:none}input:focus{border-color:#708d14}.tabs{display:flex;gap:6px}.tab{background:#11140e;border:1px solid var(--line);color:var(--muted);border-radius:999px;padding:6px 9px;cursor:pointer}.tab.on{color:#0a0b09;background:var(--lime);border-color:var(--lime)}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 11px;border-bottom:1px solid #20231c;white-space:nowrap}th{font-size:10px;color:var(--muted);font-weight:500}tbody tr{cursor:pointer}tbody tr:hover,tbody tr.sel{background:#171a12}.sym{font-weight:700}.addr{color:var(--muted);font-size:10px}.badge{display:inline-block;padding:2px 6px;border-radius:5px;font-size:10px}.QUIET{color:#8cff72}.WATCH{color:var(--yellow)}.LEAVE{color:var(--red)}.INFO{color:var(--cyan)}.phase{color:var(--cyan)}.bar{height:4px;background:#25291f;border-radius:9px;overflow:hidden;width:72px;display:inline-block;vertical-align:middle;margin-left:6px}.bar i{display:block;height:100%;background:var(--lime)}.detail{padding:14px}.detailHead{font:21px Georgia,serif;margin-bottom:4px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;margin:14px 0}.kv{border-top:1px solid var(--line);padding-top:7px}.kv b{display:block;font-size:10px;color:var(--muted);font-weight:500;margin-bottom:3px}.charts{display:grid;grid-template-columns:1fr;gap:8px}.chartTitle{font-size:10px;color:var(--muted);display:flex;justify-content:space-between}.spark{width:100%;height:68px;border:1px solid var(--line);background:#0a0c08;border-radius:8px}.memoryTitle{font:15px Georgia,serif;margin:14px 0 8px}.event{border-top:1px solid var(--line);padding:9px 0}.event small{color:var(--muted)}.eventDelta{color:var(--text);font-size:10px;margin-top:3px}.empty{padding:40px;color:var(--muted);text-align:center}.foot{color:var(--muted);font-size:10px;padding:12px 3px}.scroll{overflow:auto;max-height:720px}@media(max-width:900px){.layout{grid-template-columns:1fr}.stats{grid-template-columns:1fr 1fr}.tools,.watchbar{flex-direction:column}.scroll{max-height:none}}
</style></head><body><div class="wrap">
<div class="top"><div class="bird">↑</div><div><div class="brand">canary</div><div class="sub">Pons V2 · Robinhood Chain 4663 · persistent read-only watchtower</div></div><span class="pill">READ ONLY</span><div class="spacer"></div><div id="heartbeat" class="heartbeat">loading memory…</div></div>
<div class="stats"><div class="card"><div id="tracked" class="num">0</div><div class="label">tracked positions</div></div><div class="card"><div id="active" class="num">0</div><div class="label">active local watchers</div></div><div class="card"><div id="watch" class="num">0</div><div class="label">WATCH signals · 24h</div></div><div class="card"><div id="leave" class="num">0</div><div class="label">LEAVE signals · 24h</div></div><div class="card"><div id="samples" class="num">0</div><div class="label">remembered snapshots</div></div></div>
<div class="layout"><section class="panel"><h2>positions remembered by canary</h2><div class="watchbar"><input id="watchToken" placeholder="paste Pons V2 token address"><button id="watchBtn" class="watchbtn">WATCH TOKEN</button></div><div id="watchMsg" class="watchmsg">starts a local read-only watcher · no signer · no transaction path</div><div class="tools"><input id="search" placeholder="search symbol / token / deployer"><div class="tabs"><button class="tab on" data-filter="ALL">all</button><button class="tab" data-filter="WATCH">watch</button><button class="tab" data-filter="LEAVE">leave</button></div></div><div class="scroll"><table><thead><tr><th>token</th><th>phase</th><th>dev</th><th>activity</th><th>status</th><th>seen</th></tr></thead><tbody id="rows"></tbody></table><div id="empty" class="empty" hidden>nothing remembered yet.<br>paste a Pons V2 token above or run a canary watch command.</div></div></section><aside class="panel"><h2>position memory</h2><div id="detail" class="detail"><div class="empty">select a token</div></div></aside></div>
<div class="foot">local only · data comes from .canary/snapshots.json · history persists in .canary/board-memory.json · board control only starts read-only watcher processes · no transaction path exists</div></div>
<script>
(function(){
var state=null,selected=null,filter='ALL';
function esc(v){return String(v==null?'—':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function age(ms){if(!ms)return 'unknown';var d=Math.max(0,Date.now()-ms);if(d<1000)return 'now';if(d<60000)return Math.floor(d/1000)+'s';if(d<3600000)return Math.floor(d/60000)+'m';return Math.floor(d/3600000)+'h'}
function short(a){if(!a)return '—';return a.length>13?a.slice(0,7)+'…'+a.slice(-4):a}
function renderStats(){document.getElementById('tracked').textContent=state.stats.tracked;document.getElementById('active').textContent=state.stats.activeWatchers;document.getElementById('watch').textContent=state.stats.watch;document.getElementById('leave').textContent=state.stats.leave;document.getElementById('samples').textContent=state.stats.samples;var fresh=state.writerUpdatedAt?age(state.writerUpdatedAt):'no writer';document.getElementById('heartbeat').textContent='watcher '+fresh+' ago · active '+state.stats.activeWatchers+' · board refresh 2s'}
function filtered(){var q=document.getElementById('search').value.toLowerCase();return state.positions.filter(function(p){var ok=filter==='ALL'||p.status===filter;var text=(p.symbol+' '+p.token+' '+p.deployer).toLowerCase();return ok&&(!q||text.indexOf(q)>=0)})}
function renderRows(){var rows=document.getElementById('rows'),list=filtered();document.getElementById('empty').hidden=list.length>0;rows.innerHTML=list.map(function(p){var pct=Math.max(0,Math.min(100,p.dev));return '<tr data-token="'+esc(p.token)+'" class="'+(selected===p.token?'sel':'')+'"><td><span class="sym">'+esc(p.symbol)+'</span><br><span class="addr">'+esc(short(p.token))+'</span></td><td class="phase">'+esc(p.phase)+'</td><td>'+p.dev.toFixed(2)+'% <span class="bar"><i style="width:'+pct+'%"></i></span></td><td>'+esc(p.phase==='POOL'?p.price:p.reserve)+'</td><td><span class="badge '+esc(p.status)+'">'+esc(p.status)+'</span></td><td>'+age(p.at)+'</td></tr>'}).join('');Array.prototype.forEach.call(rows.querySelectorAll('tr'),function(tr){tr.addEventListener('click',function(){selected=tr.getAttribute('data-token');renderRows();renderDetail()})});if(!selected&&list[0]){selected=list[0].token;renderRows();renderDetail()}}
function series(history,key){return (history||[]).map(function(x){var v=x[key];return typeof v==='number'&&isFinite(v)?v:null}).filter(function(v){return v!==null})}
function fmtNum(v){if(v==null||!isFinite(v))return '—';if(Math.abs(v)>=1000)return v.toLocaleString(undefined,{maximumFractionDigits:2});if(Math.abs(v)>=1)return v.toFixed(3);if(Math.abs(v)>=0.000001)return v.toFixed(8);return v.toExponential(3)}
function spark(history,key){if(!history||history.length<2)return '<div class="spark" style="display:flex;align-items:center;justify-content:center;color:var(--muted)">memory builds as sweeps arrive</div>';var rows=history.map(function(x){return {at:x.at,v:x[key]}}).filter(function(x){return typeof x.v==='number'&&isFinite(x.v)});if(rows.length<2)return '<div class="spark" style="display:flex;align-items:center;justify-content:center;color:var(--muted)">not enough numeric samples</div>';var w=420,h=68,p=7,vals=rows.map(function(x){return x.v}),min=Math.min.apply(null,vals),max=Math.max.apply(null,vals);if(max===min)max=min+1;var pts=vals.map(function(v,i){var x=p+(i*(w-2*p)/Math.max(1,vals.length-1)),y=h-p-((v-min)/(max-min))*(h-2*p);return x.toFixed(1)+','+y.toFixed(1)}).join(' ');return '<svg class="spark" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none"><polyline fill="none" stroke="#b7ff00" stroke-width="2" points="'+pts+'"/><line x1="7" y1="56" x2="413" y2="56" stroke="#2c3025"/></svg>'}
function chartBlock(title,history,key){var vals=series(history,key),last=vals.length?vals[vals.length-1]:null;return '<div><div class="chartTitle"><span>'+esc(title)+'</span><span>'+esc(fmtNum(last))+'</span></div>'+spark(history,key)+'</div>'}
function renderDetail(){var box=document.getElementById('detail'),p=state.positions.find(function(x){return x.token===selected});if(!p){box.innerHTML='<div class="empty">select a token</div>';return}var h=state.histories[p.token.toLowerCase()]||state.histories[p.token]||[];var events=state.alerts.filter(function(a){return a.token.toLowerCase()===p.token.toLowerCase()}).slice(0,10);var grad=p.deployerGraduated==null?'—':p.deployerGraduated+'/'+p.deployerLaunches;var marketKey=p.phase==='POOL'?'price':'reserve';var marketTitle=p.phase==='POOL'?'pool price':'curve reserve';box.innerHTML='<div class="detailHead">'+esc(p.symbol)+'</div><div class="addr">'+esc(p.token)+'</div><div style="margin-top:10px"><span class="badge '+esc(p.status)+'">'+esc(p.status)+'</span> <span class="badge phase">'+esc(p.phase)+'</span></div><div class="grid"><div class="kv"><b>deployer share</b>'+p.dev.toFixed(2)+'%</div><div class="kv"><b>creator tax</b>'+(p.creatorTaxPct==null?'—':p.creatorTaxPct.toFixed(2)+'%')+'</div><div class="kv"><b>price / reserve</b>'+esc(p.phase==='POOL'?p.price:p.reserve)+'</div><div class="kv"><b>recent trades</b>'+esc(p.trades)+'</div><div class="kv"><b>quote fees</b>'+esc(p.quoteFees)+'</div><div class="kv"><b>token fees</b>'+esc(p.tokenFees)+'</div><div class="kv"><b>deployer launches</b>'+esc(p.deployerLaunches)+'</div><div class="kv"><b>graduated</b>'+esc(grad)+'</div><div class="kv"><b>deployer</b>'+esc(short(p.deployer))+'</div><div class="kv"><b>last activity</b>'+age(p.lastTradeAt)+'</div></div><div class="memoryTitle">live history · '+h.length+' samples</div><div class="charts">'+chartBlock('deployer share %',h,'dev')+chartBlock(marketTitle,h,marketKey)+chartBlock('recent activity',h,'trades')+'</div><div class="memoryTitle">deterministic signal timeline</div>'+(events.length?events.map(function(a){var delta=a.was||a.now?'<div class="eventDelta">'+esc(a.was||'—')+' → '+esc(a.now||'—')+'</div>':'';return '<div class="event"><span class="'+(a.level==='leave'?'LEAVE':a.level==='warn'?'WATCH':'INFO')+'">'+esc(a.level.toUpperCase())+'</span> '+esc(a.rule)+'<br><small>'+esc(a.headline)+' · '+age(a.at)+' ago</small>'+delta+'</div>'}).join(''):'<div class="event"><small>no remembered signal for this token</small></div>')}
function render(){renderStats();renderRows();renderDetail()}
async function load(){try{var r=await fetch('/api/state',{cache:'no-store'});state=await r.json();render()}catch(e){document.getElementById('heartbeat').textContent='board api unavailable'}}
async function startWatch(){var input=document.getElementById('watchToken'),btn=document.getElementById('watchBtn'),msg=document.getElementById('watchMsg'),token=input.value.trim();if(!token){msg.textContent='paste a token address first';return}btn.disabled=true;msg.textContent='starting read-only watcher…';try{var r=await fetch('/api/watch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:token})});var data=await r.json();if(!r.ok||!data.ok){msg.textContent=data.error||'failed to start watcher'}else{msg.textContent=data.started?'watcher started · waiting for first sweep':'this token is already being watched';selected=token;setTimeout(load,500)}}catch(e){msg.textContent='board control unavailable'}finally{btn.disabled=false}}
document.getElementById('watchBtn').addEventListener('click',startWatch);document.getElementById('watchToken').addEventListener('keydown',function(e){if(e.key==='Enter')startWatch()});document.getElementById('search').addEventListener('input',renderRows);Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(b){b.addEventListener('click',function(){filter=b.getAttribute('data-filter');document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('on',x===b)});renderRows()})});load();setInterval(load,2000);
})();
</script></body></html>`;

sampleMemory();
const server = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  if (req.method === "GET" && path === "/api/state") return json(res, 200, apiState());
  if (req.method === "POST" && path === "/api/watch") {
    if (!localControlEnabled) return json(res, 403, { ok: false, error: "local watcher control is disabled when board is not bound to loopback" });
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw || "{}") as { token?: unknown };
      const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
      const result = startWatcher(token);
      return json(res, result.ok ? 200 : 400, result);
    } catch (err) {
      return json(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return void res.end(PAGE);
  }
  text(res, 404, "not found");
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`\ncanary board  ${url}`);
  console.log(`memory        ${MEMORY_FILE}`);
  console.log(`source        ${STORE_FILE}`);
  console.log(`control       ${localControlEnabled ? "local WATCH TOKEN enabled" : "disabled outside loopback"}`);
  console.log("read only     board never signs or sends transactions\n");
  if (hasArg("--open")) {
    const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  }
});

server.on("error", (err) => {
  console.error(`board failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

function stopChildren(): void {
  for (const watcher of watchers.values()) {
    try { watcher.child.kill(); } catch { /* best effort */ }
  }
}
process.once("SIGINT", () => { stopChildren(); process.exit(0); });
process.once("SIGTERM", () => { stopChildren(); process.exit(0); });

setInterval(sampleMemory, 2_000).unref();

import assert from "node:assert/strict";
import { test } from "node:test";
import { assess, lossPerBorrowed, type MarketEvidence } from "../src/engine.js";
import type { Allocation, Vault } from "../src/morpho.js";

const NOW = 1_800_000_000;
const options = { amountUsd: 100, maxLossPct: 5, runShare: 0.3, now: NOW };

function allocation(id: string, symbol: string | null, supply: number, cap: number, lltv = 0.86, utilization = 0.9): Allocation {
  return {
    supply, supplyUsd: supply, cap, pendingCap: 0, pendingCapValidAt: null,
    market: {
      id, lltv, utilization, supplyUsd: supply, borrowUsd: supply * utilization, liquidityUsd: supply * (1 - utilization),
      collateral: symbol ? { address: `0x${id.padStart(40, "0")}`, symbol, decimals: 18, priceUsd: 1, morphoVault: null } : null,
      oracle: null,
    },
  };
}

function vault(allocations: Allocation[], extra: Partial<Vault> = {}): Vault {
  const total = allocations.reduce((s, a) => s + a.supply, 0);
  return {
    protocol: "morpho", address: "0xvault", name: "Test vault", asset: { address: "0xusdc", symbol: "USDC", decimals: 6 },
    totalAssets: total, totalAssetsUsd: total, netApy: 0.05, timelockSeconds: 3 * 86_400, curator: "0xc",
    withdrawableUsd: total, allocations, ...extra,
  };
}

const healthy = (kind: MarketEvidence["kind"]): MarketEvidence => ({ kind, oracle: { status: "live", detail: "" }, depth: { status: "deep", impactPct: 1 } });

test("loss per borrowed dollar is zero while collateral still covers the debt", () => {
  assert.equal(lossPerBorrowed(0.1, 0.86), 0); // 0.9 of value still covers a 0.86 loan
  assert.equal(lossPerBorrowed(1, 0.86), 1); // collateral worthless: the whole loan is lost
  assert.ok(Math.abs(lossPerBorrowed(0.77, 0.915) - (1 - 0.23 / 0.915)) < 1e-12); // xUSD-sized drop
});

test("a blue-chip vault passes with no stressed loss", () => {
  const v = vault([allocation("1", "cbBTC", 1_000_000, 2_000_000)]);
  const a = assess(v, new Map([["1", healthy("anchor")]]), options);
  assert.equal(a.verdict, "pass");
  assert.equal(a.lossWorstPct, 0);
  assert.equal(a.bedrockPct, 100);
});

test("a stale oracle removes liquidation protection even for blue-chip collateral", () => {
  const v = vault([allocation("1", "cbBTC", 1_000_000, 2_000_000)]);
  const stale: MarketEvidence = { ...healthy("anchor"), oracle: { status: "stale", detail: "last update 2026-06-02" } };
  const a = assess(v, new Map([["1", stale]]), options);
  assert.equal(a.verdict, "refuse");
  assert.ok(a.lossWorstPct > 25, `expected a large loss, got ${a.lossWorstPct}%`);
});

test("the curator envelope counts risk the vault does not hold yet", () => {
  // Today 100% blue-chip, but caps allow half the vault into a first-loss market.
  const v = vault([allocation("1", "cbBTC", 1_000_000, 2_000_000), allocation("2", "RLP", 0, 500_000)]);
  const a = assess(v, new Map([["1", healthy("anchor")], ["2", healthy("first-loss")]]), options);
  assert.equal(a.lossNowPct, 0);
  assert.ok(a.lossWorstPct >= 40, `envelope should reach the RLP cap, got ${a.lossWorstPct}%`);
  assert.equal(a.verdict, "refuse");
});

test("a fully borrowed vault fails the run test", () => {
  const v = vault([allocation("1", "cbBTC", 1_000_000, 2_000_000, 0.86, 1)], { withdrawableUsd: 0 });
  const a = assess(v, new Map([["1", healthy("anchor")]]), options);
  assert.equal(a.exitRunPct, 0);
  assert.match(a.reasons.join(" "), /nothing can be withdrawn/);
});

test("missing evidence counts against a market, never for it", () => {
  const v = vault([allocation("1", "SOMETHING", 1_000_000, 1_000_000)]);
  const a = assess(v, new Map(), options);
  assert.equal(a.verdict, "refuse");
  assert.equal(a.untraceablePct, 100);
});

test("a short timelock means caps bind nothing", () => {
  const v = vault([allocation("1", "cbBTC", 1_000_000, 2_000_000)], { timelockSeconds: 3600 });
  const a = assess(v, new Map([["1", healthy("anchor")]]), options);
  assert.equal(a.capsBinding, false);
  assert.equal(a.verdict, "refuse");
});

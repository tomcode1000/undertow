import type { Allocation, Vault } from "./morpho.js";
import { STRESS, UNTRACEABLE, type Kind } from "./registry.js";

// Pure assessment: given a vault and the evidence gathered about each market,
// work out what a depositor could lose, whether they could get out, and a verdict.

/** adapter: a price can be read but not when it was last updated (Aave price adapters, Moonwell's oracle). */
export type OracleStatus = "live" | "stale" | "constant" | "exchange-rate" | "adapter" | "unverified";
export type DepthStatus = "deep" | "thin" | "unknown" | "not-checked";

export type MarketEvidence = {
  kind: Kind;
  oracle: { status: OracleStatus; detail: string };
  depth: { status: DepthStatus; impactPct?: number };
  /** For a collateral that is itself a Morpho vault: its own traced worst-case loss and untraceable share. */
  inner?: { vault: string; name: string; lossFraction: number; untraceableFraction: number; bedrockFraction: number; cycle: boolean };
};

export type Options = {
  amountUsd: number;
  maxLossPct: number; // fail when the worst-case loss exceeds this
  runShare: number; // share of other depositors assumed to leave first in the run test
  minExitPct?: number; // fail when less than this share of the deposit comes out after the run (default 90)
  now: number; // unix seconds
};

export const DEFAULTS = { maxLossPct: 5, runShare: 0.3, minExitPct: 90, maxUntraceablePct: 1, minTimelockHours: 24 } as const;

export type MarketResult = {
  collateral: string;
  kind: Kind | "idle";
  sharePct: number; // share of the vault supplied here now
  worstSharePct: number; // share in the curator-allowed worst portfolio
  lltvPct: number;
  utilizationPct: number;
  oracle: string;
  depth: string;
  shockPct: number;
  gapPct: number;
  lossRatePct: number; // loss per borrowed dollar in the stress
  note: string;
};

export type Assessment = {
  vault: string;
  name: string;
  netApyPct: number;
  tvlUsd: number;
  verdict: "pass" | "refuse";
  reasons: string[];
  lossNowPct: number;
  lossWorstPct: number;
  yourLossWorstUsd: number;
  exitNowPct: number;
  exitRunPct: number;
  bedrockPct: number;
  untraceablePct: number;
  timelockHours: number;
  capsBinding: boolean;
  markets: MarketResult[];
};

const round = (x: number, digits = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** digits) / 10 ** digits : x);
const pct = (x: number) => round(x * 100);

/** Loss per borrowed dollar when collateral drops by `effectiveDrop` and every borrower sits at the LLTV. */
export function lossPerBorrowed(effectiveDrop: number, lltv: number): number {
  if (lltv <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - (1 - effectiveDrop) / lltv));
}

type Stressed = { allocation: Allocation; kind: Kind | "idle"; shock: number; gap: number; lossRate: number; risk: number; note: string; evidence?: MarketEvidence };

function stressMarket(allocation: Allocation, evidence: MarketEvidence | undefined): Stressed {
  const market = allocation.market;
  if (!market.collateral) return { allocation, kind: "idle", shock: 0, gap: 0, lossRate: 0, risk: 0, note: "idle cash, not lent" };
  // Evidence that could not be gathered counts against the market, never for it.
  const kind: Kind = evidence?.kind ?? "opaque";
  const base = STRESS[kind];
  let shock = base.shock;
  let gap = base.gap;
  const notes = [base.note];
  if (kind === "vault") {
    shock = evidence?.inner ? evidence.inner.lossFraction : 1;
    if (evidence?.inner?.cycle) notes.push("loops back into a vault already traced");
  }
  const oracle = evidence?.oracle.status ?? "unverified";
  if (oracle === "stale" || oracle === "constant" || oracle === "unverified") {
    gap = 1;
    notes.push(`oracle ${oracle}: liquidations cannot fire`);
  } else if (oracle === "exchange-rate" && kind !== "anchor" && kind !== "stable") {
    gap = 1;
    notes.push("oracle uses an exchange rate: a depeg is invisible to it");
  } else if (oracle === "adapter" && kind !== "anchor" && kind !== "stable") {
    // Fine for blue chips; for anything else an unverifiable (often rate-based) price is no protection.
    gap = 1;
    notes.push("price adapter with no update time: freshness cannot be checked");
  }
  const depth = evidence?.depth.status ?? "unknown";
  if (depth === "thin" || depth === "unknown") {
    gap = 1;
    notes.push(depth === "thin" ? "too little DEX liquidity to liquidate" : "liquidation depth could not be checked");
  }
  const lossRate = lossPerBorrowed(shock * gap, market.lltv);
  return { allocation, kind, shock, gap, lossRate, risk: lossRate * market.utilization, note: notes.join("; "), evidence };
}

/** The portfolio the curator could reach without waiting out the timelock: riskiest markets filled to their caps first. */
function worstPortfolio(stressed: Stressed[], total: number, now: number, timelockSeconds: number): number[] {
  const order = stressed.map((s, i) => i).sort((a, b) => stressed[b]!.risk - stressed[a]!.risk);
  const out = new Array<number>(stressed.length).fill(0);
  let remaining = total;
  for (const i of order) {
    const a = stressed[i]!.allocation;
    // A pending cap increase lands once its timelock passes; count it when that is inside one timelock from now.
    const pendingLands = a.pendingCapValidAt !== null && a.pendingCapValidAt <= now + timelockSeconds;
    const capacity = Math.max(a.cap, pendingLands ? a.pendingCap : 0, a.supply); // money already stuck over a cap stays
    const take = Math.min(capacity, remaining);
    out[i] = take;
    remaining -= take;
    if (remaining <= 0) break;
  }
  return out;
}

export function assess(vault: Vault, evidence: Map<string, MarketEvidence>, options: Options): Assessment {
  const total = vault.totalAssets;
  const stressed = vault.allocations.map((a) => stressMarket(a, evidence.get(a.market.id)));
  const timelockHours = vault.timelockSeconds / 3600;
  const capsBinding = timelockHours >= DEFAULTS.minTimelockHours;

  const lossNow = total > 0 ? stressed.reduce((sum, s) => sum + s.allocation.supply * s.risk, 0) / total : 0;
  const worst = worstPortfolio(stressed, total, options.now, vault.timelockSeconds);
  let lossWorst = total > 0 ? stressed.reduce((sum, s, i) => sum + worst[i]! * s.risk, 0) / total : 0;
  // With a short timelock the curator can add any market within hours, so the caps bound nothing.
  if (!capsBinding) lossWorst = Math.max(lossWorst, ...stressed.map((s) => s.risk), lossNow);
  lossWorst = Math.max(lossWorst, lossNow);

  let bedrock = 0;
  let untraceable = 0;
  for (const s of stressed) {
    const share = total > 0 ? s.allocation.supply / total : 0;
    if (s.kind === "idle" || s.kind === "anchor" || s.kind === "stable") bedrock += share;
    else if (s.kind === "vault" && s.evidence?.inner) {
      untraceable += share * s.evidence.inner.untraceableFraction;
      bedrock += share * s.evidence.inner.bedrockFraction;
    } else if (UNTRACEABLE.has(s.kind)) untraceable += share;
  }

  const amount = options.amountUsd;
  const exitNow = amount > 0 ? Math.min(1, vault.withdrawableUsd / amount) : 1;
  const afterRun = Math.max(0, vault.withdrawableUsd - options.runShare * vault.totalAssetsUsd);
  const exitRun = amount > 0 ? Math.min(1, afterRun / amount) : 1;

  const reasons: string[] = [];
  const untraceableNames = stressed
    .filter((s) => total > 0 && s.allocation.supply / total > 0.001 && s.kind !== "idle" && (UNTRACEABLE.has(s.kind as Kind) || (s.kind === "vault" && (s.evidence?.inner?.untraceableFraction ?? 1) > 0)))
    .map((s) => `${s.allocation.market.collateral!.symbol} (${s.kind})`);
  if (vault.totalAssets <= 0) reasons.push("vault is empty");
  const whoMoves = vault.protocol === "morpho" ? "what the curator is allowed to move into" : "what governance supply caps allow borrowers to post";
  if (pct(lossWorst) > options.maxLossPct) {
    reasons.push(`worst-case loss ${pct(lossWorst)}% exceeds your ${options.maxLossPct}% limit${pct(lossWorst) > pct(lossNow) + 0.5 ? ` (today's holdings: ${pct(lossNow)}%; the rest is ${whoMoves})` : ""}`);
  }
  if (pct(untraceable) > DEFAULTS.maxUntraceablePct) {
    reasons.push(`${pct(untraceable)}% sits on collateral that cannot be traced: ${untraceableNames.join(", ")}`);
  }
  if (pct(exitRun) < (options.minExitPct ?? DEFAULTS.minExitPct)) {
    reasons.push(vault.withdrawableUsd < 1
      ? "nothing can be withdrawn right now: all of its cash is lent out"
      : `if ${pct(options.runShare)}% of depositors leave first, only ${pct(exitRun)}% of your deposit comes out`);
  }
  if (!capsBinding) reasons.push(`timelock is ${round(timelockHours, 1)}h: ${vault.protocol === "morpho" ? "the curator" : "governance"} can move your money anywhere before you could react`);
  if (vault.netApy > 1 && reasons.length > 0) {
    reasons.push(`the ${round(vault.netApy * 100, 0).toLocaleString("en-US")}% APY is a symptom: rates max out when borrowers cannot be repaid and lenders cannot leave`);
  }

  return {
    vault: vault.address,
    name: vault.name,
    netApyPct: pct(vault.netApy),
    tvlUsd: Math.round(vault.totalAssetsUsd),
    verdict: reasons.length === 0 ? "pass" : "refuse",
    reasons,
    lossNowPct: pct(lossNow),
    lossWorstPct: pct(lossWorst),
    yourLossWorstUsd: round(amount * lossWorst),
    exitNowPct: pct(exitNow),
    exitRunPct: pct(exitRun),
    bedrockPct: pct(bedrock),
    untraceablePct: pct(untraceable),
    timelockHours: round(timelockHours, 1),
    capsBinding,
    markets: stressed
      .map((s, i) => ({
        collateral: s.allocation.market.collateral?.symbol ?? "idle",
        kind: s.kind,
        sharePct: total > 0 ? pct(s.allocation.supply / total) : 0,
        worstSharePct: total > 0 ? pct(worst[i]! / total) : 0,
        lltvPct: pct(s.allocation.market.lltv),
        utilizationPct: pct(s.allocation.market.utilization),
        oracle: s.evidence ? `${s.evidence.oracle.status}${s.evidence.oracle.detail ? ` (${s.evidence.oracle.detail})` : ""}` : s.kind === "idle" ? "-" : "unverified",
        depth: s.evidence ? `${s.evidence.depth.status}${s.evidence.depth.impactPct !== undefined ? ` (${s.evidence.depth.impactPct}% impact)` : ""}` : "-",
        shockPct: pct(s.shock),
        gapPct: pct(s.gap),
        lossRatePct: pct(s.lossRate),
        note: s.note,
      }))
      .filter((m) => m.sharePct > 0.01 || m.worstSharePct > 0.01),
  };
}

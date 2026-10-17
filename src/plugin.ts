import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { assess, DEFAULTS, type Assessment } from "./engine.js";
import { gatherEvidence } from "./evidence.js";
import { BASE_USDC, getVault, listVaults, type Vault } from "./morpho.js";
import { encodeAddress, encodeUint, ethCalls, SELECTORS, wordAt } from "./net.js";
import { atomicAmount, evmOutputSchema, proposeEvm } from "./paybox.js";
import { AAVE, isPool, loadAave, loadMoonwell, loadPool, MOONWELL } from "./pools.js";
import { STRESS } from "./registry.js";
import { isNotFound, probeUnknown, SUPPORTED } from "./unknown.js";

const PROTOCOL_VERSION = "2026-07-28";
const BASE = "eip155:8453";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "a 0x-prefixed 20-byte address");
const usdcAmount = z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/, "a USDC amount such as \"1\" or \"25.50\"");
const maxLossPct = z.number().min(0).max(100).default(DEFAULTS.maxLossPct)
  .describe("Refuse vaults whose worst-case stressed loss is above this percentage.");
const minExitPct = z.number().min(0).max(100).default(DEFAULTS.minExitPct)
  .describe("Refuse venues where less than this percentage of your deposit could come out if 30% of depositors left first. Lower it to accept slower exits (for example Aave).");

const summary = z.object({
  vault: z.string(), name: z.string(), netApyPct: z.number(), tvlUsd: z.number(),
  verdict: z.enum(["pass", "refuse"]), reasons: z.array(z.string()),
  lossNowPct: z.number(), lossWorstPct: z.number(), yourLossWorstUsd: z.number(),
  exitNowPct: z.number(), exitRunPct: z.number(), bedrockPct: z.number(), untraceablePct: z.number(),
  timelockHours: z.number(), capsBinding: z.boolean(),
}).strict();
const market = z.object({
  collateral: z.string(), kind: z.string(), sharePct: z.number(), worstSharePct: z.number(), lltvPct: z.number(),
  utilizationPct: z.number(), oracle: z.string(), depth: z.string(), shockPct: z.number(), gapPct: z.number(),
  lossRatePct: z.number(), note: z.string(),
}).strict();

const ASSUMPTIONS = `Stress: each collateral drops by its shock; liquidations catch all but the gap share; borrowers sit at the liquidation LTV; bad debt is shared by suppliers. Shock/gap by kind: ${Object.entries(STRESS).filter(([k]) => k !== "vault").map(([k, v]) => `${k} ${v.shock * 100}%/${v.gap * 100}%`).join(", ")}. A stale, constant or uninspectable oracle, or thin DEX depth, sets gap to 100%. Worst case = the portfolio the curator can reach within existing caps before the timelock lets you react. Run test: ${DEFAULTS.runShare * 100}% of depositors leave first.`;

const now = () => Math.floor(Date.now() / 1000);
const MAX_UINT = (1n << 256n) - 1n;
const POOL_SELECTORS = {
  supply: "0x617ba037", // Aave Pool.supply(address,uint256,address,uint16)
  withdraw: "0x69328dec", // Aave Pool.withdraw(address,uint256,address)
  mint: "0xa0712d68", // Moonwell mToken.mint(uint256)
  redeem: "0xdb006a75", // Moonwell mToken.redeem(uint256)
  redeemUnderlying: "0x852a12e3", // Moonwell mToken.redeemUnderlying(uint256)
  getCash: "0x3b1d21a2",
  exchangeRateStored: "0x182df0f5",
} as const;

/** Any supported venue by the address the tools report: a Morpho vault, Aave's aUSDC or pool, or Moonwell's mUSDC. */
const loadAny = (address: string): Promise<Vault> => (isPool(address) ? loadPool(address) : getVault(address));
const usd = (x: number) => `$${x.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const fail = (text: string) => ({ isError: true as const, content: [{ type: "text" as const, text }] });

function brief(a: Assessment) {
  const { markets: _markets, ...rest } = a;
  return rest;
}

function line(a: Assessment): string {
  const head = `${a.verdict === "pass" ? "PASS  " : "REFUSE"} ${a.name} (${a.vault}) — ${a.netApyPct}% APY, TVL ${usd(a.tvlUsd)}, worst-case loss ${a.lossWorstPct}%, exit in a run ${a.exitRunPct}%, traced to bedrock ${a.bedrockPct}%`;
  return a.reasons.length ? `${head}\n    ${a.reasons.join("\n    ")}` : head;
}

async function assessOne(vault: Vault, amountUsd: number, limit: number, minExit: number): Promise<Assessment> {
  const t = now();
  const evidence = await gatherEvidence([vault], t);
  return assess(vault, evidence, { amountUsd, maxLossPct: limit, minExitPct: minExit, runShare: DEFAULTS.runShare, now: t });
}

async function readUint(calls: { to: string; data: string }[]): Promise<bigint[]> {
  const results = await ethCalls(calls);
  return results.map((r, i) => {
    if (!r) throw new Error(`Base RPC did not answer ${calls[i]!.data.slice(0, 10)} on ${calls[i]!.to}`);
    return wordAt(r, 0);
  });
}

function createServer() {
  const server = new McpServer({ name: "undertow", version: "0.1.0" }, { supportedProtocolVersions: [PROTOCOL_VERSION] });

  server.registerTool("scan_vaults", {
    title: "Find a USDC savings vault on Base that survives a stress test",
    description: "Traces every Morpho USDC vault on Base, plus the Aave v3 and Moonwell USDC pools, through its collateral, checks oracles and liquidation depth, models what the curator is allowed to move into and whether you could exit in a run, then ranks the vaults that pass by yield. Read-only.",
    inputSchema: z.object({
      amountUsdc: usdcAmount.default("1").describe("How much you plan to deposit, in USDC."),
      maxLossPct,
      minExitPct,
      minTvlUsd: z.number().min(0).default(250_000).describe("Ignore vaults smaller than this."),
      limit: z.number().int().min(1).max(10).default(6),
    }).strict(),
    outputSchema: z.object({ asOf: z.string(), assumptions: z.string(), best: summary.nullable(), vaults: z.array(summary) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ amountUsdc, maxLossPct: limit, minExitPct: exit, minTvlUsd, limit: count }) => {
    try {
      const t = now();
      // Morpho is required; a pool whose data source is down is reported as skipped rather than sinking the scan.
      const [morpho, ...pools] = await Promise.allSettled([listVaults(BASE_USDC), loadAave(), loadMoonwell()]);
      if (morpho.status === "rejected") throw morpho.reason;
      const skipped = pools.flatMap((p, i) => (p.status === "rejected" ? [`${["Aave", "Moonwell"][i]} (${(p.reason as Error).message})`] : []));
      const vaults = [...morpho.value, ...pools.flatMap((p) => (p.status === "fulfilled" ? [p.value] : []))].filter((v) => v.totalAssetsUsd >= minTvlUsd);
      const evidence = await gatherEvidence(vaults, t);
      const options = { amountUsd: Number(amountUsdc), maxLossPct: limit, minExitPct: exit, runShare: DEFAULTS.runShare, now: t };
      const results = vaults.map((v) => assess(v, evidence, options));
      const passes = results.filter((r) => r.verdict === "pass").sort((a, b) => b.netApyPct - a.netApyPct);
      // After the passes, the highest-yield refusals: those are the traps a yield-chasing agent would pick.
      const refusals = results.filter((r) => r.verdict === "refuse").sort((a, b) => b.netApyPct - a.netApyPct);
      const best = passes[0] ?? null;
      const shown = [...passes.slice(0, Math.ceil(count / 2)), ...refusals].slice(0, count);
      const text = [
        best ? `Best vault that survives the stress test: ${best.name} at ${best.netApyPct}% APY (worst-case loss ${best.lossWorstPct}%).` : "No vault passes your limits. Undertow will not deposit.",
        `${passes.length} of ${results.length} vaults and pools pass (Morpho vaults, Aave v3, Moonwell).${skipped.length ? ` Skipped: ${skipped.join("; ")}.` : ""}`,
        ...shown.map(line),
      ].join("\n");
      return { content: [{ type: "text", text }], structuredContent: { asOf: new Date(t * 1000).toISOString(), assumptions: ASSUMPTIONS, best: best ? brief(best) : null, vaults: shown.map(brief) } };
    } catch (error) {
      return fail(`Could not complete the scan: ${(error as Error).message}. Nothing was assessed; retry explicitly.`);
    }
  });

  server.registerTool("xray_vault", {
    title: "X-ray one vault",
    description: "Full trace of one USDC venue on Base (a Morpho vault address, Aave's aUSDC 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB, or Moonwell's mUSDC 0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22; any other ERC-4626 vault is read on-chain and refused because its collateral cannot be traced): every market, what its collateral really is (recursing into vaults inside vaults), oracle health, liquidation depth, the curator's worst allowed portfolio, the run test, and a verdict. Read-only.",
    inputSchema: z.object({ vault: address, amountUsdc: usdcAmount.default("1"), maxLossPct, minExitPct }).strict(),
    outputSchema: summary.extend({ asOf: z.string(), assumptions: z.string(), markets: z.array(market) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ vault, amountUsdc, maxLossPct: limit, minExitPct: exit }) => {
    try {
      // An address no supported protocol knows still gets an on-chain look and an explained refusal.
      const a = await loadAny(vault).then((v) => assessOne(v, Number(amountUsdc), limit, exit), (error) => {
        if (isNotFound(error)) return probeUnknown(vault);
        throw error;
      });
      const rows = a.markets.map((m) => `  ${m.collateral} [${m.kind}] now ${m.sharePct}% / worst ${m.worstSharePct}% · LLTV ${m.lltvPct}% · borrowed ${m.utilizationPct}% · oracle ${m.oracle} · depth ${m.depth} · loss per borrowed $ ${m.lossRatePct}%`);
      const text = [line(a), `Today's holdings stressed: ${a.lossNowPct}%. Your worst case on ${usd(Number(amountUsdc))}: ${usd(a.yourLossWorstUsd)}.`, ...rows].join("\n");
      return { content: [{ type: "text", text }], structuredContent: { ...a, asOf: new Date().toISOString(), assumptions: ASSUMPTIONS } };
    } catch (error) {
      return fail(`Could not x-ray ${vault}: ${(error as Error).message}`);
    }
  });

  server.registerTool("propose_deposit", {
    title: "Deposit USDC into a vault that passes",
    description: "Re-runs the full x-ray and refuses unless the vault passes. If it passes, returns an unsigned Base transaction for PayBox: an exact-amount USDC approval when the allowance is short (call again after it confirms), otherwise the deposit itself. Shares go to `owner`, which must be the paying wallet.",
    inputSchema: z.object({ vault: address, amountUsdc: usdcAmount, owner: address.describe("The PayBox wallet that pays and receives the vault shares."), maxLossPct, minExitPct }).strict(),
    outputSchema: evmOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ vault, amountUsdc, owner, maxLossPct: limit, minExitPct: exit }) => {
    try {
      let v: Vault;
      try {
        v = await loadAny(vault);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        const unknown = await probeUnknown(vault);
        return fail(`Undertow refuses to deposit into ${unknown.name}:\n- ${unknown.reasons.join("\n- ")}\nNo transaction was proposed. Supported: ${SUPPORTED}.`);
      }
      if (v.asset.address !== BASE_USDC) return fail(`${v.name} takes ${v.asset.symbol}, not USDC.`);
      // Who must be approved, and which call deposits, depends on the venue.
      const spender = v.protocol === "aave" ? AAVE.pool : v.address;
      const amount = BigInt(atomicAmount(amountUsdc, 6));
      if (amount === 0n) return fail("Amount must be above zero.");
      const [a, [allowance, balance]] = await Promise.all([
        assessOne(v, Number(amountUsdc), limit, exit),
        readUint([
          { to: BASE_USDC, data: SELECTORS.allowance + encodeAddress(owner) + encodeAddress(spender) },
          { to: BASE_USDC, data: SELECTORS.balanceOf + encodeAddress(owner) },
        ]),
      ]);
      if (a.verdict !== "pass") return fail(`Undertow refuses to deposit into ${a.name}:\n- ${a.reasons.join("\n- ")}\nNo transaction was proposed.`);
      // An approval needs no balance, so step 1 is offered even to an empty wallet; the deposit itself does.
      if (allowance! < amount) {
        const proposal = proposeEvm({ chain: BASE, to: BASE_USDC, data: SELECTORS.approve + encodeAddress(spender) + encodeUint(amount) });
        proposal.content = [{ type: "text", text: `${a.name} passed (worst-case loss ${a.lossWorstPct}%, ${a.netApyPct}% APY). Step 1 of 2: approve exactly ${amountUsdc} USDC for ${v.name}. After it confirms, call propose_deposit again for the deposit itself.` }];
        return proposal;
      }
      if (balance! < amount) return fail(`${owner} holds ${Number(balance) / 1e6} USDC on Base, less than ${amountUsdc}. No transaction was proposed.`);
      const call = v.protocol === "aave"
        ? { to: AAVE.pool, data: POOL_SELECTORS.supply + encodeAddress(BASE_USDC) + encodeUint(amount) + encodeAddress(owner) + encodeUint(0n) }
        : v.protocol === "moonwell"
          ? { to: MOONWELL.mUsdc, data: POOL_SELECTORS.mint + encodeUint(amount) } // mTokens go to the signer, which is owner
          : { to: v.address, data: SELECTORS.deposit + encodeUint(amount) + encodeAddress(owner) };
      const proposal = proposeEvm({ chain: BASE, ...call });
      proposal.content = [{ type: "text", text: `${a.name} passed (worst-case loss ${a.lossWorstPct}%, ${a.netApyPct}% APY, traced to bedrock ${a.bedrockPct}%). Deposit ${amountUsdc} USDC; vault shares go to ${owner}.` }];
      return proposal;
    } catch (error) {
      return fail(`Could not prepare the deposit: ${(error as Error).message}. No transaction was proposed.`);
    }
  });

  server.registerTool("propose_withdraw", {
    title: "Withdraw everything you can from a vault",
    description: "Returns an unsigned Base transaction redeeming all of `owner`'s shares in the vault, or as many as the vault can pay out right now. Never blocked by the risk check: getting out is always allowed.",
    inputSchema: z.object({ vault: address, owner: address.describe("The PayBox wallet holding the vault shares.") }).strict(),
    outputSchema: evmOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ vault, owner }) => {
    try {
      if (isPool(vault)) return await withdrawFromPool(vault, owner);
      const [shares, redeemable] = await readUint([
        { to: vault, data: SELECTORS.balanceOf + encodeAddress(owner) },
        { to: vault, data: SELECTORS.maxRedeem + encodeAddress(owner) },
      ]);
      if (shares === 0n) return fail(`${owner} holds no shares in ${vault}.`);
      if (redeemable === 0n) return fail("The vault cannot pay anything out right now: the markets it lends to are fully borrowed. Try again later.");
      const take = redeemable! < shares! ? redeemable! : shares!;
      const share = Number((take * 10_000n) / shares!) / 100;
      const proposal = proposeEvm({ chain: BASE, to: vault, data: SELECTORS.redeem + encodeUint(take) + encodeAddress(owner) + encodeAddress(owner) });
      // maxRedeem rounds down by a few wei even when the vault is fully liquid; only call it partial when it matters.
      proposal.content = [{ type: "text", text: share < 99.9 ? `Only ${share}% of your position can leave right now (the rest is lent out); redeeming that much to ${owner}.` : `Redeeming your whole position to ${owner}.` }];
      return proposal;
    } catch (error) {
      return fail(`Could not prepare the withdrawal: ${(error as Error).message}. No transaction was proposed.`);
    }
  });

  return server;
}

async function withdrawFromPool(address: string, owner: string) {
  if (address.toLowerCase() === MOONWELL.mUsdc) {
    const [mTokens, rate, cash] = await readUint([
      { to: MOONWELL.mUsdc, data: SELECTORS.balanceOf + encodeAddress(owner) },
      { to: MOONWELL.mUsdc, data: POOL_SELECTORS.exchangeRateStored },
      { to: MOONWELL.mUsdc, data: POOL_SELECTORS.getCash },
    ]);
    if (mTokens === 0n) return fail(`${owner} has no USDC supplied to Moonwell.`);
    if (cash === 0n) return fail("Moonwell's USDC market has no cash to pay out right now: it is fully borrowed. Try again later.");
    const underlying = (mTokens! * rate!) / 10n ** 18n;
    const all = underlying <= cash!;
    const proposal = proposeEvm({ chain: BASE, to: MOONWELL.mUsdc, data: all ? POOL_SELECTORS.redeem + encodeUint(mTokens!) : POOL_SELECTORS.redeemUnderlying + encodeUint(cash!) });
    proposal.content = [{ type: "text", text: all ? `Withdrawing your whole Moonwell USDC position (about ${Number(underlying) / 1e6} USDC) to the signer, ${owner}.` : `Only ${Number(cash) / 1e6} of your ${Number(underlying) / 1e6} USDC can leave Moonwell now; withdrawing that much.` }];
    return proposal;
  }
  const [balance, cash] = await readUint([
    { to: AAVE.aUsdc, data: SELECTORS.balanceOf + encodeAddress(owner) },
    { to: BASE_USDC, data: SELECTORS.balanceOf + encodeAddress(AAVE.aUsdc) },
  ]);
  if (balance === 0n) return fail(`${owner} has no USDC supplied to Aave.`);
  if (cash === 0n) return fail("Aave's USDC pool has no cash to pay out right now: it is fully borrowed. Try again later.");
  // type(uint256).max withdraws the whole balance including interest accrued by the time it executes.
  const all = balance! <= cash!;
  const proposal = proposeEvm({ chain: BASE, to: AAVE.pool, data: POOL_SELECTORS.withdraw + encodeAddress(BASE_USDC) + encodeUint(all ? MAX_UINT : cash!) + encodeAddress(owner) });
  proposal.content = [{ type: "text", text: all ? `Withdrawing your whole Aave USDC position (about ${Number(balance) / 1e6} USDC) to ${owner}.` : `Only ${Number(cash) / 1e6} of your ${Number(balance) / 1e6} USDC can leave Aave now; withdrawing that much.` }];
  return proposal;
}

serveStdio(createServer, { legacy: "reject" });

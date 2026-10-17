import type { Assessment } from "./engine.js";
import { BASE_USDC } from "./morpho.js";
import { addressWord, encodeAddress, ethCalls, SELECTORS, wordAt } from "./net.js";

// An address that is not a Morpho vault, Aave or Moonwell. Undertow still reads what any
// ERC-4626 vault exposes on-chain (what it holds, how much, how much is withdrawable), then
// refuses: if the collateral cannot be traced, the deposit does not happen.

export const SUPPORTED = "Morpho USDC vaults, Aave v3 USDC and Moonwell USDC on Base";

const SEL = { totalAssets: "0x01e1d114", name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567" } as const;

export const isNotFound = (error: unknown) => /No results matching|No Morpho vault/i.test((error as Error)?.message ?? "");

function text(hex: string | null | undefined): string | null {
  if (!hex || hex.length < 2 + 128) return null;
  const length = Number(wordAt(hex, 1));
  return Buffer.from(hex.slice(2 + 128, 2 + 128 + length * 2), "hex").toString("utf8").replace(/[^\x20-\x7e]/g, "") || null;
}

export async function probeUnknown(address: string): Promise<Assessment> {
  const [asset, totalAssets, name] = await ethCalls([
    { to: address, data: SELECTORS.asset },
    { to: address, data: SEL.totalAssets },
    { to: address, data: SEL.name },
  ]);
  const underlying = addressWord(asset ?? null);
  if (!underlying || !totalAssets) {
    throw new Error(`${address} is not one of the supported venues (${SUPPORTED}) and is not a standard ERC-4626 vault, so there is nothing Undertow can inspect`);
  }
  // Idle cash the vault holds itself is the only exit liquidity visible without knowing its strategy.
  const [symbolHex, decimalsHex, idleHex] = await ethCalls([
    { to: underlying, data: SEL.symbol },
    { to: underlying, data: SEL.decimals },
    { to: underlying, data: SELECTORS.balanceOf + encodeAddress(address) },
  ]);
  const symbol = text(symbolHex) ?? "tokens";
  const decimals = decimalsHex ? Number(wordAt(decimalsHex, 0)) : 18;
  const total = Number(wordAt(totalAssets, 0)) / 10 ** decimals;
  const idle = idleHex ? Number(wordAt(idleHex, 0)) / 10 ** decimals : 0;
  const isUsdc = underlying === BASE_USDC;
  const fmt = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const idleShare = total > 0 ? Math.min(100, Math.round((idle / total) * 10_000) / 100) : 0;

  return {
    vault: address.toLowerCase(),
    name: text(name) ?? "Unknown vault",
    netApyPct: 0,
    tvlUsd: isUsdc ? Math.round(total) : 0,
    verdict: "refuse",
    reasons: [
      `not a supported protocol (${SUPPORTED}): Undertow can see it is an ERC-4626 vault holding ${fmt(total)} ${symbol}, ${fmt(idle)} of it as idle cash, but cannot see what the rest is lent against or invested in`,
      "collateral that cannot be traced is treated as a total loss, so Undertow will not deposit here",
      ...(isUsdc ? [] : [`it takes ${symbol}, not USDC`]),
    ],
    lossNowPct: 100,
    lossWorstPct: 100,
    yourLossWorstUsd: 0,
    exitNowPct: idleShare,
    exitRunPct: idleShare,
    bedrockPct: idleShare,
    untraceablePct: Math.round((100 - idleShare) * 100) / 100,
    timelockHours: 0,
    capsBinding: false,
    markets: [{
      collateral: "unknown strategy", kind: "opaque", sharePct: Math.round((100 - idleShare) * 100) / 100, worstSharePct: 100,
      lltvPct: 0, utilizationPct: 0, oracle: "not visible", depth: "not checked", shockPct: 100, gapPct: 100, lossRatePct: 100,
      note: "unsupported protocol: strategy not traceable on-chain",
    }],
  };
}

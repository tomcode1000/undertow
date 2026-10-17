// What sits underneath each collateral token, and how hard Undertow stresses it.
// These are stated assumptions, printed in every result; they are not hidden scores.
//   shock: instant price drop in the stress scenario (0..1)
//   gap:   share of that drop liquidations cannot catch, even when they work (0..1)

export type Kind =
  | "anchor" // blue-chip asset with deep markets
  | "stable" // major fiat-backed stablecoin
  | "restaked" // liquid restaking token (rsETH-style exploit risk)
  | "custodial" // wrapped asset held by a custodian
  | "volatile" // native token with thinner markets
  | "synthetic" // dollar backed by hedged or off-chain positions
  | "offchain" // tokenised fund whose backing is off-chain
  | "first-loss" // junior tranche that absorbs losses first
  | "vault" // itself a Morpho vault: traced recursively
  | "wrapper" // ERC-4626 vault outside Morpho: strategy not visible
  | "opaque"; // nothing verifiable known

export const STRESS: Record<Kind, { shock: number; gap: number; note: string }> = {
  anchor: { shock: 0.4, gap: 0.25, note: "blue-chip; liquidations normally keep up" },
  stable: { shock: 0.1, gap: 0.5, note: "fiat-backed stablecoin" },
  restaked: { shock: 0.5, gap: 0.5, note: "restaking token; exploit risk (rsETH, Apr 2026)" },
  custodial: { shock: 0.6, gap: 0.5, note: "custodian-wrapped asset" },
  volatile: { shock: 0.7, gap: 0.5, note: "volatile token with thinner markets" },
  synthetic: { shock: 0.77, gap: 1, note: "synthetic dollar; xUSD fell 77% in a day (Nov 2025)" },
  offchain: { shock: 0.77, gap: 1, note: "backing held off-chain; cannot be verified on-chain" },
  "first-loss": { shock: 1, gap: 1, note: "first-loss tranche; wiped first in a failure" },
  vault: { shock: 0, gap: 1, note: "Morpho vault; shock is its own traced stressed loss" },
  wrapper: { shock: 0.5, gap: 1, note: "ERC-4626 wrapper; strategy behind it is not visible" },
  opaque: { shock: 0.77, gap: 1, note: "unknown backing; treated like xUSD" },
};

/** The kinds that cannot be traced to anything verifiable. */
export const UNTRACEABLE: ReadonlySet<Kind> = new Set(["synthetic", "offchain", "first-loss", "wrapper", "opaque"]);

const BY_SYMBOL: [RegExp, Kind][] = [
  [/^(W?ETH|cbBTC|WBTC|tBTC|LBTC|cbETH|wstETH|rETH)$/i, "anchor"],
  [/^(USDC|USDbC|USDT|DAI|USDS|EURC|PYUSD|GHO)$/i, "stable"],
  [/^(weETH|ezETH|wrsETH|rsETH|pufETH|wsuperOETHb|superOETHb)$/i, "restaked"],
  [/^RLP$/i, "first-loss"],
  [/^m[A-Z][A-Za-z0-9]*$/, "offchain"], // Midas mTokens: mTBILL, mBASIS, mGLO, mEDGE...
  [/^(syrupUSDC|syrupUSDT)$/i, "offchain"], // Maple: off-chain credit
  [/^(s?USDe|s?USR|wstUSR|aprUSR|xUSD|deUSD|sdeUSD|USD0\+\+|s?USDz|s?avUSD|s?USDai)$/i, "synthetic"],
  [/^(uniBTC|cbXRP|cbDOGE|cbLTC|cbADA|cbZEC|cbHYPE|cbSOL)$/i, "custodial"],
  [/^(AERO|VIRTUAL|BRETT|DEGEN|WELL|MORPHO|ZRO|EIGEN)$/i, "volatile"],
];

export function classifySymbol(symbol: string): Kind | null {
  // Pendle principal tokens settle into their underlying: PT-USR-25SEP2025 behaves like USR.
  const base = symbol.replace(/^PT-/i, "").replace(/-\d{1,2}[A-Z]{3}\d{4}$/i, "");
  for (const [pattern, kind] of BY_SYMBOL) if (pattern.test(base)) return kind;
  return null;
}

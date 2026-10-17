import { BASE_USDC, type Allocation, type Market, type Vault } from "./morpho.js";
import { addressWord, encodeAddress, ethCalls, fetchJson, wordAt } from "./net.js";

// Aave v3 and Moonwell are shared pools, not curated vaults: every USDC lender is exposed to
// every borrower, and a borrower can post any listed collateral. Undertow maps a pool onto the
// same shape as a vault so one engine stresses both:
//   - each collateral becomes a "market" holding the slice of USDC loans it backs, weighted by
//     borrowing power (collateral value x liquidation threshold);
//   - the curator's caps become governance supply caps (the worst case is every collateral at its cap);
//   - the pool's unborrowed cash is the idle slice and the exit liquidity.

export const AAVE = {
  pool: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5",
  aUsdc: "0x4e65fe4dba92790696d040ac24aa414708f5c0ab",
  oracle: "0x2cc0fc26ed4563a5ce5e8bdcfe1a2878676ae156",
  api: "https://api.v3.aave.com/graphql",
} as const;

export const MOONWELL = {
  comptroller: "0xfbb21d0380bee3312b33c4353c8936a0f13ef26c",
  oracle: "0xec942be8a8114bfd0396a5052c36027f2ca6a9d0",
  mUsdc: "0xedc817a28e8b93b03976fbd4a3ddbc9f7d176c22",
} as const;

/** Governance changes need a vote plus an executor delay; at least a day on both protocols. */
const GOVERNANCE_DELAY_SECONDS = 86_400;

const SEL = {
  getSourceOfAsset: "0x92bf2be0",
  getAllMarkets: "0xb0772d0b",
  markets: "0x8e8f294b",
  underlying: "0x6f307dc3",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
  exchangeRateStored: "0x182df0f5",
  getUnderlyingPrice: "0xfc57d4df",
  supplyCaps: "0x02c3bcbb",
  totalBorrows: "0x47bd3718",
  getCash: "0x3b1d21a2",
  supplyRatePerTimestamp: "0xd3bd2c72",
} as const;

type Collateral = {
  address: string; // underlying token
  symbol: string;
  decimals: number;
  priceUsd: number;
  liquidationThreshold: number; // 0..1
  supplyUsd: number;
  capUsd: number; // Infinity when uncapped
  oracleSource: string | null; // feed or adapter to inspect; null when only a price is readable
};

type PoolSnapshot = {
  protocol: "aave" | "moonwell";
  address: string; // what the user passes back: aUSDC or mUSDC
  name: string;
  supplyUsd: number;
  borrowUsd: number;
  cashUsd: number;
  apy: number;
  collateral: Collateral[];
};

/** Turns a pool into the vault shape the engine stresses. */
export function poolToVault(p: PoolSnapshot): Vault {
  const total = p.supplyUsd;
  const lent = Math.min(p.borrowUsd, total);
  const usable = p.collateral.filter((c) => c.liquidationThreshold > 0 && c.supplyUsd > 0);
  const weightNow = usable.map((c) => c.supplyUsd * c.liquidationThreshold);
  // Uncapped collateral can only grow, so it counts at least at today's size in the worst case.
  const weightCap = usable.map((c, i) => (Number.isFinite(c.capUsd) ? Math.max(c.capUsd, c.supplyUsd) * c.liquidationThreshold : weightNow[i]!));
  const sumNow = weightNow.reduce((a, b) => a + b, 0) || 1;
  const sumCap = weightCap.reduce((a, b) => a + b, 0) || 1;

  const allocations: Allocation[] = usable.map((c, i) => {
    const backing = (lent * weightNow[i]!) / sumNow;
    const market: Market = {
      id: `${p.protocol}:${c.address}`,
      lltv: c.liquidationThreshold,
      collateral: { address: c.address, symbol: c.symbol, decimals: c.decimals, priceUsd: c.priceUsd, morphoVault: null },
      oracle: { address: c.oracleSource ?? "", type: c.oracleSource ? "PoolFeed" : "PoolPrice", feeds: c.oracleSource ? [{ address: c.oracleSource, role: "base" }] : [], exchangeRateVault: null },
      utilization: 1, // this slice is, by construction, entirely lent out
      supplyUsd: backing,
      borrowUsd: backing, // what liquidators would have to sell to cover it
      liquidityUsd: 0,
    };
    return { market, supply: backing, supplyUsd: backing, cap: (lent * weightCap[i]!) / sumCap, pendingCap: 0, pendingCapValidAt: null };
  });
  const cash = Math.max(0, total - lent);
  allocations.push({
    market: { id: `${p.protocol}:cash`, lltv: 0, collateral: null, oracle: null, utilization: 0, supplyUsd: cash, borrowUsd: 0, liquidityUsd: cash },
    supply: cash, supplyUsd: cash, cap: cash, pendingCap: 0, pendingCapValidAt: null,
  });

  return {
    protocol: p.protocol,
    address: p.address,
    name: p.name,
    asset: { address: BASE_USDC, symbol: "USDC", decimals: 6 },
    totalAssets: total,
    totalAssetsUsd: total,
    netApy: p.apy,
    timelockSeconds: GOVERNANCE_DELAY_SECONDS,
    curator: null,
    withdrawableUsd: p.cashUsd,
    allocations,
  };
}

// ---------- Aave v3 (Base) ----------

type AaveReserve = {
  underlyingToken: { symbol: string; address: string; decimals: number };
  aToken: { address: string };
  isFrozen: boolean;
  isPaused: boolean;
  usdExchangeRate: string;
  supplyInfo: { apy: { value: string }; total: { value: string }; supplyCap: { amount: { value: string } }; canBeCollateral: boolean; liquidationThreshold: { value: string } };
  borrowInfo: { total: { usd: string }; availableLiquidity: { usd: string } } | null;
};

export async function loadAave(): Promise<Vault> {
  const body = (await fetchJson(AAVE.api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: `{ markets(request: { chainIds: [8453] }) { address reserves {
      underlyingToken { symbol address decimals } aToken { address } isFrozen isPaused usdExchangeRate
      supplyInfo { apy { value } total { value } supplyCap { amount { value } } canBeCollateral liquidationThreshold { value } }
      borrowInfo { total { usd } availableLiquidity { usd } } } } }` }),
  }, 5_000)) as { data?: { markets: { address: string; reserves: AaveReserve[] }[] }; errors?: { message: string }[] };
  if (body.errors?.length || !body.data) throw new Error(`Aave API: ${body.errors?.[0]?.message ?? "no data"}`);
  const market = body.data.markets.find((m) => m.address.toLowerCase() === AAVE.pool);
  if (!market) throw new Error("Aave API has no Base v3 market");
  const usdc = market.reserves.find((r) => r.underlyingToken.address.toLowerCase() === BASE_USDC);
  if (!usdc?.borrowInfo) throw new Error("Aave API has no Base USDC reserve");

  const collateral = market.reserves.filter((r) => r.supplyInfo.canBeCollateral && !r.isPaused && Number(r.supplyInfo.liquidationThreshold.value) > 0);
  // The oracle source for each collateral: a Chainlink feed (has a timestamp) or a price adapter (does not).
  const sources = await ethCalls(collateral.map((r) => ({ to: AAVE.oracle, data: SEL.getSourceOfAsset + encodeAddress(r.underlyingToken.address) })));

  const price = (r: AaveReserve) => Number(r.usdExchangeRate);
  return poolToVault({
    protocol: "aave",
    address: AAVE.aUsdc,
    name: "Aave v3 USDC (Base)",
    supplyUsd: Number(usdc.supplyInfo.total.value) * price(usdc),
    borrowUsd: Number(usdc.borrowInfo.total.usd),
    cashUsd: Number(usdc.borrowInfo.availableLiquidity.usd),
    apy: Number(usdc.supplyInfo.apy.value),
    collateral: collateral.map((r, i) => {
      const cap = Number(r.supplyInfo.supplyCap.amount.value);
      return {
        address: r.underlyingToken.address.toLowerCase(),
        symbol: r.underlyingToken.symbol,
        decimals: r.underlyingToken.decimals,
        priceUsd: price(r),
        liquidationThreshold: Number(r.supplyInfo.liquidationThreshold.value),
        supplyUsd: Number(r.supplyInfo.total.value) * price(r),
        capUsd: cap > 0 ? cap * price(r) : Infinity,
        oracleSource: addressWord(sources[i] ?? null),
      };
    }),
  });
}

// ---------- Moonwell (Base) ----------

const word = (hex: string | null | undefined, i = 0) => (hex ? wordAt(hex, i) : null);

function decodeString(hex: string | null | undefined): string {
  if (!hex || hex.length < 2 + 128) return "?";
  const length = Number(wordAt(hex, 1));
  return Buffer.from(hex.slice(2 + 128, 2 + 128 + length * 2), "hex").toString("utf8");
}

export async function loadMoonwell(): Promise<Vault> {
  const [all] = await ethCalls([{ to: MOONWELL.comptroller, data: SEL.getAllMarkets }]);
  if (!all) throw new Error("Moonwell comptroller did not answer");
  const count = Number(wordAt(all, 1));
  const mTokens = Array.from({ length: count }, (_, i) => `0x${all.slice(2 + 128 + i * 64 + 24, 2 + 128 + (i + 1) * 64)}`);

  const PER = 8;
  const results = await ethCalls(mTokens.flatMap((m) => [
    { to: m, data: SEL.underlying },
    { to: m, data: SEL.symbol },
    { to: m, data: SEL.totalSupply },
    { to: m, data: SEL.exchangeRateStored },
    { to: MOONWELL.oracle, data: SEL.getUnderlyingPrice + encodeAddress(m) },
    { to: MOONWELL.comptroller, data: SEL.markets + encodeAddress(m) },
    { to: MOONWELL.comptroller, data: SEL.supplyCaps + encodeAddress(m) },
    { to: m, data: SEL.totalBorrows },
  ]));
  const underlyings = mTokens.map((_, i) => addressWord(results[i * PER] ?? null));
  const decimals = await ethCalls(underlyings.map((u) => ({ to: u ?? MOONWELL.comptroller, data: SEL.decimals })));

  const [cash, rate] = await ethCalls([
    { to: MOONWELL.mUsdc, data: SEL.getCash },
    { to: MOONWELL.mUsdc, data: SEL.supplyRatePerTimestamp },
  ]);

  let usdcSupplyUsd = 0;
  let usdcBorrowUsd = 0;
  const collateral: Collateral[] = [];
  mTokens.forEach((m, i) => {
    const r = (k: number) => results[i * PER + k];
    const underlying = underlyings[i];
    const priceRaw = word(r(4));
    const listed = word(r(5), 0) === 1n;
    if (!underlying || !priceRaw || !listed) return;
    const dec = Number(word(decimals[i]) ?? 18n);
    // Compound-style prices are scaled by 1e(36 - decimals): USD = baseUnits x price / 1e36.
    const usd = (baseUnits: bigint) => Number((baseUnits * priceRaw) / 10n ** 18n) / 1e18;
    const supplied = ((word(r(2)) ?? 0n) * (word(r(3)) ?? 0n)) / 10n ** 18n;
    const cap = word(r(6)) ?? 0n;
    if (m === MOONWELL.mUsdc) {
      usdcSupplyUsd = usd(supplied);
      usdcBorrowUsd = usd(word(r(7)) ?? 0n);
    }
    const symbol = decodeString(r(1)).replace(/^m/, ""); // mcbBTC -> cbBTC
    collateral.push({
      address: underlying,
      symbol,
      decimals: dec,
      priceUsd: Number(priceRaw) / 10 ** (36 - dec),
      liquidationThreshold: Number(word(r(5), 1) ?? 0n) / 1e18,
      supplyUsd: usd(supplied),
      capUsd: cap > 0n ? usd(cap) : Infinity,
      oracleSource: null, // Moonwell's oracle exposes prices, not its feeds' update times
    });
  });
  if (!usdcSupplyUsd) throw new Error("Moonwell USDC market did not answer");

  const perSecond = Number(word(rate) ?? 0n) / 1e18;
  return poolToVault({
    protocol: "moonwell",
    address: MOONWELL.mUsdc,
    name: "Moonwell USDC (Base)",
    supplyUsd: usdcSupplyUsd,
    borrowUsd: usdcBorrowUsd,
    cashUsd: Number(word(cash) ?? 0n) / 1e6,
    apy: Math.expm1(perSecond * 31_536_000),
    collateral,
  });
}

export const isPool = (address: string) => ([AAVE.aUsdc, AAVE.pool, MOONWELL.mUsdc] as string[]).includes(address.toLowerCase());

export async function loadPool(address: string): Promise<Vault> {
  const a = address.toLowerCase();
  return a === MOONWELL.mUsdc ? loadMoonwell() : loadAave();
}


import { graphql } from "./net.js";

export const BASE_CHAIN_ID = 8453;
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

export type Feed = { address: string; role: "base" | "quote" };

export type Market = {
  id: string;
  lltv: number; // 0..1
  collateral: { address: string; symbol: string; decimals: number; priceUsd: number | null; morphoVault: string | null } | null;
  oracle: { address: string; type: string; feeds: Feed[]; exchangeRateVault: string | null } | null;
  utilization: number; // 0..1
  supplyUsd: number;
  borrowUsd: number;
  liquidityUsd: number;
};

export type Allocation = {
  market: Market;
  supply: number; // in vault asset units (e.g. USDC)
  supplyUsd: number;
  cap: number; // in vault asset units; Infinity when effectively unbounded
  pendingCap: number;
  pendingCapValidAt: number | null; // unix seconds
};

export type Vault = {
  protocol: "morpho" | "aave" | "moonwell";
  address: string;
  name: string;
  asset: { address: string; symbol: string; decimals: number };
  totalAssets: number; // asset units
  totalAssetsUsd: number;
  netApy: number; // 0.0472 = 4.72%
  timelockSeconds: number;
  curator: string | null;
  withdrawableUsd: number;
  allocations: Allocation[];
};

const FEEDS = "baseFeedOne { address } baseFeedTwo { address } quoteFeedOne { address } quoteFeedTwo { address } baseOracleVault { address }";

const VAULT_FIELDS = `
  address name
  asset { address symbol decimals }
  liquidity { underlying usd }
  state {
    totalAssets totalAssetsUsd netApy timelock curator
    allocation {
      supplyAssets supplyAssetsUsd supplyCap pendingSupplyCap pendingSupplyCapValidAt
      market {
        marketId lltv
        collateralAsset { address symbol decimals price { usd } vault { address } }
        oracle { address type data {
          ... on MorphoChainlinkOracleV2Data { ${FEEDS} }
          ... on MorphoChainlinkOracleData { ${FEEDS} }
        } }
        state { utilization supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd }
      }
    }
  }`;

type RawAddress = { address: string } | null | undefined;
type RawVault = {
  address: string;
  name: string;
  asset: { address: string; symbol: string; decimals: number };
  liquidity: { underlying: string | number | null; usd: number | null } | null;
  state: {
    totalAssets: string | number;
    totalAssetsUsd: number | null;
    netApy: number | null;
    timelock: string | number | null;
    curator: string | null;
    allocation: {
      supplyAssets: string | number;
      supplyAssetsUsd: number | null;
      supplyCap: string | number;
      pendingSupplyCap: string | number | null;
      pendingSupplyCapValidAt: string | number | null;
      market: {
        marketId: string;
        lltv: string | number;
        collateralAsset: { address: string; symbol: string; decimals: number; price: { usd: number | null } | null; vault: RawAddress } | null;
        oracle: { address: string; type: string; data: Record<string, RawAddress> | null } | null;
        state: { utilization: number | null; supplyAssetsUsd: number | null; borrowAssetsUsd: number | null; liquidityAssetsUsd: number | null } | null;
      };
    }[];
  } | null;
};

/** Converts an on-chain integer amount to a float in token units; huge sentinel caps become Infinity. */
export function units(raw: string | number | null | undefined, decimals: number): number {
  if (raw === null || raw === undefined) return 0;
  const big = BigInt(typeof raw === "number" ? Math.trunc(raw) : raw);
  if (big > 10n ** BigInt(decimals + 15)) return Infinity; // over a quadrillion tokens: treat as "no cap"
  return Number(big) / 10 ** decimals;
}

function normalize(raw: RawVault): Vault {
  const decimals = raw.asset.decimals;
  const state = raw.state;
  if (!state) throw new Error(`Morpho API has no state for vault ${raw.address}`);
  return {
    protocol: "morpho",
    address: raw.address.toLowerCase(),
    name: raw.name,
    asset: { address: raw.asset.address.toLowerCase(), symbol: raw.asset.symbol, decimals },
    totalAssets: units(state.totalAssets, decimals),
    totalAssetsUsd: state.totalAssetsUsd ?? 0,
    netApy: state.netApy ?? 0,
    timelockSeconds: Number(state.timelock ?? 0),
    curator: state.curator && !/^0x0{40}$/i.test(state.curator) ? state.curator : null,
    withdrawableUsd: raw.liquidity?.usd ?? 0,
    allocations: state.allocation.map((a) => {
      const m = a.market;
      const data = m.oracle?.data ?? null;
      const feeds: Feed[] = [];
      for (const [key, role] of [["baseFeedOne", "base"], ["baseFeedTwo", "base"], ["quoteFeedOne", "quote"], ["quoteFeedTwo", "quote"]] as const) {
        const feed = data?.[key];
        if (feed?.address && !/^0x0{40}$/i.test(feed.address)) feeds.push({ address: feed.address.toLowerCase(), role });
      }
      const exchangeRateVault = data?.baseOracleVault?.address && !/^0x0{40}$/i.test(data.baseOracleVault.address) ? data.baseOracleVault.address.toLowerCase() : null;
      const c = m.collateralAsset;
      return {
        supply: units(a.supplyAssets, decimals),
        supplyUsd: a.supplyAssetsUsd ?? 0,
        cap: units(a.supplyCap, decimals),
        pendingCap: units(a.pendingSupplyCap, decimals),
        pendingCapValidAt: a.pendingSupplyCapValidAt ? Number(a.pendingSupplyCapValidAt) : null,
        market: {
          id: m.marketId,
          lltv: Number(BigInt(m.lltv)) / 1e18,
          collateral: c ? { address: c.address.toLowerCase(), symbol: c.symbol, decimals: c.decimals, priceUsd: c.price?.usd ?? null, morphoVault: c.vault?.address?.toLowerCase() ?? null } : null,
          oracle: m.oracle ? { address: m.oracle.address.toLowerCase(), type: m.oracle.type, feeds, exchangeRateVault } : null,
          utilization: m.state?.utilization ?? 0,
          supplyUsd: m.state?.supplyAssetsUsd ?? 0,
          borrowUsd: m.state?.borrowAssetsUsd ?? 0,
          liquidityUsd: m.state?.liquidityAssetsUsd ?? 0,
        },
      };
    }),
  };
}

export async function listVaults(assetAddress: string, first = 100): Promise<Vault[]> {
  const data = await graphql<{ vaults: { items: RawVault[] } }>(
    `query($chain: Int!, $asset: String!, $first: Int!) {
      vaults(first: $first, orderBy: TotalAssetsUsd, orderDirection: Desc,
             where: { chainId_in: [$chain], assetAddress_in: [$asset] }) { items { ${VAULT_FIELDS} } }
    }`,
    { chain: BASE_CHAIN_ID, asset: assetAddress, first },
  );
  return data.vaults.items.filter((v) => v.state).map(normalize);
}

export async function getVault(address: string): Promise<Vault> {
  const data = await graphql<{ vaultByAddress: RawVault | null }>(
    `query($address: String!, $chain: Int!) { vaultByAddress(address: $address, chainId: $chain) { ${VAULT_FIELDS} } }`,
    { address, chain: BASE_CHAIN_ID },
  );
  if (!data.vaultByAddress) throw new Error(`No Morpho vault at ${address} on Base`);
  return normalize(data.vaultByAddress);
}

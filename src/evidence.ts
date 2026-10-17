import { assess, DEFAULTS, type MarketEvidence, type OracleStatus } from "./engine.js";
import { getVault, BASE_USDC, type Market, type Vault } from "./morpho.js";
import { addressWord, ethCalls, fetchJson, HOSTS, SELECTORS, wordAt } from "./net.js";
import { classifySymbol, type Kind } from "./registry.js";

const STALE_AFTER_SECONDS = 48 * 3600; // Chainlink heartbeats are at most 24h; twice that is broken.
const MAX_DEPTH_QUOTES = 16;
const MAX_TRACE_DEPTH = 2;
const THIN_IMPACT = 0.1; // liquidators walk away when selling costs more than 10%

const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

/** Everything Undertow knows about each market, keyed by Morpho market id. */
export async function gatherEvidence(vaults: Vault[], now: number, depth = 0, visited = new Set<string>()): Promise<Map<string, MarketEvidence>> {
  for (const v of vaults) visited.add(v.address);
  const markets = new Map<string, Market>();
  for (const v of vaults) for (const a of v.allocations) if (a.market.collateral) markets.set(a.market.id, a.market);

  // 1. What each collateral is: Morpho vault > known token > ERC-4626 wrapper (on-chain probe) > opaque.
  const kinds = new Map<string, Kind | null>();
  const probe: string[] = [];
  for (const m of markets.values()) {
    const c = m.collateral!;
    const kind = c.morphoVault ? "vault" : classifySymbol(c.symbol);
    kinds.set(c.address, kind);
    if (!kind && !probe.includes(c.address)) probe.push(c.address);
  }

  // 2. One RPC batch: every oracle feed's latest round, plus asset() on unknown collateral.
  const feeds = [...new Set([...markets.values()].flatMap((m) => m.oracle?.feeds.map((f) => f.address) ?? []))];
  const calls = [
    ...feeds.map((to) => ({ to, data: SELECTORS.latestRoundData })),
    ...probe.map((to) => ({ to, data: SELECTORS.asset })),
  ];

  const [rpc, quotes, inner] = await Promise.all([
    ethCalls(calls), // an unreachable RPC aborts the assessment instead of marking every oracle unverified
    depthQuotes([...markets.values()], kinds),
    depth < MAX_TRACE_DEPTH ? traceInnerVaults([...markets.values()], now, depth, visited) : Promise.resolve(new Map()),
  ]);

  const feedUpdatedAt = new Map<string, number | null>();
  feeds.forEach((address, i) => {
    const result = rpc[i];
    feedUpdatedAt.set(address, result && result.length >= 2 + 64 * 5 ? Number(wordAt(result, 3)) : null);
  });
  probe.forEach((address, i) => {
    kinds.set(address, addressWord(rpc[feeds.length + i] ?? null) ? "wrapper" : "opaque");
  });

  const out = new Map<string, MarketEvidence>();
  for (const m of markets.values()) {
    const c = m.collateral!;
    const kind = kinds.get(c.address) ?? "opaque";
    const evidence: MarketEvidence = {
      kind,
      oracle: oracleStatus(m, feedUpdatedAt, now),
      depth: kind === "anchor" || kind === "stable" ? { status: "not-checked" } : quotes.get(m.id) ?? { status: "unknown" },
    };
    if (kind === "vault") {
      const traced = inner.get(c.morphoVault!);
      evidence.inner = traced ?? { vault: c.morphoVault!, name: c.symbol, lossFraction: 1, untraceableFraction: 1, bedrockFraction: 0, cycle: visited.has(c.morphoVault!) };
    }
    out.set(m.id, evidence);
  }
  return out;
}

function oracleStatus(m: Market, updatedAt: Map<string, number | null>, now: number): { status: OracleStatus; detail: string } {
  const oracle = m.oracle;
  if (!oracle) return { status: "unverified", detail: "no oracle data" };
  // Shared pools (Aave, Moonwell): a protocol oracle per asset. A Chainlink feed behind it can be
  // timed; an adapter only gives a price.
  if (oracle.type === "PoolPrice" || oracle.type === "PoolFeed") {
    if (!m.collateral?.priceUsd) return { status: "unverified", detail: "protocol oracle gave no price" };
    const at = oracle.feeds[0] ? updatedAt.get(oracle.feeds[0].address) : null;
    if (at === null || at === undefined) return { status: "adapter", detail: oracle.type === "PoolFeed" ? "price adapter, no update time" : "protocol oracle, no update time" };
    if (now - at > STALE_AFTER_SECONDS) return { status: "stale", detail: `last update ${day(at)}` };
    return { status: "live", detail: "" };
  }
  if (oracle.type !== "ChainlinkOracleV2" && oracle.type !== "ChainlinkOracle") return { status: "unverified", detail: `${oracle.type} oracle cannot be inspected` };
  for (const feed of oracle.feeds) {
    const at = updatedAt.get(feed.address);
    if (at === null || at === undefined) return { status: "unverified", detail: `feed ${feed.address.slice(0, 10)}… did not answer` };
    if (now - at > STALE_AFTER_SECONDS) return { status: "stale", detail: `last update ${day(at)}` };
  }
  const hasBaseFeed = oracle.feeds.some((f) => f.role === "base");
  if (oracle.exchangeRateVault) return { status: "exchange-rate", detail: "prices collateral by its vault share rate" };
  if (!hasBaseFeed) return { status: "constant", detail: "collateral price is hard-coded" };
  return { status: "live", detail: "" };
}

/** Sells each risky market's borrowed value of collateral through KyberSwap to see whether liquidations could clear. */
async function depthQuotes(markets: Market[], kinds: Map<string, Kind | null>): Promise<Map<string, MarketEvidence["depth"]>> {
  const candidates = markets
    .filter((m) => {
      const kind = kinds.get(m.collateral!.address);
      return kind !== "anchor" && kind !== "stable" && m.borrowUsd > 1_000 && m.collateral!.priceUsd;
    })
    .sort((a, b) => b.borrowUsd - a.borrowUsd)
    .slice(0, MAX_DEPTH_QUOTES);
  const out = new Map<string, MarketEvidence["depth"]>();
  await Promise.all(candidates.map(async (m) => {
    const c = m.collateral!;
    const sizeUsd = m.borrowUsd;
    const amountIn = BigInt(Math.floor((sizeUsd / c.priceUsd!) * 10 ** c.decimals));
    if (amountIn <= 0n) return;
    const url = `${HOSTS.kyber}?tokenIn=${c.address}&tokenOut=${BASE_USDC}&amountIn=${amountIn}`;
    try {
      const body = (await fetchJson(url, { headers: { "x-client-id": "undertow" } }, 3_000)) as { data?: { routeSummary?: { amountOutUsd?: string } } };
      const outUsd = Number(body.data?.routeSummary?.amountOutUsd ?? 0);
      if (!outUsd) return void out.set(m.id, { status: "thin", impactPct: 100 });
      const impact = Math.max(0, 1 - outUsd / sizeUsd);
      out.set(m.id, { status: impact > THIN_IMPACT ? "thin" : "deep", impactPct: Math.round(impact * 1000) / 10 });
    } catch {
      // No route or no answer: leave it unknown, which counts against the market.
    }
  }));
  return out;
}

/** Collateral that is itself a Morpho vault is assessed on its own, one level down. */
async function traceInnerVaults(markets: Market[], now: number, depth: number, visited: Set<string>): Promise<Map<string, NonNullable<MarketEvidence["inner"]>>> {
  const targets = [...new Set(markets.map((m) => m.collateral?.morphoVault).filter((v): v is string => !!v && !visited.has(v)))];
  const out = new Map<string, NonNullable<MarketEvidence["inner"]>>();
  await Promise.all(targets.map(async (address) => {
    try {
      const vault = await getVault(address);
      const evidence = await gatherEvidence([vault], now, depth + 1, new Set(visited));
      const a = assess(vault, evidence, { amountUsd: 0, maxLossPct: DEFAULTS.maxLossPct, runShare: DEFAULTS.runShare, now });
      out.set(address, { vault: address, name: vault.name, lossFraction: a.lossWorstPct / 100, untraceableFraction: a.untraceablePct / 100, bedrockFraction: a.bedrockPct / 100, cycle: false });
    } catch {
      // Unreachable inner vault: gatherEvidence falls back to "lose everything, trace nothing".
    }
  }));
  return out;
}

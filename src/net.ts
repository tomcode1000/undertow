// Bounded network helpers. Every hosted call has a 10s budget, so each request
// gets its own short timeout and callers treat a timeout as "could not verify".

export const HOSTS = {
  morpho: "https://blue-api.morpho.org/graphql",
  rpc: "https://mainnet.base.org",
  kyber: "https://aggregator-api.kyberswap.com/base/api/v1/routes",
} as const;

export async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 4_000): Promise<unknown> {
  // PayBox grants exact hosts only, so a redirect elsewhere must fail rather than be followed.
  const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
  return response.json();
}

export async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const body = (await fetchJson(HOSTS.morpho, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  }, 5_000)) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`Morpho API: ${body.errors[0]!.message}`);
  if (!body.data) throw new Error("Morpho API returned no data");
  return body.data;
}

export type Call = { to: string; data: string };

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const AGGREGATE3 = "0x82ad56cb"; // aggregate3((address,bool,bytes)[])

/**
 * Many eth_calls as one Multicall3 request, so the public RPC sees a single call and cannot
 * throttle half of them. A call that reverts comes back as null. If Base cannot be reached at
 * all after retries this throws: "could not verify" must never turn into a verdict.
 */
export async function ethCalls(calls: Call[]): Promise<(string | null)[]> {
  if (calls.length === 0) return [];
  const out: (string | null)[] = [];
  for (let i = 0; i < calls.length; i += 120) out.push(...(await multicall(calls.slice(i, i + 120))));
  return out;
}

async function multicall(calls: Call[]): Promise<(string | null)[]> {
  const data = AGGREGATE3 + encodeCall3(calls);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    try {
      const reply = (await fetchJson(HOSTS.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: MULTICALL3, data }, "latest"] }),
      }, 3_000)) as { result?: string; error?: { message?: string } };
      if (typeof reply.result !== "string" || reply.result.length < 2 + 128) throw new Error(reply.error?.message ?? "empty multicall result");
      return decodeResults(reply.result, calls.length);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Base RPC unavailable (${(lastError as Error)?.message ?? "no answer"})`);
}

function encodeCall3(calls: Call[]): string {
  // (address target, bool allowFailure, bytes callData)[] — every tuple is dynamic because of `bytes`.
  const tuples = calls.map((call) => {
    const bytes = call.data.replace(/^0x/, "");
    const padded = bytes.padEnd(Math.ceil(bytes.length / 64) * 64, "0");
    return word(call.to) + word("1") + word((96).toString(16)) + word((bytes.length / 2).toString(16)) + padded;
  });
  let offset = calls.length * 32;
  const heads = tuples.map((t) => {
    const head = word(offset.toString(16));
    offset += t.length / 2;
    return head;
  });
  return word("20") + word(calls.length.toString(16)) + heads.join("") + tuples.join("");
}

function decodeResults(hex: string, count: number): (string | null)[] {
  const body = hex.slice(2);
  const at = (byte: number) => Number(BigInt(`0x${body.slice(byte * 2, byte * 2 + 64)}`));
  const array = at(0); // offset of the Result[] array
  if (at(array) !== count) throw new Error("multicall returned the wrong number of results");
  const base = array + 32;
  const results: (string | null)[] = [];
  for (let i = 0; i < count; i++) {
    const tuple = base + at(base + i * 32);
    const success = at(tuple) === 1;
    const start = tuple + at(tuple + 32);
    const length = at(start);
    const returned = body.slice((start + 32) * 2, (start + 32 + length) * 2);
    results.push(success && length > 0 ? `0x${returned}` : null);
  }
  return results;
}

// ABI encoding for the handful of fixed-shape calls Undertow makes.

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
export const encodeAddress = (address: string) => word(address);
export const encodeUint = (value: bigint) => word(value.toString(16));

export const SELECTORS = {
  approve: "0x095ea7b3", // approve(address,uint256)
  deposit: "0x6e553f65", // deposit(uint256,address)
  redeem: "0xba087652", // redeem(uint256,address,address)
  allowance: "0xdd62ed3e", // allowance(address,address)
  balanceOf: "0x70a08231", // balanceOf(address)
  maxRedeem: "0xd905777e", // maxRedeem(address)
  asset: "0x38d52e0f", // asset()
  latestRoundData: "0xfeaf968c", // latestRoundData()
} as const;

export function wordAt(hex: string, index: number): bigint {
  const slice = hex.slice(2 + index * 64, 2 + (index + 1) * 64);
  if (slice.length !== 64) throw new Error("short ABI return");
  return BigInt(`0x${slice}`);
}

export function addressWord(hex: string | null): string | null {
  if (!hex || hex.length !== 66) return null;
  const address = `0x${hex.slice(26)}`;
  return /^0x0{40}$/.test(address) ? null : address;
}

# Undertow

**The check your agent runs before it parks your savings.** A PayBox plugin that traces where USDC savings on Base actually sit (every Morpho USDC vault, the Aave v3 pool and the Moonwell pool) down through every layer of collateral, works out what a depositor could really lose and whether they could get out, then proposes the deposit through PayBox or refuses, showing the arithmetic.

Ratings tell you what a vault holds. Undertow tells you what it is *allowed* to hold, whether liquidations will save it, and whether you will get out.

## Tools

| Tool | What it does |
|---|---|
| `scan_vaults` | Assesses every Base USDC Morpho vault plus the Aave v3 and Moonwell USDC pools above a size floor; ranks the ones that pass by yield; lists the highest-yield refusals with reasons |
| `xray_vault` | One venue in full (a Morpho vault address, Aave aUSDC `0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB`, or Moonwell mUSDC `0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22`): every market, collateral kind (recursing into vaults inside vaults), oracle health, liquidation depth, the curator's worst allowed portfolio, the run test |
| `propose_deposit` | Re-runs the x-ray; refuses unless it passes. Otherwise proposes an exact-amount USDC `approve`, then (on the next call) the deposit: Morpho `deposit`, Aave `Pool.supply`, or Moonwell `mint` |
| `propose_withdraw` | Withdraws everything the venue can pay out now (Morpho `redeem`, Aave `Pool.withdraw`, Moonwell `redeem`/`redeemUnderlying`). Never blocked |

All proposals are single EVM calls on Base (`eip155:8453`) that Undertow builds itself. Approvals are never unlimited.

## Shared pools (Aave, Moonwell)

A pool is mapped onto the same shape as a vault: each accepted collateral holds the slice of USDC loans it backs (weighted by collateral value × liquidation threshold); governance supply caps play the curator's caps (worst case: every collateral at its cap); unborrowed cash is the exit liquidity. Aave price adapters and Moonwell's oracle give prices without update times, so they are trusted only for blue-chip and stable collateral.

## How the stress works

For each market the vault lends into:

- **Kind** of collateral: anchor, stable, restaked, custodial, volatile, synthetic, off-chain, first-loss, Morpho vault (traced recursively), ERC-4626 wrapper (detected on-chain), or opaque.
- **Shock** (price drop) and **gap** (the share liquidations cannot catch) per kind. These are stated assumptions, returned with every result.
- **Gap goes to 100%** when the oracle is stale (Chainlink `updatedAt` older than 48h), constant (no base feed), an exchange rate on non-blue-chip collateral, or cannot be inspected, or when selling the market's borrowed value of collateral through KyberSwap costs more than 10%.
- Loss per borrowed dollar with borrowers at the LLTV: `max(0, 1 − (1 − shock·gap) / LLTV)`, multiplied by utilisation, shared across suppliers.

Then, for the vault:

- **Worst case:** the riskiest markets filled to their supply caps (plus pending caps that land within one timelock). A timelock under 24h means the caps bind nothing.
- **Exit:** the vault's withdrawable liquidity, after 30% of depositors leave first.
- **Pass** requires: worst-case loss ≤ your limit (default 5%), exit after the run ≥ your minimum (default 90%), untraceable collateral ≤ 1%, and a timelock ≥ 24h.
- Missing or failed evidence always counts against a vault.

## Configure in the PayBox portal

- **Network hosts:** `blue-api.morpho.org`, `api.v3.aave.com`, `mainnet.base.org`, `aggregator-api.kyberswap.com`
- **Variables and secrets:** none

## Develop

Node.js 24.21.0 and pnpm 11.11.0 (on Windows, use WSL2).

```bash
pnpm install --frozen-lockfile
pnpm test        # type-check, reproducible build, PayBox conformance
pnpm unit        # engine tests
pnpm smoke       # live assessment of every Base USDC vault
node dev/call.mjs scan_vaults '{"amountUsdc":"1"}'   # call the built bundle like PayBox does
```

Upload `dist/plugin.mjs` only.

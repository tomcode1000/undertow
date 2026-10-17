# Undertow: build brief

> **Hackathon:** MoonPay Hackathons, Chapter 1: PayBox ([developer.paybox.sh](https://developer.paybox.sh/hackathon))
> **Deadline:** **Sat Oct 17, 2026, 8pm EDT** (hard). One submission. Upload + submit for review before the deadline.
> **Required:** a live PayBox marketplace plugin working end to end, plus a short demo video posted to X.
> **Track:** Consumer finance ("saving, moving, converting… an agent can execute within policy"). Judged the same as every other track.
> **Brief written:** Oct 16, 2026

---

## 1. One-line pitch

**Undertow is the check your agent runs before it parks your savings. It traces a yield vault down through every layer of collateral, works out what you could really lose and whether you could get out, then deposits through PayBox or refuses, showing the arithmetic.**

> Ratings tell you what a vault holds. Undertow tells you what it is *allowed* to hold, whether liquidations will save it, and whether you will get out.

---

## 2. The problem (with evidence)

- **Stream Finance (Nov 2025):** xUSD fell 77% in 24h after a $93M loss at an external fund manager. About **$285M** of lender exposure ran through curated vaults (Elixir, MEV Capital, Re7, Varlamore…) on Euler, Morpho, Silo. MEV Capital's oracle price was held by hand, so liquidations never fired and the vault took bad debt.
- **Resolv USR (Mar 2026)** and **KelpDAO rsETH (Apr 2026):** the same pattern. A token several layers down failed and vaults that "only lend USDC" took losses.
- **Live on Base today (checked Oct 16):** "Apostro Resolv USDC" advertises **133,843% APY**. Its only funded market lends against **RLP** (Resolv's first-loss token), is **100% utilised**, and the vault has **$0 withdrawable**. The APY is the interest rate maxing out because nobody can leave. A "find me the best yield" agent would deposit into it.
- Ratings (Credora in the Morpho app, curator dashboards) give one grade per vault for what it holds *now*. None traces the layers recursively, stresses *your* deposit, models the curator's allowed moves, or lets your agent act on the result.

---

## 3. What Undertow computes

### 3.1 Trace (what the vault holds)
- Each Morpho market the vault supplies, and that market's collateral.
- Each collateral token is classified as:
  - `anchor`: blue-chip (WETH, cbBTC, wstETH…)
  - `custodial`: a wrapped asset held by a custodian (cbXRP, cbDOGE…)
  - `vault`: itself a Morpho vault → **recurse** (API `collateralAsset.vault`, depth ≤ 3)
  - `wrapper`: an ERC-4626 vault outside Morpho (checked on-chain with `asset()`) → its strategy is opaque
  - `offchain`: backed off-chain (Midas mTokens, xUSD-style funds)
  - `first-loss`: a junior tranche (RLP)
  - `opaque`: unknown
- **Bedrock coverage** = the share of your dollar that ends in anchors.

### 3.2 Stress (what you could lose)
- Each class has a stated shock `s` (price drop) and gap share `g`, the part of the drop that liquidations can't catch.
- Effective drop `e = s·g`. Loss per borrowed dollar at the liquidation limit (worst case): `max(0, 1 − (1−e)/LLTV)`.
- The vault's loss in market m = `vaultSupply_m × utilisation_m × lossRate_m`. Bad debt is shared across all suppliers.
- **Your loss** = deposit × vault loss ÷ vault assets.
- Every parameter is printed in the output, with no hidden scores.

### 3.3 Envelope (what the curator is allowed to do)
- The allocator can move money between enabled markets **instantly**, up to each market's supply cap. Raising a cap waits for the vault timelock.
- The **worst allowed portfolio** fills the riskiest markets up to their caps first. Pending cap increases count once valid.
- A timelock under 24h means the caps aren't a real limit, and the output flags it.

### 3.4 Liquidation reality
- **Oracle:** a Morpho oracle with no feeds and no vault returns a **constant** price, so liquidations never fire. A `baseOracleVault` means the price is an **exchange rate**, so a depeg is invisible. A Chainlink feed whose `updatedAt` is stale counts as broken.
  - Any of these sets `g = 1` for that market.
- **Depth:** a DEX quote (KyberSwap aggregator, no key) for selling the market's collateral at liquidation size. If the price impact is above 10%, liquidators walk away, so `g = 1`.

### 3.5 Exit (can you get out)
- Withdrawable now = idle + Σ min(vault supply in m, free liquidity in m).
- **Run test:** if 30% of depositors leave ahead of you, how much of your deposit comes out.

### 3.6 Decision
- Pass if **envelope stressed loss ≤ your limit** (default 5%) **and** run-exit ≥ 90% **and** no `first-loss` / `offchain` / `opaque` exposure above 1%.
- `scan` picks the highest net APY that passes. Everything else gets a one-line refusal reason.
- If verification fails (timeout, missing data), the vault fails. **Undertow never deposits into anything it couldn't check.**

---

## 4. Tools (MCP, PayBox hosted)

| Tool | In | Out |
|---|---|---|
| `scan_vaults` | asset (USDC), amount, maxLossPct | Ranked candidates: APY, stressed loss (now / envelope), exit %, bedrock %, verdict + reason |
| `xray_vault` | vault, amount, maxLossPct | Full tree, per-market stress, oracle + depth findings, envelope, run test, verdict |
| `propose_deposit` | vault, amount, owner | Re-checks the vault. If it fails, returns the refusal (no proposal). If it passes: an exact `approve` proposal when the allowance is short, otherwise `deposit(assets, owner)` |
| `propose_withdraw` | vault, owner | `redeem(all shares, owner, owner)` proposal |

- All proposals are single EVM calls on Base (`eip155:8453`) built by Undertow. No co-signers, nothing pre-signed.
- Approvals are always the exact amount, never unlimited.

---

## 5. Architecture

- TypeScript, PayBox starter 1.0.2 (pinned). Bundle: `dist/plugin.mjs`.
- Data:
  - Morpho API (`blue-api.morpho.org`, one GraphQL call ≈1.5s)
  - Base RPC (`mainnet.base.org`, Multicall3 for allowances, `asset()`, oracle feeds)
  - KyberSwap (`aggregator-api.kyberswap.com`) for depth
- Every call has a 4s timeout, independent calls run in parallel, and the deep checks run only on the top candidates, so a call stays under 10s.
- Stateless: the chain and the API are the state. The agent passes the vault and owner each call.
- **Network hosts to configure in the portal:** `blue-api.morpho.org`, `api.v3.aave.com`, `mainnet.base.org`, `aggregator-api.kyberswap.com`. No secrets.
- **Venues:** every Morpho USDC vault on Base, plus the Aave v3 and Moonwell USDC pools (added Oct 16).

---

## 6. Demo video (≈60s, posted to X)

1. The agent is asked: "Put $1 of my USDC in the best yield on Base."
2. Undertow x-rays Apostro Resolv: 133,843% APY, first-loss RLP, 100% utilised, **$0 withdrawable**. Refused.
3. A mid-yield vault: a collateral token two layers down is backed off-chain and can't be checked. Stressed loss X%. Refused.
4. It picks the top passing vault (e.g. Gauntlet USDC Prime, ~4.7%, envelope loss ~0%). PayBox approve → deposit. Show it on BaseScan.
5. Closing line: "Your agent never parks a dollar it can't trace."

---

## 7. Plan (Oct 16 → Oct 17, 8pm EDT)

| When | Milestone |
|---|---|
| Thu PM | Engine: trace + stress + envelope + exit on live data, as pure functions with tests |
| Thu night | Oracle + depth checks; tools; `pnpm test` passes |
| Fri AM | Upload, hosted checks, portal tool tests, validate a deposit proposal with your wallet |
| Fri midday | Real $1 deposit through an agent; record the video |
| Fri PM | Post the video to X; submit for review **by 4pm EDT** (buffer) |

**Cut order if behind:** depth quotes → run test → envelope. **Never cut:** trace, stress, refusal, deposit.

---

## 8. Open items

- About $2 on Base (USDC + a little ETH) in your PayBox wallet for the real deposit.
- Confirm in the portal that a deposit proposal validates (simulation) before recording.

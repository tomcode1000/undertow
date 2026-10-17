// Live check of the engine against Base. Run: pnpm exec tsx dev/smoke.ts [vaultAddress]
import { assess, DEFAULTS } from "../src/engine.js";
import { gatherEvidence } from "../src/evidence.js";
import { BASE_USDC, getVault, listVaults } from "../src/morpho.js";
import { isPool, loadAave, loadMoonwell, loadPool } from "../src/pools.js";

const now = Math.floor(Date.now() / 1000);
const options = { amountUsd: 1, maxLossPct: DEFAULTS.maxLossPct, runShare: DEFAULTS.runShare, now };
const started = Date.now();
const target = process.argv[2];

const vaults = target
  ? [await (isPool(target) ? loadPool(target) : getVault(target))]
  : [...(await listVaults(BASE_USDC)), await loadAave(), await loadMoonwell()].filter((v) => v.totalAssetsUsd >= 250_000);
console.log(`loaded ${vaults.length} vault(s) in ${Date.now() - started}ms`);
const evidence = await gatherEvidence(vaults, now);
console.log(`evidence for ${evidence.size} markets at ${Date.now() - started}ms`);
for (const v of vaults) {
  const a = assess(v, evidence, options);
  console.log(`\n${a.verdict.toUpperCase()}  ${a.name}  apy ${a.netApyPct}%  tvl $${a.tvlUsd.toLocaleString()}  lossNow ${a.lossNowPct}%  lossWorst ${a.lossWorstPct}%  exitRun ${a.exitRunPct}%  bedrock ${a.bedrockPct}%  untraceable ${a.untraceablePct}%  timelock ${a.timelockHours}h`);
  for (const r of a.reasons) console.log(`   - ${r}`);
  if (target) for (const m of a.markets) console.log(`   ${m.collateral.padEnd(18)} ${m.kind.padEnd(10)} now ${m.sharePct}% worst ${m.worstSharePct}% lltv ${m.lltvPct}% util ${m.utilizationPct}% oracle ${m.oracle} depth ${m.depth} loss/borrowed ${m.lossRatePct}%`);
}
console.log(`\ntotal ${Date.now() - started}ms`);

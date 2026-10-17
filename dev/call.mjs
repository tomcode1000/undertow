// Calls one tool on the built bundle the way PayBox does (one stateless request per process).
// Usage: node dev/call.mjs <tool> '<json arguments>'
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [tool, args = "{}"] = process.argv.slice(2);
const started = Date.now();
const child = spawn(process.execPath, ["dist/plugin.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
child.stdin.write(`${JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "tools/call",
  params: { name: tool, arguments: JSON.parse(args), _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "undertow-dev", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  } },
})}\n`);
for await (const line of createInterface({ input: child.stdout })) {
  const message = JSON.parse(line);
  if (message.id !== 1) continue;
  if (message.error) console.log("JSON-RPC error:", message.error);
  const result = message.result;
  console.log(`[${tool}] ${Date.now() - started}ms isError=${result?.isError ?? false}`);
  for (const c of result?.content ?? []) console.log(c.text);
  const proposal = result?.structuredContent?.["io.paybox/transactionProposal"];
  if (proposal) console.log("PROPOSAL", JSON.stringify(proposal, null, 2));
  child.kill();
  break;
}

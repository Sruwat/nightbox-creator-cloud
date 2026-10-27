import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const require = createRequire(import.meta.url);
const dataDir = mkdtempSync(join(tmpdir(), "nightbox-payout-test-"));
process.env.NIGHTBOX_DATA_DIR = dataDir;
process.env.AUTH_SECRET = "local-payout-test-secret-local-payout-test-secret";
const store = require("../appcode/nightbox/backend/database.js");
const creator = store.createUser("payout-test@example.test", "PayoutTestPassword123!");
const token = store.signToken(creator);
const videoId = store.id();
store.createVideo({ id: videoId, ownerId: creator.id, title: "Payout test", watchUrl: "https://example.test/watch", embedUrl: "https://example.test/embed", status: "ready" });
const link = store.createLink(videoId, creator.id);
const viewId = store.id();
store.db.prepare("INSERT INTO view_sessions (id,link_id,viewer_hash,ip_hash,country,started_at,counted) VALUES (?,?,?,?,?,?,1)").run(viewId, link.id, "viewer", "ip", "IN", store.now());
store.db.prepare("INSERT INTO earnings (id,creator_id,link_id,view_id,country,cpm_cents,amount_micros,created_at) VALUES (?,?,?,?,?,?,?,?)").run(store.id(), creator.id, link.id, viewId, "IN", 1000, 30000000, store.now());

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const chosenPort = server.address().port;
    server.close(() => resolve(chosenPort));
  });
});
const child = spawn(process.execPath, [join(process.cwd(), "appcode/nightbox/backend/server.js")], {
  cwd: join(process.cwd(), "appcode/nightbox/backend"),
  env: { ...process.env, NODE_ENV: "test", PORT: String(port), VIDEO_STORAGE_DRIVER: "local", ENABLE_HLS_TRANSCODE: "false", ADMIN_API_KEY: "test-admin-key-test-admin-key-test-admin-key" },
  stdio: ["ignore", "pipe", "pipe"],
});
let backendOutput = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { backendOutput = (backendOutput + chunk.toString()).slice(-4000); });
const base = `http://127.0.0.1:${port}`;
async function request(path, method = "GET", body, admin = false) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(admin ? { "x-api-key": "test-admin-key-test-admin-key-test-admin-key" } : { authorization: `Bearer ${token}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Backend exited before becoming ready: ${backendOutput}`);
    try { await fetch(`${base}/health`); ready = true; break; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, `Backend did not start: ${backendOutput}`);
  assert.equal((await request("/api/creator/withdrawals", "POST", { amountMicros: 10000000, method: "UPI" })).status, 400);
  assert.equal((await request("/api/creator/withdrawals", "POST", { amountMicros: 10000000, method: "UPI", payoutAccount: "invalid" })).status, 400);
  const created = await request("/api/creator/withdrawals", "POST", { amountMicros: 10000000, method: "UPI", payoutAccount: "creator@bank" });
  assert.equal(created.status, 201);
  assert.equal(created.body.withdrawal.payoutAccount, "creator@bank");
  const id = created.body.withdrawal.id;
  assert.equal((await request("/api/creator/withdrawals")).body.withdrawals[0].payoutAccount, "creator@bank");
  assert.equal((await request("/api/admin/withdrawals", "GET", undefined, true)).body.withdrawals[0].payoutAccount, "creator@bank");
  assert.equal((await request(`/api/admin/withdrawals/${id}`, "PUT", { status: "approved" }, true)).status, 200);
  assert.equal((await request(`/api/admin/withdrawals/${id}`, "PUT", { status: "paid" }, true)).status, 200);
  const legacyId = store.id();
  store.db.prepare("INSERT INTO withdrawal_requests (id,creator_id,amount_micros,method,status,requested_at) VALUES (?,?,?,?,?,?)").run(legacyId, creator.id, 10000000, "UPI", "pending", store.now());
  assert.equal((await request(`/api/admin/withdrawals/${legacyId}`, "PUT", { status: "approved" }, true)).status, 400);
  assert.equal((await request(`/api/admin/withdrawals/${legacyId}`, "PUT", { payoutAccount: "legacy@bank" }, true)).status, 200);
  assert.equal((await request(`/api/admin/withdrawals/${legacyId}`, "PUT", { status: "approved" }, true)).status, 200);
  console.log("Payout API flow passed: validation, creator/admin visibility, legacy repair, approval and paid status.");
} finally {
  child.kill();
  if (child.exitCode === null) await new Promise(resolve => child.once("exit", resolve));
  store.db.close();
  rmSync(dataDir, { recursive: true, force: true });
}

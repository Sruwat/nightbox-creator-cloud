import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const store = require("../appcode/nightbox/backend/database.js");
const baseUrl = process.env.BACKEND_SMOKE_URL || "http://127.0.0.1:3000";
const password = "BackendSmokePassword_2026!";
const email = `backend-smoke-${Date.now()}@example.test`;
let userId;
let videoId;
let previousRate;
let previousUkRate;

async function json(url, options) {
  const response = await fetch(`${baseUrl}${url}`, options);
  const body = await response.json();
  assert.equal(response.ok, true, `${url}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

try {
  const registered = await json("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  userId = registered.user.id;
  const plans = await json("/api/plans");
  const planById = Object.fromEntries(plans.plans.map((plan) => [plan.id, plan]));
  assert.deepEqual(
    [planById.daily.price_minor, planById.weekly.price_minor, planById["28-day"].price_minor, planById.monthly.price_minor, planById.priority.price_minor],
    [1400, 9900, 29900, 69900, 129900],
  );
  assert.equal(planById.daily.video_ads_removed, 1);
  assert.equal(planById.daily.all_ads_removed, 0);
  assert.equal(planById.weekly.all_ads_removed, 1);
  assert.equal(planById["28-day"].video_ads_removed, 1);
  assert.equal(planById.monthly.all_ads_removed, 1);
  assert.equal(planById.priority.video_ads_removed, 0);
  assert.equal(planById.priority.all_ads_removed, 0);

  const subscriptionId = store.id();
  const subscriptionExpiry = new Date(Date.now() + 86400000).toISOString();
  store.db.prepare("INSERT INTO subscriptions (id,user_id,plan_id,status,started_at,expires_at,created_at) VALUES (?,?,?,?,?,?,?)").run(
    subscriptionId, userId, "daily", "active", store.now(), subscriptionExpiry, store.now(),
  );
  const activeSubscription = await json("/api/me/subscription", {
    headers: { authorization: `Bearer ${registered.token}` },
  });
  assert.equal(activeSubscription.subscription.status, "active");
  assert.equal(activeSubscription.subscription.videoAdsRemoved, 1);
  assert.equal(activeSubscription.subscription.allAdsRemoved, 0);
  store.db.prepare("UPDATE subscriptions SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), subscriptionId);
  const expiredSubscription = await json("/api/me/subscription", {
    headers: { authorization: `Bearer ${registered.token}` },
  });
  assert.equal(expiredSubscription.subscription, null);

  videoId = store.id();
  store.createVideo({
    id: videoId,
    ownerId: userId,
    title: "Backend flow smoke video",
    watchUrl: `${baseUrl}/watch/${videoId}`,
    embedUrl: `${baseUrl}/embed/${videoId}`,
    status: "ready",
  });
  const link = store.createLink(videoId, userId);
  const creatorVideos = await json("/api/creator/videos", {
    headers: { authorization: `Bearer ${registered.token}` },
  });
  const listedVideo = creatorVideos.videos.find((video) => video.id === videoId);
  assert.ok(listedVideo, "creator video listing should include the uploaded video");
  assert.equal(listedVideo.link.endsWith(`/l/${link.slug}`), true);

  const generatedLink = await json(`/api/creator/videos/${videoId}/link`, {
    method: "POST",
    headers: { authorization: `Bearer ${registered.token}` },
  });
  assert.match(generatedLink.link.url, new RegExp(`/l/${generatedLink.link.slug}$`));

  previousRate = store.db.prepare("SELECT cpm_cents AS cpmCents FROM cpm_rates WHERE country='IN'").get();
  previousUkRate = store.db.prepare("SELECT cpm_cents AS cpmCents FROM cpm_rates WHERE country='GB'").get();
  store.db.prepare("INSERT INTO cpm_rates(country,cpm_cents,updated_at) VALUES('IN',1000,?) ON CONFLICT(country) DO UPDATE SET cpm_cents=excluded.cpm_cents,updated_at=excluded.updated_at").run(store.now());
  store.db.prepare("INSERT INTO cpm_rates(country,cpm_cents,updated_at) VALUES('GB',1500,?) ON CONFLICT(country) DO UPDATE SET cpm_cents=excluded.cpm_cents,updated_at=excluded.updated_at").run(store.now());

  const started = await json(`/api/links/${link.slug}/view/start`, {
    method: "POST",
    headers: { "x-country-code": "IN", "user-agent": "NightBox backend smoke test" },
  });
  const storedSession = store.db.prepare("SELECT viewer_hash AS viewerHash, ip_hash AS ipHash, view_token_hash AS tokenHash, country FROM view_sessions WHERE id=?").get(started.sessionId);
  assert.match(storedSession.viewerHash, /^[a-f0-9]{64}$/);
  assert.match(storedSession.ipHash, /^[a-f0-9]{64}$/);
  assert.match(storedSession.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(storedSession.country, "IN");
  const tooSoon = await fetch(`${baseUrl}/api/views/${started.sessionId}/qualify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ viewToken: started.viewToken }),
  });
  assert.equal(tooSoon.status, 400);
  await new Promise((resolve) => setTimeout(resolve, 5100));
  const qualified = await json(`/api/views/${started.sessionId}/qualify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ viewToken: started.viewToken }),
  });
  assert.equal(qualified.counted, true);
  assert.equal(qualified.country, "IN");
  assert.equal(qualified.cpmCents, 1000);
  assert.equal(qualified.amountMicros, 10000);

  // Replaying the same signed qualification must not create another ledger row.
  const replay = await json(`/api/views/${started.sessionId}/qualify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ viewToken: started.viewToken }),
  });
  assert.equal(replay.counted, true);

  const secondSession = await json(`/api/links/${link.slug}/view/start`, {
    method: "POST",
    headers: { "x-country-code": "IN", "user-agent": "NightBox backend smoke test" },
  });
  await new Promise((resolve) => setTimeout(resolve, 5100));
  const duplicate = await json(`/api/views/${secondSession.sessionId}/qualify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ viewToken: secondSession.viewToken }),
  });
  assert.equal(duplicate.counted, false);
  assert.equal(duplicate.duplicate, true);

  const ukSession = await json(`/api/links/${link.slug}/view/start`, {
    method: "POST",
    headers: { "x-country-code": "GB", "user-agent": "NightBox second-viewer smoke test" },
  });
  await new Promise((resolve) => setTimeout(resolve, 5100));
  const ukQualified = await json(`/api/views/${ukSession.sessionId}/qualify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ viewToken: ukSession.viewToken }),
  });
  assert.equal(ukQualified.counted, true);
  assert.equal(ukQualified.country, "GB");
  assert.equal(ukQualified.cpmCents, 1500);
  assert.equal(ukQualified.amountMicros, 15000);

  const analytics = await json("/api/creator/analytics", {
    headers: { authorization: `Bearer ${registered.token}` },
  });
  assert.equal(analytics.summary.views, 2);
  assert.equal(analytics.summary.earningsMicros, 25000);
  assert.deepEqual(analytics.countries.map((row) => row.country).sort(), ["GB", "IN"]);
  console.log("backend-flow-smoke: passed (5s qualification, duplicate filter, country CPM, ledger, analytics)");
} finally {
  if (userId) store.db.prepare("DELETE FROM users WHERE id=?").run(userId);
  if (previousRate) {
    store.db.prepare("UPDATE cpm_rates SET cpm_cents=?,updated_at=? WHERE country='IN'").run(previousRate.cpmCents, store.now());
  } else {
    store.db.prepare("DELETE FROM cpm_rates WHERE country='IN'").run();
  }
  if (previousUkRate) {
    store.db.prepare("UPDATE cpm_rates SET cpm_cents=?,updated_at=? WHERE country='GB'").run(previousUkRate.cpmCents, store.now());
  } else {
    store.db.prepare("DELETE FROM cpm_rates WHERE country='GB'").run();
  }
}

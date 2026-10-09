/// <reference types="vite/client" />

const configuredBackendUrl = String(import.meta.env.VITE_BACKEND_URL || "").trim();
const BACKEND_URL = (configuredBackendUrl || (import.meta.env.DEV ? "http://localhost:3000" : "https://api.nightbox.in")).replace(/\/$/, "");

export type BackendVideo = {
  id: string;
  title: string;
  status: string;
  duration?: number;
  size?: number;
  views?: number;
  dateUploaded?: string;
  thumbnailUrl?: string | null;
  embedUrl: string;
  hlsUrl: string;
  watchUrl: string;
  downloadUrl: string;
};

export type UploadResult = {
  success: boolean;
  videoId: string;
  watchUrl: string;
  embedUrl: string;
  link?: string | null;
  message: string;
};

export type AdminReport = {
  id: string;
  reporterName: string;
  reporterEmail: string;
  videoId: string | null;
  videoUrl: string | null;
  reason: string;
  status: string;
  adminNote: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlatformEvent = {
  id: string;
  title: string;
  description: string;
  startsAt: string | null;
  endsAt: string | null;
  rewardNote: string | null;
  active?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type CreatorRewardMilestone = { id: string; title: string; description: string; thresholdViews: number; rewardNote: string; claimStatus: string | null; eligible: boolean };
export type RewardMilestone = Omit<CreatorRewardMilestone, "claimStatus" | "eligible"> & { active: number; createdAt?: string; updatedAt?: string };
export type RewardClaim = { id: string; milestoneId: string; creatorId: string; creatorEmail: string; milestoneTitle: string; thresholdViews: number; rewardNote: string; status: string; creatorNote: string | null; adminNote: string | null; createdAt: string; updatedAt: string };

async function parseResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Backend request failed (${response.status})`);
  }
  return body as T;
}

export async function getBackendHealth() {
  const response = await fetch(`${BACKEND_URL}/health`);
  return parseResponse<{ status: string; activeUploads: number }>(response);
}

export async function register(email: string, password: string) {
  const response = await fetch(`${BACKEND_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return parseResponse<{ user: { id: string; email: string; role: string }; token: string }>(response);
}

export async function login(email: string, password: string) {
  const response = await fetch(`${BACKEND_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return parseResponse<{ user: { id: string; email: string; role: string }; token: string }>(response);
}

export async function loginWithGoogle(credential: string) {
  const response = await fetch(`${BACKEND_URL}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  return parseResponse<{ user: { id: string; email: string; role: string; name?: string | null; picture?: string | null }; token: string }>(response);
}

export async function adminLogin(email: string, password: string) {
  const response = await fetch(`${BACKEND_URL}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return parseResponse<{ user: { id: string; email: string; role: string }; token: string }>(response);
}

export async function uploadVideo(file: File, title: string, token?: string): Promise<UploadResult> {
  const form = new FormData();
  form.append("video", file);
  form.append("title", title || file.name);
  const response = await fetch(`${BACKEND_URL}/upload-file`, { method: "POST", body: form, headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  return parseResponse<UploadResult>(response);
}

export async function getVideo(videoId: string) {
  const response = await fetch(`${BACKEND_URL}/video/${encodeURIComponent(videoId)}`);
  return parseResponse<{ success: boolean; video: BackendVideo }>(response);
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export async function getCreatorVideos(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/creator/videos`, { headers: authHeaders(token) });
  return parseResponse<{ videos: Array<{ id: string; title: string; status: string; fileSize: number | null; watchUrl: string; embedUrl: string; createdAt: string; link: string | null; eligibleViews: number; earningsMicros: number }> }>(response);
}
export async function deleteCreatorVideo(token: string, videoId: string) {
  const response = await fetch(`${BACKEND_URL}/api/creator/videos/${encodeURIComponent(videoId)}`, { method: "DELETE", headers: authHeaders(token) });
  return parseResponse<{ deleted: boolean }>(response);
}
export async function createCreatorVideoLink(token: string, videoId: string) {
  const response = await fetch(`${BACKEND_URL}/api/creator/videos/${encodeURIComponent(videoId)}/link`, { method: "POST", headers: authHeaders(token) });
  return parseResponse<{ link: { slug: string; url: string } }>(response);
}

export type CreatorFolder = { id: string; name: string; parentId: string | null; createdAt: string };
export type CreatorStoredFile = { id: string; folderId: string | null; name: string; mimeType: string; sizeBytes: number; shareUrl: string | null; createdAt: string };
export type CreatorStorageUsage = { usedBytes: number; reservedBytes: number; quotaBytes: number; maximumBytes: number };
export async function getCreatorFolders(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/creator/folders`, { headers: authHeaders(token) });
  return parseResponse<{ folders: CreatorFolder[] }>(response);
}
export async function createCreatorFolder(token: string, name: string, parentId: string | null = null) {
  const response = await fetch(`${BACKEND_URL}/api/creator/folders`, { method: "POST", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ name, parentId }) });
  return parseResponse<{ folder: CreatorFolder }>(response);
}
export async function renameCreatorFolder(token: string, folderId: string, name: string) {
  const response = await fetch(`${BACKEND_URL}/api/creator/folders/${encodeURIComponent(folderId)}`, { method: "PATCH", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  return parseResponse<{ folder: CreatorFolder }>(response);
}
export async function deleteCreatorFolder(token: string, folderId: string) {
  const response = await fetch(`${BACKEND_URL}/api/creator/folders/${encodeURIComponent(folderId)}`, { method: "DELETE", headers: authHeaders(token) });
  return parseResponse<{ deleted: boolean }>(response);
}
export async function getCreatorFiles(token: string, folderId: string | null = null) {
  const query = folderId ? `?folderId=${encodeURIComponent(folderId)}` : "";
  const response = await fetch(`${BACKEND_URL}/api/creator/files${query}`, { headers: authHeaders(token) });
  return parseResponse<{ files: CreatorStoredFile[]; storage: CreatorStorageUsage }>(response);
}
export async function uploadCreatorFile(token: string, file: File, folderId: string | null = null) {
  const form = new FormData();
  form.append("file", file);
  if (folderId) form.append("folderId", folderId);
  const response = await fetch(`${BACKEND_URL}/api/creator/files`, { method: "POST", headers: authHeaders(token), body: form });
  return parseResponse<{ file: CreatorStoredFile }>(response);
}
export async function moveCreatorFile(token: string, fileId: string, folderId: string | null) {
  const response = await fetch(`${BACKEND_URL}/api/creator/files/${encodeURIComponent(fileId)}/move`, { method: "PATCH", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ folderId }) });
  return parseResponse<{ moved: boolean; folderId: string | null }>(response);
}
export async function shareCreatorFile(token: string, fileId: string) {
  const response = await fetch(`${BACKEND_URL}/api/creator/files/${encodeURIComponent(fileId)}/share`, { method: "POST", headers: authHeaders(token) });
  return parseResponse<{ shareUrl: string }>(response);
}
export async function revokeCreatorFileShare(token: string, fileId: string) {
  const response = await fetch(`${BACKEND_URL}/api/creator/files/${encodeURIComponent(fileId)}/share`, { method: "DELETE", headers: authHeaders(token) });
  return parseResponse<{ revoked: boolean }>(response);
}
export async function deleteCreatorFile(token: string, fileId: string) {
  const response = await fetch(`${BACKEND_URL}/api/creator/files/${encodeURIComponent(fileId)}`, { method: "DELETE", headers: authHeaders(token) });
  return parseResponse<{ deleted: boolean }>(response);
}

export async function getCreatorAnalytics(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/creator/analytics`, { headers: authHeaders(token) });
  return parseResponse<{ summary: { views: number; earningsMicros: number }; countries: Array<{ country: string; views: number; earningsMicros: number; cpmCents: number }>; rates: Array<{ country: string; cpmCents: number }> }>(response);
}

export async function getPublicCpm() {
  const response = await fetch(`${BACKEND_URL}/api/cpm`);
  return parseResponse<{ rates: Array<{ country: string; cpmCents: number }> }>(response);
}

export async function getAdminUsers(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/admin/users`, { headers: authHeaders(token) });
  return parseResponse<{ users: Array<{ id: string; email: string; role: string; status: string; telegramUserId: string | null; createdAt: string; storageQuotaBytes: number; storageUsedBytes: number }> }>(response);
}
export async function updateAdminStorageQuota(token: string, id: string, quotaBytes: number) {
  const response = await fetch(`${BACKEND_URL}/api/admin/users/${encodeURIComponent(id)}/storage-limit`, { method: "PUT", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ quotaBytes }) });
  return parseResponse<{ creatorId: string; quotaBytes: number }>(response);
}
export async function updateAdminUser(token: string, id: string, status: string) {
  const response = await fetch(`${BACKEND_URL}/api/admin/users/${encodeURIComponent(id)}`, { method: "PUT", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
  return parseResponse(response);
}

export async function getAdminVideos(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/admin/videos`, { headers: authHeaders(token) });
  return parseResponse<{ videos: Array<{ id: string; title: string; status: string; ownerId: string | null; createdAt: string; eligibleViews: number }> }>(response);
}
export async function deleteAdminVideo(token: string, id: string) {
  const response = await fetch(`${BACKEND_URL}/api/admin/videos/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders(token) });
  return parseResponse<{ deleted: boolean }>(response);
}
export async function getAdminOverview(token: string, start?: string, end?: string) {
  const query = start && end ? `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}` : "";
  const response = await fetch(`${BACKEND_URL}/api/admin/overview${query}`, { headers: authHeaders(token) });
  return parseResponse<{
    users: number; creators: number; videos: number; qualifiedViews: number; earningsMicros: number; pendingWithdrawals: number; updatedAt: string;
    dailyActivity: Array<{ date: string; qualifiedViews: number; earningsMicros: number; activeCreators: number }>;
    recentCreators: Array<{ id: string; email: string; createdAt: string; videos: number; qualifiedViews: number; earningsMicros: number }>;
  }>(response);
}

export async function getAdminTraffic(token: string, start?: string, end?: string) {
  const query = start && end ? `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}` : "";
  const response = await fetch(`${BACKEND_URL}/api/admin/traffic${query}`, { headers: authHeaders(token) });
  return parseResponse<{
    sessions: number;
    qualified: number;
    uniqueIps: number;
    filtered: number;
    dailyActivity: Array<{ date: string; sessions: number; qualified: number; uniqueIps: number }>;
    updatedAt: string;
  }>(response);
}
export async function getAdminBotEvents(token: string, limit = 100) {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const response = await fetch(`${BACKEND_URL}/api/admin/bot-events?limit=${safeLimit}`, { headers: authHeaders(token) });
  return parseResponse<{ events: Array<{ id: string; userId: string | null; email: string | null; botName: string; eventType: string; externalId: string | null; videoId: string | null; status: string; createdAt: string }> }>(response);
}
export async function getAdminViews(token: string, limit = 500) {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const response = await fetch(`${BACKEND_URL}/api/admin/views?limit=${safeLimit}`, { headers: authHeaders(token) });
  return parseResponse<{ views: Array<{ id: string; title: string; creatorEmail: string; country: string; counted: number; startedAt: string; qualifiedAt: string | null; cpmCents: number; amountMicros: number }> }>(response);
}
export async function updateAdminView(token: string, id: string, counted: boolean) {
  const response = await fetch(`${BACKEND_URL}/api/admin/views/${encodeURIComponent(id)}`, { method: "PUT", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ counted }) });
  return parseResponse<{ counted: boolean }>(response);
}

export async function getAdminCpm(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/admin/cpm`, { headers: authHeaders(token) });
  return parseResponse<{ rates: Array<{ country: string; cpmCents: number }> }>(response);
}
export async function updateAdminCpm(token: string, country: string, cpmCents: number) {
  const response = await fetch(`${BACKEND_URL}/api/admin/cpm/${encodeURIComponent(country)}`, { method: "PUT", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ cpmCents }) });
  return parseResponse<{ country: string; cpmCents: number }>(response);
}
export async function getAdminPlans(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/admin/plans`, { headers: authHeaders(token) });
  return parseResponse<{ plans: Array<{ id: string; name: string; priceMinor: number; currency: string; durationDays: number; recurring: number; active: number }> }>(response);
}
export async function getAdminSubscriptions(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/admin/subscriptions`, { headers: authHeaders(token) });
  return parseResponse<{ subscriptions: Array<{ id: string; user_id: string; plan_id: string; status: string; provider_subscription_id: string | null; started_at: string | null; expires_at: string | null; cancelled_at: string | null; created_at: string }> }>(response);
}
export async function getAdminPayments(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/admin/payments`, { headers: authHeaders(token) });
  return parseResponse<{ payments: Array<{ id: string; user_id: string; subscription_id: string | null; provider: string; provider_payment_id: string | null; amount_minor: number; currency: string; status: string; created_at: string; updated_at: string }> }>(response);
}
export async function cancelAdminSubscription(token: string, id: string) {
  const response = await fetch(`${BACKEND_URL}/api/admin/subscriptions/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: authHeaders(token) });
  return parseResponse<{ cancelled: boolean; subscriptionId: string }>(response);
}
export async function refundAdminPayment(token: string, id: string) {
  const response = await fetch(`${BACKEND_URL}/api/admin/payments/${encodeURIComponent(id)}/refund`, { method: "POST", headers: authHeaders(token) });
  return parseResponse<{ refunded: boolean; paymentId: string }>(response);
}
export async function updateAdminPlan(token: string, id: string, priceMinor: number, active: number) {
  const response = await fetch(`${BACKEND_URL}/api/admin/plans/${encodeURIComponent(id)}`, { method: "PUT", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ priceMinor, active }) });
  return parseResponse(response);
}
export async function getAdminViewRules(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/admin/view-rules`, { headers: authHeaders(token) });
  return parseResponse<{ rules: { eligiblePercent: number; maxViewsPerIp24h: number; minimumWatchSeconds: number } }>(response);
}
export async function updateAdminViewRules(token: string, rules: { eligiblePercent: number; maxViewsPerIp24h: number; minimumWatchSeconds: number }) {
  const response = await fetch(`${BACKEND_URL}/api/admin/view-rules`, { method: "PUT", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify(rules) });
  return parseResponse(response);
}

export async function getCreatorApiKeys(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/creator/api-keys`, { headers: authHeaders(token) });
  return parseResponse<{ keys: Array<{ id: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }> }>(response);
}
export async function createCreatorApiKey(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/creator/api-keys`, { method: "POST", headers: authHeaders(token) });
  return parseResponse<{ key: { id: string; prefix: string; value: string } }>(response);
}

export async function getPlans() {
  const response = await fetch(`${BACKEND_URL}/api/plans`);
  return parseResponse<{ plans: Array<{ id: string; name: string; price_minor: number; currency: string; duration_days: number; video_ads_removed: number; all_ads_removed: number; recurring: number }> }>(response);
}

export async function getSubscription(token: string) {
  if (!token) return { subscription: null };
  const response = await fetch(`${BACKEND_URL}/api/me/subscription`, { headers: authHeaders(token) });
  return parseResponse<{ subscription: { name: string; status: string; expiresAt: string | null; renewsAt: string | null; videoAdsRemoved: number; allAdsRemoved: number; recurring: number } | null }>(response);
}

export async function checkoutSubscription(token: string, planId: string) {
  if (!token) throw new Error("Sign in to NightBox before choosing a subscription plan.");
  const response = await fetch(`${BACKEND_URL}/api/subscriptions/checkout`, { method: "POST", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ planId }) });
  return parseResponse<{ mode: string; subscriptionId: string; order?: unknown; provider?: unknown; keyId?: string }>(response);
}
export async function cancelSubscription(token: string, subscriptionId: string) {
  const response = await fetch(`${BACKEND_URL}/api/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, { method: "POST", headers: authHeaders(token) });
  return parseResponse(response);
}
export async function verifySubscriptionPayment(token: string, payload: Record<string, string | undefined>) {
  const response = await fetch(`${BACKEND_URL}/api/subscriptions/verify`, { method: "POST", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return parseResponse(response);
}
export async function updatePassword(token: string, currentPassword: string, newPassword: string) {
  const response = await fetch(`${BACKEND_URL}/api/account/password`, { method: "POST", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword }) });
  return parseResponse<{ updated: boolean }>(response);
}
export async function getCreatorTickets(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/creator/tickets`, { headers: authHeaders(token) });
  return parseResponse<{ tickets: Array<{ id: string; subject: string; message: string; status: string; adminNote: string | null; createdAt: string; updatedAt: string }> }>(response);
}
export async function createCreatorTicket(token: string, subject: string, message: string) {
  const response = await fetch(`${BACKEND_URL}/api/creator/tickets`, { method: "POST", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ subject, message }) });
  return parseResponse(response);
}
export async function getAdminTickets(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/admin/tickets`, { headers: authHeaders(token) });
  return parseResponse<{ tickets: Array<{ id: string; email: string; subject: string; message: string; status: string; adminNote: string | null; createdAt: string; updatedAt: string }> }>(response);
}
export async function updateAdminTicket(token: string, id: string, status: string, adminNote: string) {
  const response = await fetch(`${BACKEND_URL}/api/admin/tickets/${encodeURIComponent(id)}`, { method: "PUT", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ status, adminNote }) });
  return parseResponse(response);
}
export async function getAdminReports(token: string) { const response = await fetch(`${BACKEND_URL}/api/admin/reports`, { headers: authHeaders(token) }); return parseResponse<{ reports: AdminReport[] }>(response); }
export async function updateAdminReport(token: string, id: string, status: string, adminNote: string) { const response = await fetch(`${BACKEND_URL}/api/admin/reports/${encodeURIComponent(id)}`, { method: "PUT", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ status, adminNote }) }); return parseResponse(response); }
export async function getAdminSettings(token: string) { const response = await fetch(`${BACKEND_URL}/api/admin/settings`, { headers: authHeaders(token) }); return parseResponse<{ settings: Record<string, string | boolean> }>(response); }
export async function getAdminAdsTxt(token: string) { const response = await fetch(`${BACKEND_URL}/api/admin/ads-txt`, { headers: authHeaders(token) }); return parseResponse<{ content: string; updatedAt: string }>(response); }
export async function updateAdminAdsTxt(token: string, content: string) { const response = await fetch(`${BACKEND_URL}/api/admin/ads-txt`, { method: "PUT", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ content }) }); return parseResponse<{ content: string; updatedAt: string }>(response); }
export async function getAdminEvents(token: string) { const response = await fetch(`${BACKEND_URL}/api/admin/events`, { headers: authHeaders(token) }); return parseResponse<{ events: PlatformEvent[] }>(response); }
export async function getEvents() { const response = await fetch(`${BACKEND_URL}/api/events`); return parseResponse<{ events: PlatformEvent[] }>(response); }
export async function getCreatorRewards(token: string) { const response = await fetch(`${BACKEND_URL}/api/creator/rewards`, { headers: authHeaders(token) }); return parseResponse<{ eligibleViews: number; milestones: CreatorRewardMilestone[] }>(response); }
export async function claimCreatorReward(token: string, milestoneId: string) { const response = await fetch(`${BACKEND_URL}/api/creator/rewards/${encodeURIComponent(milestoneId)}/claim`, { method: "POST", headers: authHeaders(token) }); return parseResponse<{ claim: { id: string; milestoneId: string; status: string; createdAt: string } }>(response); }
export async function getAdminRewardMilestones(token: string) { const response = await fetch(`${BACKEND_URL}/api/admin/milestones`, { headers: authHeaders(token) }); return parseResponse<{ milestones: RewardMilestone[] }>(response); }
export async function createAdminRewardMilestone(token: string, milestone: { title: string; description: string; thresholdViews: number; rewardNote: string }) { const response = await fetch(`${BACKEND_URL}/api/admin/milestones`, { method: "POST", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify(milestone) }); return parseResponse<{ milestone: RewardMilestone }>(response); }
export async function updateAdminRewardMilestone(token: string, milestone: RewardMilestone) { const response = await fetch(`${BACKEND_URL}/api/admin/milestones/${encodeURIComponent(milestone.id)}`, { method: "PUT", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify(milestone) }); return parseResponse<{ updated: boolean }>(response); }
export async function getAdminRewardClaims(token: string) { const response = await fetch(`${BACKEND_URL}/api/admin/reward-claims`, { headers: authHeaders(token) }); return parseResponse<{ claims: RewardClaim[] }>(response); }
export async function updateAdminRewardClaim(token: string, id: string, status: "approved" | "rejected" | "fulfilled", adminNote: string) { const response = await fetch(`${BACKEND_URL}/api/admin/reward-claims/${encodeURIComponent(id)}`, { method: "PUT", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ status, adminNote }) }); return parseResponse<{ status: string }>(response); }
export async function createAdminEvent(token: string, event: Record<string, unknown>) { const response = await fetch(`${BACKEND_URL}/api/admin/events`, { method: "POST", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify(event) }); return parseResponse(response); }
export async function updateAdminEvent(token: string, id: string, active: number) { const response = await fetch(`${BACKEND_URL}/api/admin/events/${encodeURIComponent(id)}`, { method: "PUT", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ active }) }); return parseResponse(response); }
export async function sendContactMessage(payload: { name: string; email: string; subject: string; message: string }) { const response = await fetch(`${BACKEND_URL}/api/contact`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); return parseResponse(response); }
export async function submitDmcaReport(payload: { name: string; email: string; videoUrl: string; reason: string }) { const response = await fetch(`${BACKEND_URL}/api/dmca-reports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); return parseResponse(response); }

export async function getCreatorWithdrawals(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/creator/withdrawals`, { headers: authHeaders(token) });
  return parseResponse<{ balanceMicros: number; minimumMicros: number; withdrawals: Array<{ id: string; amountMicros: number; currency: string; method: string; status: string; requestedAt: string }> }>(response);
}

export async function createWithdrawal(token: string, amountMicros: number, method: string) {
  const response = await fetch(`${BACKEND_URL}/api/creator/withdrawals`, { method: "POST", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ amountMicros, method }) });
  return parseResponse<{ balanceMicros: number; withdrawal: { id: string; amountMicros: number; method: string; status: string } }>(response);
}

export async function getAdminWithdrawals(token: string) {
  const response = await fetch(`${BACKEND_URL}/api/admin/withdrawals`, { headers: authHeaders(token) });
  return parseResponse<{ withdrawals: Array<{ id: string; creatorId: string; email: string; amountMicros: number; currency: string; method: string; status: string; requestedAt: string }> }>(response);
}

export async function updateAdminWithdrawal(token: string, id: string, status: "approved" | "paid" | "rejected") {
  const response = await fetch(`${BACKEND_URL}/api/admin/withdrawals/${encodeURIComponent(id)}`, { method: "PUT", headers: { ...authHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
  return parseResponse(response);
}

export { BACKEND_URL };

"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  getAdminAccountDetails,
  getAdminAccountActivity,
  getAdminUsers,
  updateAdminCreator,
  updateAdminUser,
  type AdminAccountDetails,
  type AdminAccountActivitySection,
} from "../src/backend-api";

type AdminUser = Awaited<ReturnType<typeof getAdminUsers>>["users"][number];
type View = "all" | "creators" | "admins";

function formattedDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function gb(bytes: number) { return `${(bytes / 1024 ** 3).toFixed(2)} GiB`; }
function usd(micros: number) { return `USD ${(micros / 1_000_000).toFixed(2)}`; }
function token() { return sessionStorage.getItem("nightbox-admin-token"); }

function DetailSection({ title, count, loaded, loading, onMore, children }: { title: string; count: number; loaded: number; loading: boolean; onMore: () => void; children: ReactNode }) {
  return <details className="admin-account-section">
    <summary><span>{title}</span><b>{count.toLocaleString()}</b></summary>
    <div>{count ? children : <p>No records yet.</p>}{loaded < count && <button className="btn btn-outline admin-account-more" disabled={loading} onClick={onMore}>{loading ? "Loading…" : `Load more (${loaded.toLocaleString()} of ${count.toLocaleString()})`}</button>}</div>
  </details>;
}

export default function AdminAccountDirectory({ view, toast }: { view: View; toast: (message: string) => void }) {
  const [rows, setRows] = useState<AdminUser[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<AdminAccountDetails | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingSection, setLoadingSection] = useState<AdminAccountActivitySection | null>(null);
  const load = useCallback(async () => {
    const adminToken = token();
    if (!adminToken) { setError("Admin session expired"); return; }
    try {
      const result = await getAdminUsers(adminToken);
      setRows(result.users);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load accounts");
    }
  }, []);

  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function open(row: AdminUser, edit = false) {
    const adminToken = token();
    if (!adminToken) { toast("Admin session expired"); return; }
    setLoadingId(row.id);
    try {
      const result = await getAdminAccountDetails(adminToken, row.id);
      setDetail(result);
      setEditing(edit && row.role === "creator");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Unable to load account details");
    } finally {
      setLoadingId(null);
    }
  }

  async function toggle(row: AdminUser) {
    const adminToken = token();
    if (!adminToken) return;
    try {
      await updateAdminUser(adminToken, row.id, row.status === "active" ? "suspended" : "active");
      toast(row.status === "active" ? "Creator suspended" : "Creator activated");
      await load();
      if (detail?.account.id === row.id) setDetail(await getAdminAccountDetails(adminToken, row.id));
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Unable to update account");
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || detail.account.role !== "creator") return;
    const adminToken = token();
    if (!adminToken) return;
    const form = new FormData(event.currentTarget);
    setSaving(true);
    try {
      await updateAdminCreator(adminToken, detail.account.id, {
        email: String(form.get("email") || "").trim(),
        telegramUserId: String(form.get("telegramUserId") || "").trim(),
        status: String(form.get("status") || "active"),
        displayName: String(form.get("displayName") || "").trim(),
        bio: String(form.get("bio") || "").trim(),
        avatarUrl: String(form.get("avatarUrl") || "").trim(),
        brandColor: String(form.get("brandColor") || "#2563eb").trim(),
      });
      const refreshed = await getAdminAccountDetails(adminToken, detail.account.id);
      setDetail(refreshed);
      setEditing(false);
      await load();
      toast("Creator account and public profile updated");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Unable to save creator account");
    } finally {
      setSaving(false);
    }
  }

  async function more(section: AdminAccountActivitySection) {
    if (!detail || loadingSection) return;
    const adminToken = token();
    if (!adminToken) { toast("Admin session expired"); return; }
    const id = detail.account.id;
    setLoadingSection(section);
    try {
      const { records } = await getAdminAccountActivity(adminToken, id, section, detail[section].length);
      setDetail(current => current?.account.id === id ? { ...current, [section]: [...current[section], ...records] } : current);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Unable to load more records");
    } finally {
      setLoadingSection(null);
    }
  }

  const title = view === "creators" ? "Creator management" : view === "admins" ? "Admins" : "Users";
  const filtered = rows.filter(row => view === "all" || row.role === (view === "creators" ? "creator" : "admin"));
  const shown = filtered.filter(row => `${row.email} ${row.id} ${row.telegramUserId || ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const account = detail?.account;
  const summary = detail?.summary;
  const sectionProps = (section: AdminAccountActivitySection, count: number) => ({ count, loaded: detail?.[section].length || 0, loading: loadingSection === section, onMore: () => void more(section) });

  return <>
    <div className="app-title"><div><span>IDENTITY & ACCESS</span><h1>{title}</h1></div><button className="btn btn-dark" onClick={() => void load()}>Refresh</button></div>
    <div className="admin-filters"><div className="search">⌕<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by email, ID or Telegram ID…" aria-label="Search accounts" /></div><span className="admin-list-count">{shown.length} accounts</span></div>
    {error ? <div className="card empty-state" role="alert"><h2>Unable to load accounts</h2><p>{error}</p></div> : <div className="creator-admin-list">
      {shown.map(row => <article className="card creator-admin-card" key={row.id}>
        <div className="creator-admin-identity"><i>{row.email.slice(0, 2).toUpperCase()}</i><div><h2>{row.email}</h2><small>{row.id}</small><span className="admin-account-status">{row.role} · {row.status}</span></div></div>
        <div className="creator-admin-stats"><span><b>{gb(row.storageUsedBytes)}</b><small>storage used</small></span><span><b>{row.role === "creator" ? "No total cap" : "—"}</b><small>storage limit</small></span><span><b>{formattedDate(row.createdAt)}</b><small>joined</small></span></div>
        <div className="creator-admin-actions"><button className="btn btn-outline" disabled={loadingId === row.id} onClick={() => void open(row)}>{loadingId === row.id ? "Loading…" : "View details"}</button>{row.role === "creator" && <><button className="btn btn-primary" onClick={() => void open(row, true)}>Edit</button><button className="btn btn-danger" onClick={() => void toggle(row)}>{row.status === "active" ? "Suspend" : "Activate"}</button></>}</div>
      </article>)}
    </div>}
    {!shown.length && !error && <div className="card empty-state"><h2>No accounts found</h2><p>Try another email, ID or Telegram ID.</p></div>}
    {detail && account && summary && <div className="modal" role="dialog" aria-modal="true" aria-labelledby="admin-account-title">
      <section className="admin-account-modal">
        <button className="modal-close" aria-label="Close account details" onClick={() => { setDetail(null); setEditing(false); }}>×</button>
        <header><span>ACCOUNT RECORD</span><h2 id="admin-account-title">{account.email}</h2><p>{account.id}</p><div className="admin-account-badges"><b>{account.role}</b><b>{account.status}</b><b>Joined {formattedDate(account.createdAt)}</b></div></header>
        {editing ? <form className="admin-account-edit" onSubmit={event => void save(event)}>
          <h3>Edit creator account</h3>
          <label>Email<input name="email" type="email" required defaultValue={account.email} /></label>
          <label>Telegram user ID<input name="telegramUserId" defaultValue={account.telegramUserId || ""} /></label>
          <label>Account status<select name="status" defaultValue={account.status}><option value="active">Active</option><option value="suspended">Suspended</option></select></label>
          <label>Public display name<input name="displayName" maxLength={80} defaultValue={detail.profile?.displayName || ""} /></label>
          <label>Public bio<textarea name="bio" maxLength={280} rows={3} defaultValue={detail.profile?.bio || ""} /></label>
          <label>Avatar URL<input name="avatarUrl" type="url" maxLength={500} defaultValue={detail.profile?.avatarUrl || ""} /></label>
          <label>Brand color<input name="brandColor" type="color" defaultValue={detail.profile?.brandColor || "#2563eb"} /></label>
          <div className="admin-account-actions"><button type="button" className="btn btn-outline" onClick={() => setEditing(false)}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button></div>
        </form> : <>
          <div className="admin-account-actions">{account.role === "creator" && <button className="btn btn-primary" onClick={() => setEditing(true)}>Edit account & profile</button>}</div>
          <div className="admin-account-stats">
            {[ ["Videos", summary.videos], ["Files", summary.files], ["Share links", summary.links], ["Qualified views", summary.qualifiedViews], ["Videos watched", summary.viewingSessions], ["Earnings", usd(summary.earningsMicros)], ["Available", usd(summary.availableMicros)], ["Pending payout", usd(summary.pendingMicros)], ["Paid out", usd(summary.paidMicros)], ["Storage used", summary.storage ? gb(summary.storage.usedBytes) : "—"], ["Storage quota", summary.storage?.quotaBytes ? gb(summary.storage.quotaBytes) : "No total cap"] ].map(([label, value]) => <div key={String(label)}><small>{label}</small><b>{value}</b></div>)}
          </div>
          <nav className="admin-account-management" aria-label="Manage account activity"><a className="btn btn-outline" href="/admin/files">Manage videos</a><a className="btn btn-outline" href="/admin/withdrawals">Manage payouts</a><a className="btn btn-outline" href="/admin/tickets">Manage support</a></nav>
          <div className="admin-account-facts"><p><b>Login methods:</b> {account.hasGoogleLogin ? "Google " : ""}{account.hasPasswordLogin ? "Password" : ""}{!account.hasGoogleLogin && !account.hasPasswordLogin ? "None recorded" : ""}</p><p><b>Telegram:</b> {account.telegramUserId || "Not connected"}</p>{detail.profile && <><p><b>Public name:</b> {detail.profile.displayName || "Not set"}</p><p><b>Bio:</b> {detail.profile.bio || "Not set"}</p><p><b>Public profile:</b> <a href={`https://nightbox.in/creator/${detail.profile.publicSlug}`} target="_blank" rel="noreferrer">{detail.profile.publicSlug}</a></p></>}<p>Uploads allow files up to 2 GiB each. Credentials and password hashes are never displayed.</p></div>
          <DetailSection title="Videos" {...sectionProps("videos", summary.videos)}>{detail.videos.map(item => <div className="admin-account-record" key={item.id}><span><b>{item.title}</b><small>{item.id} · {item.status} · playback {item.playbackStatus}{item.fileSize ? ` · ${gb(item.fileSize)}` : ""}</small></span><time>{formattedDate(item.createdAt)}</time></div>)}</DetailSection>
          <DetailSection title="Files" {...sectionProps("files", summary.files)}>{detail.files.map(item => <div className="admin-account-record" key={item.id}><span><b>{item.name}</b><small>{item.mimeType} · {gb(item.sizeBytes)} · {item.id}</small></span><time>{formattedDate(item.createdAt)}</time></div>)}</DetailSection>
          <DetailSection title="Share links" {...sectionProps("links", summary.links)}>{detail.links.map(item => <div className="admin-account-record" key={item.id}><span><b>{item.videoTitle}</b><small>{item.videoId}</small><a href={`https://nightbox.in/l/${item.slug}`} target="_blank" rel="noreferrer">nightbox.in/l/{item.slug}</a></span><time>{formattedDate(item.createdAt)}</time></div>)}</DetailSection>
          <DetailSection title="Videos watched" {...sectionProps("viewedVideos", summary.viewingSessions)}>{detail.viewedVideos.map(item => <div className="admin-account-record" key={item.id}><span><b>{item.videoTitle}</b><small>{item.country} · {item.counted ? "Qualified" : "Not qualified"} · qualified at {formattedDate(item.qualifiedAt)}</small></span><time>{formattedDate(item.startedAt)}</time></div>)}</DetailSection>
          <DetailSection title="Payouts" {...sectionProps("payouts", summary.payouts)}>{detail.payouts.map(item => <div className="admin-account-record" key={item.id}><span><b>{item.currency} {(item.amountMicros / 1_000_000).toFixed(2)} · {item.status}</b><small>{item.method} · {item.payoutAccount || "No payout account"}</small></span><time>{formattedDate(item.requestedAt)}</time></div>)}</DetailSection>
          <DetailSection title="Support tickets" {...sectionProps("tickets", summary.tickets)}>{detail.tickets.map(item => <div className="admin-account-record" key={item.id}><span><b>{item.subject}</b><small>{item.status} · {item.id}</small></span><time>{formattedDate(item.updatedAt)}</time></div>)}</DetailSection>
          <DetailSection title="Subscriptions" {...sectionProps("subscriptions", summary.subscriptions)}>{detail.subscriptions.map(item => <div className="admin-account-record" key={item.id}><span><b>{item.planName} · {item.status}</b><small>Expires {formattedDate(item.expiresAt)}</small></span><time>{formattedDate(item.createdAt)}</time></div>)}</DetailSection>
          <DetailSection title="Payments" {...sectionProps("payments", summary.payments)}>{detail.payments.map(item => <div className="admin-account-record" key={item.id}><span><b>{item.currency} {(item.amountMinor / 100).toFixed(2)} · {item.status}</b><small>{item.provider} · {item.id}</small></span><time>{formattedDate(item.createdAt)}</time></div>)}</DetailSection>
          <DetailSection title="Bot activity" {...sectionProps("botEvents", summary.botEvents)}>{detail.botEvents.map(item => <div className="admin-account-record" key={item.id}><span><b>{item.botName} · {item.eventType}</b><small>{item.status}{item.videoId ? ` · video ${item.videoId}` : ""}{item.error ? ` · ${item.error}` : ""}</small></span><time>{formattedDate(item.createdAt)}</time></div>)}</DetailSection>
          <DetailSection title="API keys (prefix only)" {...sectionProps("apiKeys", summary.apiKeys)}>{detail.apiKeys.map(item => <div className="admin-account-record" key={item.id}><span><b>{item.prefix}…</b><small>{item.revokedAt ? "Revoked" : "Active"} · last used {formattedDate(item.lastUsedAt)}</small></span><time>{formattedDate(item.createdAt)}</time></div>)}</DetailSection>
          <p className="admin-account-limit-note">Showing the latest {detail.listLimit} records per section. Use Load more to browse older activity.</p>
        </>}
      </section>
    </div>}
  </>;
}

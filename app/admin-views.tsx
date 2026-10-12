"use client";

import { useEffect, useMemo, useState } from "react";
import { getAdminViews, updateAdminView } from "../src/backend-api";

type AdminView = {
  id: string;
  title: string;
  creatorEmail: string;
  country: string;
  counted: number;
  startedAt: string;
  qualifiedAt: string | null;
  amountMicros: number;
};

function formatMoney(micros: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(micros / 1_000_000);
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function statusFor(row: AdminView) {
  if (row.counted) return "eligible";
  return row.qualifiedAt ? "filtered" : "pending";
}

export default function LiveAdminViews({ toast }: { toast: (message: string) => void }) {
  const [rows, setRows] = useState<AdminView[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = async () => {
    const token = sessionStorage.getItem("nightbox-admin-token");
    if (!token) {
      setError("Admin session expired");
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await getAdminViews(token);
      setRows(result.views);
      setError("");
      setUpdatedAt(new Date());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load views");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(); // eslint-disable-line react-hooks/set-state-in-effect
  }, []);

  const review = async (row: AdminView) => {
    const token = sessionStorage.getItem("nightbox-admin-token");
    if (!token) return;
    setBusyId(row.id);
    try {
      await updateAdminView(token, row.id, !Boolean(row.counted));
      toast(row.counted ? "View removed from eligible earnings" : "View approved for eligible earnings");
      setRows((current) => current.map((item) => item.id === row.id ? { ...item, counted: row.counted ? 0 : 1, qualifiedAt: item.qualifiedAt || new Date().toISOString() } : item));
      await load();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Unable to update view");
    } finally {
      setBusyId(null);
    }
  };

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesFilter = filter === "all" || statusFor(row) === filter;
      const matchesQuery = !needle || [row.creatorEmail, row.title, row.country].some((value) => value.toLowerCase().includes(needle));
      return matchesFilter && matchesQuery;
    });
  }, [filter, query, rows]);

  const stats = useMemo(() => ({
    total: rows.length,
    eligible: rows.filter((row) => row.counted).length,
    pending: rows.filter((row) => statusFor(row) === "pending").length,
    earnings: rows.reduce((sum, row) => sum + row.amountMicros, 0),
  }), [rows]);

  return <section className="admin-views-page">
    <div className="admin-view-kpis" aria-label="View review summary">
      <article className="card admin-view-kpi"><span>RECORDED SESSIONS</span><strong>{stats.total.toLocaleString()}</strong><small>Latest 500 sessions</small></article>
      <article className="card admin-view-kpi"><span>ELIGIBLE VIEWS</span><strong>{stats.eligible.toLocaleString()}</strong><small>Currently earning</small></article>
      <article className="card admin-view-kpi"><span>AWAITING REVIEW</span><strong>{stats.pending.toLocaleString()}</strong><small>Not yet qualified</small></article>
      <article className="card admin-view-kpi"><span>RECORDED EARNINGS</span><strong>{formatMoney(stats.earnings)}</strong><small>Across loaded sessions</small></article>
    </div>

    <section className="card admin-view-queue">
      <div className="admin-view-heading">
        <div><span>QUALITY CONTROL</span><h2>Review sessions</h2><p>Approve or revoke individual view sessions before they affect creator earnings.</p></div>
        <div className="admin-view-heading-actions"><small>{updatedAt ? `Updated ${updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Not loaded"}</small><button className="btn btn-dark" onClick={() => void load()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button></div>
      </div>
      <div className="admin-view-toolbar">
        <label className="admin-view-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="Search creator, video or country" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search view sessions"/></label>
        <label className="admin-view-filter"><span>Show</span><select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter view sessions"><option value="all">All sessions</option><option value="pending">Awaiting review</option><option value="eligible">Eligible</option><option value="filtered">Filtered</option></select></label>
      </div>
      {error ? <div className="admin-view-state" role="alert"><b>Unable to load the review queue</b><p>{error}</p><button className="btn btn-outline" onClick={() => void load()}>Try again</button></div> : loading ? <div className="admin-view-skeleton" aria-busy="true" aria-label="Loading review queue">{[1, 2, 3].map((item) => <i key={item}/>)}</div> : !rows.length ? <div className="admin-view-state" role="status"><b>No view sessions recorded yet</b><p>New sessions will appear here after someone opens a NightBox share link.</p></div> : !visibleRows.length ? <div className="admin-view-state" role="status"><b>No matching sessions</b><p>Try a different search term or filter.</p><button className="btn btn-outline" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</button></div> : <div className="admin-view-table" role="table" aria-label="View review sessions">
        <div className="admin-view-table-head" role="row"><span role="columnheader">CREATOR</span><span role="columnheader">VIDEO</span><span role="columnheader">COUNTRY</span><span role="columnheader">STARTED</span><span role="columnheader">EARNED</span><span role="columnheader">STATUS</span><span role="columnheader">ACTION</span></div>
        {visibleRows.map((row) => { const status = statusFor(row); const isBusy = busyId === row.id; return <div className="admin-view-table-row" role="row" key={row.id}>
          <span className="admin-view-creator" role="cell"><b>{row.creatorEmail}</b><small>{row.id.slice(0, 8)}</small></span>
          <span className="admin-view-video" role="cell"><b title={row.title}>{row.title}</b><small>{row.qualifiedAt ? `Qualified ${formatDate(row.qualifiedAt)}` : "Watch time not yet confirmed"}</small></span>
          <span role="cell"><b>{row.country || "ZZ"}</b></span>
          <span className="admin-view-date" role="cell">{formatDate(row.startedAt)}</span>
          <span role="cell"><b>{formatMoney(row.amountMicros)}</b></span>
          <span role="cell"><span className={`admin-view-status ${status}`}><i/>{status === "eligible" ? "Eligible" : status === "filtered" ? "Filtered" : "Awaiting review"}</span></span>
          <span role="cell"><button className="admin-view-action" onClick={() => void review(row)} disabled={isBusy}>{isBusy ? "Saving…" : row.counted ? "Revoke" : "Approve"}</button></span>
        </div> })}
      </div>}
      {!loading && !error && rows.length > 0 && <div className="admin-view-footer"><span>Showing {visibleRows.length} of {rows.length} loaded sessions</span><span>Approval is validated server-side against watch time and IP limits.</span></div>}
    </section>
  </section>;
}

"use client";

import { useEffect, useState } from "react";
import { getAdminViews, updateAdminView } from "../src/backend-api";

type AdminView = {
  id: string;
  title: string;
  creatorEmail: string;
  country: string;
  counted: number;
  amountMicros: number;
};

function formatMoney(micros: number) {
  return `$${(micros / 1_000_000).toFixed(6)}`;
}

export default function LiveAdminViews({ toast }: { toast: (message: string) => void }) {
  const [rows, setRows] = useState<AdminView[]>([]);
  const [error, setError] = useState("");

  const load = () => {
    const token = sessionStorage.getItem("nightbox-admin-token");
    if (!token) {
      setError("Admin session expired");
      return;
    }
    getAdminViews(token)
      .then((result) => setRows(result.views))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to load views"));
  };

  useEffect(() => {
    load(); // eslint-disable-line react-hooks/set-state-in-effect
  }, []);

  const review = async (row: AdminView) => {
    const token = sessionStorage.getItem("nightbox-admin-token");
    if (!token) return;
    try {
      await updateAdminView(token, row.id, !Boolean(row.counted));
      toast(row.counted ? "View removed from eligible earnings" : "View approved for eligible earnings");
      load();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Unable to update view");
    }
  };

  return (
    <section className="card admin-table">
      <div className="card-head">
        <div>
          <b>View review queue</b>
          <span>Server-recorded view sessions and ledger status</span>
        </div>
        <button className="btn btn-dark" onClick={load}>Refresh</button>
      </div>
      {error ? <p className="empty-copy">{error}</p> : rows.length === 0 ? <p className="empty-copy">No view sessions recorded yet.</p> : (
        <>
          <div className="admin-table-head"><span>CREATOR</span><span>VIDEO</span><span>COUNTRY</span><span>EARNED</span><span>STATUS</span><span>ACTION</span></div>
          {rows.map((row) => (
            <div className="admin-table-row" key={row.id}>
              <span>{row.creatorEmail}</span>
              <span>{row.title}</span>
              <span>{row.country}</span>
              <span>{formatMoney(row.amountMicros)}</span>
              <span>{row.counted ? "Eligible" : "Filtered"}</span>
              <button onClick={() => review(row)}>{row.counted ? "Revoke" : "Approve"}</button>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

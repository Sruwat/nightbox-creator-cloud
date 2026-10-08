"use client";

import { useEffect, useState } from "react";
import { cancelAdminSubscription, getAdminPayments, getAdminSubscriptions, refundAdminPayment } from "../src/backend-api";

type Subscription = { id: string; plan_id: string; status: string; provider_subscription_id: string | null; expires_at: string | null };
type Payment = { id: string; provider_payment_id: string | null; amount_minor: number; currency: string; status: string };

export default function AdminPaymentActions({ toast }: { toast: (message: string) => void }) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [error, setError] = useState("");
  const token = () => sessionStorage.getItem("nightbox-admin-token");
  const load = () => {
    const auth = token();
    if (!auth) { setError("Admin session expired"); return; }
    Promise.all([getAdminSubscriptions(auth), getAdminPayments(auth)])
      .then(([subscriptionData, paymentData]) => { setSubscriptions(subscriptionData.subscriptions); setPayments(paymentData.payments); })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to load payment actions"));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps

  const cancel = async (id: string) => {
    const auth = token();
    if (!auth) return;
    try { await cancelAdminSubscription(auth, id); toast("Subscription cancelled"); load(); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "Unable to cancel subscription"); }
  };
  const refund = async (id: string) => {
    const auth = token();
    if (!auth) return;
    try { await refundAdminPayment(auth, id); toast("Payment refund requested"); load(); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "Unable to refund payment"); }
  };

  return <section className="card admin-table">
    <div className="card-head"><div><b>Payment actions</b><span>Provider-backed cancellation and refund controls</span></div><button className="btn btn-dark" onClick={load}>Refresh</button></div>
    {error ? <p className="empty-copy">{error}</p> : <>
      {subscriptions.filter((row) => ["pending", "active"].includes(row.status)).map((row) => <div className="admin-table-row" key={row.id}><span>{row.plan_id}</span><span>{row.status}</span><span>{row.expires_at ? new Date(row.expires_at).toLocaleDateString() : "-"}</span><span /><span /><button onClick={() => cancel(row.id)}>Cancel</button></div>)}
      {payments.filter((row) => row.status === "paid").map((row) => <div className="admin-table-row" key={row.id}><span>{row.provider_payment_id || row.id.slice(0, 8)}</span><span>{row.currency} {(row.amount_minor / 100).toFixed(2)}</span><span>Paid</span><span /><span /><button onClick={() => refund(row.id)}>Refund</button></div>)}
      {!subscriptions.some((row) => ["pending", "active"].includes(row.status)) && !payments.some((row) => row.status === "paid") && <p className="empty-copy">No provider actions are currently available.</p>}
    </>}
  </section>;
}

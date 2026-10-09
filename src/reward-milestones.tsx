import { useEffect, useState } from "react";
import {
  claimCreatorReward,
  createAdminRewardMilestone,
  getCreatorRewards,
  getAdminRewardClaims,
  getAdminRewardMilestones,
  updateAdminRewardClaim,
  updateAdminRewardMilestone,
  type CreatorRewardMilestone,
  type RewardClaim,
  type RewardMilestone,
} from "./backend-api";

export function CreatorRewardMilestones({ token, toast }: { token: string; toast: (message: string) => void }) {
  const [eligibleViews, setEligibleViews] = useState(0);
  const [milestones, setMilestones] = useState<CreatorRewardMilestone[]>([]);
  const load = async () => {
    const payload = await getCreatorRewards(token);
    setEligibleViews(payload.eligibleViews);
    setMilestones(payload.milestones);
  };
  useEffect(() => {
    let active = true;
    void getCreatorRewards(token)
      .then((payload) => {
        if (active) { setEligibleViews(payload.eligibleViews); setMilestones(payload.milestones); }
      })
      .catch(() => { if (active) setMilestones([]); });
    return () => { active = false; };
  }, [token]);
  async function claim(id: string) {
    try {
      await claimCreatorReward(token, id);
      await load();
      toast("Milestone claim submitted for review");
    } catch (error) { toast(error instanceof Error ? error.message : "Claim could not be submitted"); }
  }
  return <section className="card reward-panel">
    <div className="card-head"><div><b>Reward milestones</b><span>{eligibleViews.toLocaleString()} eligible views recorded</span></div></div>
    {milestones.length ? milestones.map((milestone) => <article className="reward-row" key={milestone.id}>
      <div><b>{milestone.title}</b><span>{milestone.description}</span><small>{milestone.thresholdViews.toLocaleString()} qualified views · {milestone.rewardNote}</small></div>
      {milestone.claimStatus ? <span className="pill pill-blue">{milestone.claimStatus}</span> : milestone.eligible ? <button className="btn btn-primary" onClick={() => void claim(milestone.id)}>Claim</button> : <span className="reward-progress">{Math.min(100, Math.floor(eligibleViews / milestone.thresholdViews * 100))}%</span>}
    </article>) : <p className="empty-copy">No reward milestones are currently available.</p>}
  </section>;
}

export function AdminRewardMilestones({ toast }: { toast: (message: string) => void }) {
  const [milestones, setMilestones] = useState<RewardMilestone[]>([]);
  const [claims, setClaims] = useState<RewardClaim[]>([]);
  const [form, setForm] = useState({ title: "", description: "", thresholdViews: "", rewardNote: "" });
  const token = () => sessionStorage.getItem("nightbox-admin-token") || "";
  async function load() {
    const authToken = token();
    if (!authToken) return;
    const [milestoneResult, claimResult] = await Promise.all([getAdminRewardMilestones(authToken), getAdminRewardClaims(authToken)]);
    setMilestones(milestoneResult.milestones);
    setClaims(claimResult.claims);
  }
  useEffect(() => {
    let active = true;
    const authToken = token();
    if (authToken) Promise.all([getAdminRewardMilestones(authToken), getAdminRewardClaims(authToken)]).then(([milestoneResult, claimResult]) => {
      if (active) { setMilestones(milestoneResult.milestones); setClaims(claimResult.claims); }
    }).catch(() => { if (active) { setMilestones([]); setClaims([]); } });
    return () => { active = false; };
  }, []);
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await createAdminRewardMilestone(token(), { ...form, thresholdViews: Number(form.thresholdViews) });
      setForm({ title: "", description: "", thresholdViews: "", rewardNote: "" });
      await load();
      toast("Reward milestone published");
    } catch (error) { toast(error instanceof Error ? error.message : "Milestone could not be published"); }
  }
  async function toggle(milestone: RewardMilestone) {
    try { await updateAdminRewardMilestone(token(), { ...milestone, active: milestone.active ? 0 : 1 }); await load(); }
    catch (error) { toast(error instanceof Error ? error.message : "Milestone could not be updated"); }
  }
  async function updateClaim(claim: RewardClaim, status: "approved" | "rejected" | "fulfilled") {
    const adminNote = window.prompt("Optional fulfillment/review note", claim.adminNote || "") || "";
    try { await updateAdminRewardClaim(token(), claim.id, status, adminNote); await load(); toast(`Claim ${status}`); }
    catch (error) { toast(error instanceof Error ? error.message : "Claim could not be updated"); }
  }
  return <>
    <section className="card compact-form">
      <h2>Configure a view milestone</h2>
      <p>Only publish a reward after its eligibility rules, budget and fulfillment terms are approved.</p>
      <form onSubmit={create}>
        <label>Milestone title<input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} maxLength={180}/></label>
        <label>Description<textarea required value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} maxLength={2000}/></label>
        <div className="two"><label>Qualified views<input required type="number" min="1" step="1" value={form.thresholdViews} onChange={(event) => setForm({ ...form, thresholdViews: event.target.value })}/></label><label>Reward details<input required value={form.rewardNote} onChange={(event) => setForm({ ...form, rewardNote: event.target.value })} maxLength={1000}/></label></div>
        <button className="btn btn-primary">Publish milestone</button>
      </form>
    </section>
    <section className="card reward-panel"><div className="card-head"><div><b>Configured milestones</b><span>Eligibility updates from server-qualified view counts</span></div></div>
      {milestones.map((milestone) => <article className="reward-row" key={milestone.id}><div><b>{milestone.title}</b><span>{milestone.thresholdViews.toLocaleString()} qualified views · {milestone.rewardNote}</span></div><button onClick={() => void toggle(milestone)}>{milestone.active ? "Pause" : "Activate"}</button></article>)}
      {!milestones.length && <p className="empty-copy">No milestones configured.</p>}
    </section>
    <section className="card reward-panel"><div className="card-head"><div><b>Reward claims</b><span>Review and record fulfillment manually</span></div></div>
      {claims.map((claim) => <article className="reward-row" key={claim.id}><div><b>{claim.creatorEmail} · {claim.milestoneTitle}</b><span>{claim.thresholdViews.toLocaleString()} views · {claim.rewardNote}</span><small>Status: {claim.status}{claim.adminNote ? ` · ${claim.adminNote}` : ""}</small></div><div className="reward-actions">{claim.status === "claimed" && <><button onClick={() => void updateClaim(claim,"approved")}>Approve</button><button onClick={() => void updateClaim(claim,"rejected")}>Reject</button></>}{claim.status === "approved" && <><button onClick={() => void updateClaim(claim,"fulfilled")}>Mark fulfilled</button><button onClick={() => void updateClaim(claim,"rejected")}>Reject</button></>}</div></article>)}
      {!claims.length && <p className="empty-copy">No reward claims yet.</p>}
    </section>
  </>;
}

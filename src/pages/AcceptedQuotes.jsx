import { useMemo } from "react";
import { money } from "../utils/formatters";
export default function AcceptedQuotes({ quotes, onOpenQuote }) {
  const accepted = useMemo(() => quotes.filter(q => q.status === "Accepted"), [quotes]);
  const value = accepted.reduce((sum, q) => sum + Number(q.amount || 0), 0);
  const rate = quotes.length ? (accepted.length / quotes.length * 100) : 0;
  const average = accepted.length ? value / accepted.length : 0;
  return <section className="accepted-page">
    <div className="accepted-heading">
      <h2>Accepted Quotes</h2>
      <p>Track accepted quote value, not confirmed payments.</p>
    </div>
    <div className="accepted-stats">
      <div className="accepted-stat"><span>Accepted Quote Value</span><strong>{money(value)}</strong></div>
      <div className="accepted-stat"><span>Accepted Quotes</span><strong>{accepted.length}</strong></div>
      <div className="accepted-stat"><span>Acceptance Rate</span><strong>{rate.toFixed(1)}%</strong></div>
      <div className="accepted-stat"><span>Average Accepted Value</span><strong>{money(average)}</strong></div>
    </div>
    <div className="accepted-list">
      <h3>Accepted Rental Quotes</h3>
      {accepted.length === 0 ? <p className="accepted-empty">No accepted quotes yet.</p> : accepted.map(q => (
        <div className="accepted-item" key={q.id}>
          <div><strong>{q.customer}</strong><p>{q.id} · {q.equipment}</p></div>
          <div className="accepted-item-actions">
            <strong>{money(q.amount)}</strong>
            <button type="button" className="queue-open" onClick={() => onOpenQuote(q.id)}>View Details</button>
          </div>
        </div>
      ))}
    </div>
    <p className="accepted-disclaimer">Accepted quote value is not realized revenue or money collected. All amounts are fictional demo data.</p>
  </section>;
}

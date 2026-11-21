import { AlertCircle, ArrowUpRight } from "lucide-react";
import FollowUpQueue from "../components/FollowUpQueue";

export default function FollowUps({ flow, onOpenQuote }) {
  const needsAttention = (flow.quotes ?? []).filter(
    (quote) => quote.status === "Follow-up Due" && !flow.followUps?.[quote.id],
  );

  return (
    <div className="followups-page">
      {needsAttention.length > 0 && (
        <section className="followup-queue needs-attention">
          <div className="queue-heading">
            <div>
              <div className="queue-title">
                <AlertCircle size={21} />
                <h2>Needs Attention</h2>
              </div>

              <p>
                These quotes need a follow-up but haven't been scheduled yet.
              </p>
            </div>

            <div className="queue-summary">
              <span>{needsAttention.length} unscheduled</span>
            </div>
          </div>

          <div className="queue-list">
            {needsAttention.map((quote) => (
              <div className="queue-item" key={quote.id}>
                <div className="queue-customer">
                  <strong>{quote.customer}</strong>
                  <span>
                    {quote.id} · {quote.equipment}
                  </span>
                </div>

                <span className="queue-badge overdue">Needs Follow-up</span>

                <button
                  type="button"
                  className="queue-open"
                  onClick={() => onOpenQuote(quote.id)}
                >
                  Schedule
                  <ArrowUpRight size={15} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <FollowUpQueue
        followUpQueue={flow.followUpQueue ?? []}
        overdueCount={flow.overdueCount ?? 0}
        onOpenQuote={onOpenQuote}
      />
    </div>
  );
}

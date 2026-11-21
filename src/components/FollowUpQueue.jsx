import { ListTodo, AlertCircle, CheckCircle2, ArrowUpRight } from "lucide-react";
export default function FollowUpQueue({ followUpQueue, overdueCount, onOpenQuote }) {
  return (
          <section className="followup-queue">
            <div className="queue-heading">
              <div>
                <div className="queue-title">
                  <ListTodo size={21} />
                  <h2>Follow-Up Queue</h2>
                </div>

                <p>Review upcoming and overdue customer follow-ups.</p>
              </div>

              <div className="queue-summary">
                <span>{followUpQueue.length} scheduled</span>

                {overdueCount > 0 && (
                  <span className="queue-overdue">
                    <AlertCircle size={14} />
                    {overdueCount} overdue
                  </span>
                )}
              </div>
            </div>

            {followUpQueue.length === 0 ? (
              <div className="queue-empty">
                <CheckCircle2 size={26} />
                <h3>No follow-ups scheduled</h3>
                <p>
                  Schedule a follow-up from a quote's details to see it here.
                </p>
              </div>
            ) : (
              <div className="queue-list">
                {followUpQueue.map((quote) => (
                  <div className="queue-item" key={quote.id}>
                    <div className="queue-customer">
                      <strong>{quote.customer}</strong>
                      <span>
                        {quote.id} · {quote.equipment}
                      </span>
                    </div>

                    <div className="queue-date">
                      <span
                        className={
                          quote.isDue
                            ? "queue-badge overdue"
                            : "queue-badge upcoming"
                        }
                      >
                        {quote.isDue ? "Due" : "Upcoming"}
                      </span>

                      <small>
                        {new Date(quote.scheduledAt).toLocaleString("en-US", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </small>
                    </div>

                    <button
                      className="queue-open"
                      onClick={() => onOpenQuote(quote.id)}
                    >
                      View Quote
                      <ArrowUpRight size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
  );
}

import { X, CalendarClock, CheckCircle2, History } from "lucide-react";
import FollowUpPreview from "./FollowUpPreview";
import { money } from "../utils/formatters";
import { MAX_FOLLOWUPS, getFollowUpCount } from "../utils/followUpRules";
export default function QuoteDetails({ selectedQuote, selectedFollowUp, selectedActivity, followUpDate, onSetFollowUpDate, onScheduleFollowUp, onSimulateFollowUp, onClose }) {
  return (
        <div
          className="detail-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              onClose();
            }
          }}
        >
          <aside
            className="detail-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-title"
          >
            <div className="detail-header">
              <div>
                <p className="eyebrow">RENTAL QUOTE DETAILS</p>
                <h2 id="detail-title">{selectedQuote.id}</h2>
              </div>

              <button
                className="icon-button"
                onClick={onClose}
                aria-label="Close quote details"
              >
                <X size={20} />
              </button>
            </div>

            <div className="detail-section">
              <span className="detail-label">CUSTOMER</span>
              <h3>{selectedQuote.customer}</h3>

              <div className="detail-info-grid">
                <div>
                  <span className="detail-label">EQUIPMENT</span>
                  <p>{selectedQuote.equipment}</p>
                </div>

                <div>
                  <span className="detail-label">QUOTE DATE</span>
                  <p>{selectedQuote.date}</p>
                </div>

                <div>
                  <span className="detail-label">QUOTE VALUE</span>
                  <p className="detail-value">{money(selectedQuote.amount)}</p>
                </div>

                <div>
                  <span className="detail-label">STATUS</span>
                  <p>{selectedQuote.status}</p>
                </div>
              </div>
            </div>

            <div className="detail-section">
              <div className="detail-section-title">
                <CalendarClock size={19} />
                <h3>Follow-up Scheduling</h3>
              </div>

              {selectedQuote.status === "Accepted" ? (
                <p className="detail-description">
                  This quote has been accepted. No further follow-up is
                  scheduled.
                </p>
              ) : (
                <>
                  <p className="detail-description">
                    Choose when your team should follow up with this customer.
                    This is a simulated reminder.
                  </p>

                  {selectedFollowUp && (
                    <div className="scheduled-info">
                      <CheckCircle2 size={17} />
                      <span>
                        Scheduled for{" "}
                        {new Date(selectedFollowUp).toLocaleString("en-US", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </span>
                    </div>
                  )}

                  {getFollowUpCount(selectedActivity) >= MAX_FOLLOWUPS && (
                    <p className="detail-description">
                      The demonstration follow-up limit has been reached. No
                      additional follow-ups can be scheduled.
                    </p>
                  )}

                  <form className="followup-form" onSubmit={onScheduleFollowUp}>
                    <label htmlFor="followup-date">
                      Follow-up date and time
                    </label>

                    <input
                      id="followup-date"
                      type="datetime-local"
                      required
                      value={followUpDate}
                      onChange={(event) => onSetFollowUpDate(event.target.value)}
                    />

                    <button
                      type="submit"
                      className="primary-button"
                      disabled={
                        getFollowUpCount(selectedActivity) >= MAX_FOLLOWUPS
                      }
                    >
                      <CalendarClock size={17} />
                      {selectedFollowUp
                        ? "Reschedule Follow-up"
                        : "Schedule Follow-up"}
                    </button>
                  </form>
                </>
              )}
            </div>

            <div className="detail-section">
              <FollowUpPreview
                key={selectedQuote.id}
                quote={selectedQuote}
                scheduledAt={selectedFollowUp}
                attemptsRemaining={MAX_FOLLOWUPS - getFollowUpCount(selectedActivity)}
                onSimulate={onSimulateFollowUp}
              />
            </div>

            <div className="detail-section">
              <div className="detail-section-title">
                <History size={19} />
                <h3>Activity History</h3>
              </div>


              {selectedActivity.length === 0 ? (
                <p className="detail-description">
                  No follow-up activity recorded yet.
                </p>
              ) : (
                <div className="activity-list">
                  {selectedActivity.map((event) => (
                    <div className="activity-item" key={event.id}>
                      <div className="activity-dot" />

                      <div>
                        <p>{event.description}</p>
                        <small>
                          {new Date(event.timestamp).toLocaleString("en-US", {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </small>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="detail-footer">
              Demonstration only. No outgoing messages or real customer
              information.
            </div>
          </aside>
        </div>
  );
}

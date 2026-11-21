import { useEffect, useState } from "react";
import { Mail, Send, ShieldCheck, CalendarClock } from "lucide-react";

function generateMessage(quote, tone) {
  const customer = quote.customer;

  if (tone === "friendly") {
    return `Hi ${customer},

Just checking in about your rental quote for the ${quote.equipment}.

Are you still looking to move forward, or is there anything we can help clarify?

Your quote reference is ${quote.id}.

Thanks,
The Rental Team`;
  }

  if (tone === "brief") {
    return `Hi ${customer},

Following up on quote ${quote.id} for the ${quote.equipment}.

Are you still interested in proceeding?

Thanks,
The Rental Team`;
  }

  return `Hello ${customer},

We are following up regarding your rental quote ${quote.id} for the ${quote.equipment}.

Please let us know if you would like to proceed or require any additional information.

We appreciate your consideration.

Best regards,
The Rental Team`;
}

export default function FollowUpPreview({
  quote,
  scheduledAt,
  attemptsRemaining = 2,
  onSimulate,
}) {
  const [tone, setTone] = useState("professional");

  const [message, setMessage] = useState(() =>
    generateMessage(quote, "professional"),
  );

  useEffect(() => {
    setMessage(generateMessage(quote, tone));
  }, [quote.id, quote.customer, quote.equipment, tone]);

  const isAccepted = quote.status === "Accepted";
  const isScheduled = Boolean(scheduledAt);

  const isDue = isScheduled && new Date(scheduledAt).getTime() <= Date.now();

  const canSimulate = !isAccepted && isScheduled && attemptsRemaining > 0;

  function handleSimulation() {
    if (!canSimulate || !message.trim()) return;

    onSimulate(message);
  }

  return (
    <section className="preview-content">
      <div className="detail-section-title">
        <Mail size={19} />
        <h3>Follow-up Message Preview</h3>
      </div>

      <p className="detail-description">
        Review and customize the message that could be sent to this customer.
      </p>

      <div className="workflow-status">
        <CalendarClock size={16} />

        {isAccepted
          ? "Quote accepted — follow-ups disabled"
          : attemptsRemaining <= 0
            ? "Follow-up limit reached"
            : !isScheduled
              ? "Schedule a follow-up to enable simulation"
              : isDue
                ? "Scheduled follow-up is due"
                : "Follow-up scheduled for a future time"}
      </div>

      <p className="simulation-disclaimer">
        Remaining simulated follow-ups: {attemptsRemaining}
      </p>

      <div className="preview-field">
        <label htmlFor="message-tone">Message tone</label>

        <select
          id="message-tone"
          value={tone}
          onChange={(event) => setTone(event.target.value)}
        >
          <option value="professional">Professional</option>
          <option value="friendly">Friendly</option>
          <option value="brief">Brief</option>
        </select>
      </div>

      <div className="preview-field">
        <label htmlFor="message-subject">Email subject</label>

        <input
          id="message-subject"
          readOnly
          value={`Following up on rental quote ${quote.id}`}
        />
      </div>

      <div className="preview-field">
        <label htmlFor="message-body">Message body</label>

        <textarea
          id="message-body"
          rows={11}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
      </div>

      <div className="preview-notice">
        <ShieldCheck size={18} />
        <span>
          Demonstration mode: no email will be delivered to any customer.
        </span>
      </div>

      <button
        type="button"
        className="primary-button simulate-button"
        onClick={handleSimulation}
        disabled={!canSimulate || !message.trim()}
      >
        <Send size={17} />
        Simulate Follow-up Now
      </button>

      <p className="simulation-disclaimer">
        Simulation processes the scheduled follow-up immediately for
        demonstration purposes. No email is sent.
      </p>
    </section>
  );
}

import { Plus, X } from "lucide-react";
export default function NewQuoteModal({ form, setForm, onClose, onAddQuote }) {
  return (
        <div
          className="modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">NEW RENTAL REQUEST</p>
                <h2 id="modal-title">Create a Quote</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => onClose()}
                aria-label="Close form"
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={onAddQuote} autoComplete="off">
              <label>
                Customer / Business Name
                <input
                  required
                  value={form.customer}
                  placeholder="e.g. Texas Construction LLC"
                  onChange={(e) =>
                    setForm({ ...form, customer: e.target.value })
                  }
                />
              </label>

              <label>
                Equipment Requested
                <input
                  required
                  value={form.equipment}
                  placeholder="e.g. CAT 305 Excavator"
                  onChange={(e) =>
                    setForm({ ...form, equipment: e.target.value })
                  }
                />
              </label>

              <label>
                Quote Value ($)
                <input
                  required
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={form.amount}
                  placeholder="1500"
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </label>

              <button type="submit" className="primary-button submit-button">
                <Plus size={18} />
                Create Quote
              </button>
            </form>
          </section>
        </div>
  );
}

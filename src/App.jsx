import "./App.css";
import { useMemo, useState, useEffect } from "react";
import {
  LayoutDashboard,
  FileText,
  Clock3,
  CheckCircle2,
  Search,
  Plus,
  ArrowUpRight,
  RefreshCw,
  Truck,
  X,
  Send,
  CalendarClock,
  History,
  Eye,
  ListTodo,
  AlertCircle,
} from "lucide-react";
import {
  MAX_FOLLOWUPS,
  getFollowUpCount,
  validateFollowUp,
} from "./utils/followUpRules";

import FollowUpPreview from "./components/FollowUpPreview";
import usePersistentState from "./hooks/usePersistentState";

const initialQuotes = [
  {
    id: "QT-1001",
    customer: "West Texas Construction",
    equipment: "CAT 305 Mini Excavator",
    amount: 1850,
    date: "Nov 18, 2026",
    status: "Follow-up Due",
  },
  {
    id: "QT-1002",
    customer: "Lone Star Contractors",
    equipment: "Bobcat S650 Skid Steer",
    amount: 2400,
    date: "Nov 19, 2026",
    status: "Pending",
  },
  {
    id: "QT-1003",
    customer: "Permian Basin Services",
    equipment: "19ft Scissor Lift",
    amount: 975,
    date: "Nov 16, 2026",
    status: "Follow-up Due",
  },
  {
    id: "QT-1004",
    customer: "Summit Siteworks",
    equipment: "John Deere 310 Backhoe",
    amount: 3200,
    date: "Nov 14, 2026",
    status: "Accepted",
  },
  {
    id: "QT-1005",
    customer: "Red Rock Development",
    equipment: "12k Telehandler",
    amount: 4100,
    date: "Nov 19, 2026",
    status: "Pending",
  },
];

const money = (value) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);

function App() {
  const [quotes, setQuotes] = usePersistentState(
    "rentflow-demo-v1-quotes",
    initialQuotes,
  );
  const [activePage, setActivePage] = useState("overview");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const [showForm, setShowForm] = useState(false);
  const [notification, setNotification] = useState("");

  const [form, setForm] = useState({
    customer: "",
    equipment: "",
    amount: "",
  });

  const [selectedQuoteId, setSelectedQuoteId] = useState(null);

  const [followUps, setFollowUps] = usePersistentState(
    "rentflow-demo-v1-followups",
    {},
  );

  const [activityLog, setActivityLog] = usePersistentState(
    "rentflow-demo-v1-activity",
    {},
  );

  const [followUpDate, setFollowUpDate] = useState("");

  const selectedQuote =
    quotes.find((quote) => quote.id === selectedQuoteId) ?? null;

  const selectedFollowUp = selectedQuote ? followUps[selectedQuote.id] : null;

  const selectedActivity = selectedQuote
    ? (activityLog[selectedQuote.id] ?? [])
    : [];

  const [currentTime, setCurrentTime] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  const followUpQueue = useMemo(() => {
    return quotes
      .filter((quote) => {
        return quote.status !== "Accepted" && Boolean(followUps[quote.id]);
      })
      .map((quote) => {
        const scheduledAt = followUps[quote.id];

        const scheduledTime = new Date(scheduledAt).getTime();

        return {
          ...quote,
          scheduledAt,
          scheduledTime,
          isDue: scheduledTime <= currentTime,
        };
      })
      .filter((quote) => Number.isFinite(quote.scheduledTime))
      .sort((a, b) => a.scheduledTime - b.scheduledTime);
  }, [quotes, followUps, currentTime]);

  const overdueCount = followUpQueue.filter((quote) => quote.isDue).length;

  const actionDueCount =
    quotes.filter(
      (quote) => quote.status === "Follow-up Due" && !followUps[quote.id],
    ).length + overdueCount;

  const stats = useMemo(() => {
    const active = quotes.filter((q) => q.status !== "Accepted");

    return {
      total: quotes.length,
      outstanding: active.reduce((sum, q) => sum + q.amount, 0),
      followups: quotes.filter((q) => q.status === "Follow-up Due").length,
      accepted: quotes.filter((q) => q.status === "Accepted").length,
    };
  }, [quotes]);

  const filteredQuotes = useMemo(() => {
    const term = search.toLowerCase().trim();

    return quotes.filter((q) => {
      const matchesSearch =
        q.customer.toLowerCase().includes(term) ||
        q.equipment.toLowerCase().includes(term) ||
        q.id.toLowerCase().includes(term);

      const matchesFilter = filter === "All" || q.status === filter;

      return matchesSearch && matchesFilter;
    });
  }, [quotes, search, filter]);

  const addActivity = (quoteId, description, type = "general") => {
    const newEvent = {
      id: crypto.randomUUID(),
      description,
      type,
      timestamp: new Date().toISOString(),
    };

    setActivityLog((current) => ({
      ...current,
      [quoteId]: [newEvent, ...(current[quoteId] ?? [])],
    }));
  };

  const openQuote = (quoteId) => {
    setSelectedQuoteId(quoteId);

    const existingDate = followUps[quoteId];

    setFollowUpDate(existingDate ? existingDate.slice(0, 16) : "");
  };

  const closeQuote = () => {
    setSelectedQuoteId(null);
    setFollowUpDate("");
  };

  const updateStatus = (id, status) => {
    const quote = quotes.find((item) => item.id === id);

    if (!quote || quote.status === status) return;

    setQuotes((current) =>
      current.map((item) => (item.id === id ? { ...item, status } : item)),
    );

    // Accepted quotes no longer need a scheduled follow-up.
    if (status === "Accepted") {
      setFollowUps((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }

    addActivity(id, `Quote status changed to ${status}.`);

    setNotification(`Quote updated to ${status}.`);
  };

  const scheduleFollowUp = (event) => {
    event.preventDefault();

    if (!selectedQuote) return;

    const error = validateFollowUp({
      quote: selectedQuote,
      scheduledDate: followUpDate,
      activity: activityLog[selectedQuote.id] ?? [],
    });

    if (error) {
      setNotification(error);
      return;
    }

    const date = new Date(followUpDate);

    const formattedDate = date.toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });

    const wasScheduled = Boolean(followUps[selectedQuote.id]);

    setFollowUps((current) => ({
      ...current,
      [selectedQuote.id]: date.toISOString(),
    }));

    setQuotes((current) =>
      current.map((quote) =>
        quote.id === selectedQuote.id
          ? { ...quote, status: "Follow-up Scheduled" }
          : quote,
      ),
    );

    addActivity(
      selectedQuote.id,
      `${wasScheduled ? "Rescheduled" : "Scheduled"} demo follow-up for ${formattedDate}.`,
      "scheduling",
    );

    setNotification(
      `Follow-up scheduled for ${formattedDate}. No email was sent.`,
    );
  };

  const simulateFollowUp = (message) => {
    if (!selectedQuote) return;

    const quoteId = selectedQuote.id;
    const scheduledAt = followUps[quoteId];

    const completedCount = getFollowUpCount(activityLog[quoteId] ?? []);

    if (selectedQuote.status === "Accepted") {
      setNotification("Cannot follow up on an accepted quote.");
      return;
    }

    if (!scheduledAt) {
      setNotification("Schedule a follow-up first.");
      return;
    }

    if (completedCount >= MAX_FOLLOWUPS) {
      setNotification("Follow-up limit reached.");
      return;
    }

    if (!message.trim()) {
      setNotification("The message cannot be empty.");
      return;
    }

    addActivity(
      quoteId,
      "Follow-up simulated successfully. No email was sent.",
      "simulation",
    );

    setFollowUps((current) => {
      const next = { ...current };
      delete next[quoteId];
      return next;
    });

    setQuotes((current) =>
      current.map((quote) =>
        quote.id === quoteId ? { ...quote, status: "Pending" } : quote,
      ),
    );

    setFollowUpDate("");

    const remaining = MAX_FOLLOWUPS - completedCount - 1;

    setNotification(
      `Simulation complete. ${remaining} follow-up(s) remaining. No email sent.`,
    );
  };

  const addQuote = (event) => {
    event.preventDefault();

    const amount = Number(form.amount);

    if (
      !form.customer.trim() ||
      !form.equipment.trim() ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return;
    }

    const nextId =
      Math.max(1000, ...quotes.map((q) => Number(q.id.split("-")[1]))) + 1;

    const newQuote = {
      id: `QT-${nextId}`,
      customer: form.customer.trim(),
      equipment: form.equipment.trim(),
      amount,
      date: new Date().toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
      status: "Pending",
    };

    setQuotes((current) => [newQuote, ...current]);
    setForm({ customer: "", equipment: "", amount: "" });
    setShowForm(false);
    setFilter("All");
    setSearch("");
    setNotification("Demo quote created successfully.");
  };

  const resetDemo = () => {
    setQuotes(initialQuotes);
    setFollowUps({});
    setActivityLog({});
    setSelectedQuoteId(null);
    setFollowUpDate("");
    setFilter("All");
    setSearch("");
    setShowForm(false);
    setNotification("Demo data restored.");
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-icon">
            <Truck size={23} />
          </div>
          <div>
            <strong>RENTFLOW</strong>
            <small>QUOTE AUTOMATION</small>
          </div>
        </div>

        <p className="sidebar-heading">WORKSPACE</p>

        <nav className="navigation" aria-label="Main navigation">
          <button
            className={`nav-item ${activePage === "overview" ? "active" : ""}`}
            onClick={() => setActivePage("overview")}
          >
            <LayoutDashboard size={18} />
            <span>Overview</span>
          </button>

          <button
            className={`nav-item ${activePage === "quotes" ? "active" : ""}`}
            onClick={() => {
              setActivePage("quotes");
              setFilter("All");
            }}
          >
            <FileText size={18} />
            <span>Rental Quotes</span>
          </button>

          <button
            className={`nav-item ${activePage === "followups" ? "active" : ""}`}
            onClick={() => setActivePage("followups")}
          >
            <Clock3 size={18} />
            <span>Follow-ups</span>
            <span className="nav-count">{actionDueCount}</span>
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="demo-indicator">
            <span className="live-dot" />
            DEMONSTRATION MODE
          </div>
          <p>No real customer data or emails.</p>
        </div>
      </aside>

      <main className="main-content">
        <div className="demo-banner" role="note">
          <div>
            <strong>INTERACTIVE PRODUCT DEMO</strong>
            <p>
              All customers and quotes are fictional. Follow-ups are simulated.
              No emails are sent.
            </p>
          </div>

          <span className="demo-banner-tag">DEMO MODE</span>
        </div>

        <header className="page-header">
          <div>
            <p className="eyebrow">RENTAL OPERATIONS</p>

            <h1>
              {activePage === "overview"
                ? "Overview"
                : activePage === "quotes"
                  ? "Rental Quotes"
                  : "Follow-ups"}
            </h1>

            <p className="subtitle">
              {activePage === "overview"
                ? "Track your quotes, follow-ups, and rental opportunities."
                : activePage === "quotes"
                  ? "Manage rental quotes and customer requests."
                  : "Review upcoming and overdue customer follow-ups."}
            </p>
          </div>

          <button className="primary-button" onClick={() => setShowForm(true)}>
            <Plus size={18} />
            New Quote
          </button>
        </header>

        {activePage === "overview" && (
          <>
            <section className="stats-grid" aria-label="Quote statistics">
              <article className="stat-card">
                <div className="stat-icon blue">
                  <FileText size={20} />
                </div>
                <span className="stat-label">Total Quotes</span>
                <h2>{stats.total}</h2>
                <p>Quotes in this demo</p>
              </article>

              <article className="stat-card">
                <div className="stat-icon purple">
                  <ArrowUpRight size={20} />
                </div>
                <span className="stat-label">Outstanding Value</span>
                <h2>{money(stats.outstanding)}</h2>
                <p>Not yet accepted</p>
              </article>

              <article className="stat-card">
                <div className="stat-icon orange">
                  <Clock3 size={20} />
                </div>
                <span className="stat-label">Follow-ups Due</span>
                <h2>{actionDueCount}</h2>
                <p>Quotes needing attention</p>
              </article>

              <article className="stat-card">
                <div className="stat-icon green">
                  <CheckCircle2 size={20} />
                </div>
                <span className="stat-label">Accepted Quotes</span>
                <h2>{stats.accepted}</h2>
                <p>Marked as accepted</p>
              </article>
            </section>
          </>
        )}
        {(activePage === "overview" || activePage === "followups") && (
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
                      onClick={() => openQuote(quote.id)}
                    >
                      View Quote
                      <ArrowUpRight size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {(activePage === "overview" || activePage === "quotes") && (
          <section className="quotes-section" id="quotes">
            <div className="section-top">
              <div>
                <h2>Rental Quotes</h2>
                <p>Manage outstanding quotes and customer follow-ups.</p>
              </div>

              <button className="reset-button" onClick={resetDemo}>
                <RefreshCw size={16} />
                Reset Demo
              </button>
            </div>

            <div className="table-toolbar">
              <div className="search-box">
                <Search size={18} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search quotes or customers..."
                  aria-label="Search quotes"
                />
              </div>

              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="Filter quotes"
              >
                <option value="All">All Statuses</option>
                <option value="Pending">Pending</option>
                <option value="Follow-up Due">Follow-up Due</option>
                <option value="Follow-up Scheduled">Follow-up Scheduled</option>
                <option value="Accepted">Accepted</option>
              </select>
            </div>

            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>QUOTE</th>
                    <th>CUSTOMER</th>
                    <th>EQUIPMENT</th>
                    <th>VALUE</th>
                    <th>STATUS</th>
                    <th>ACTION</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredQuotes.map((quote) => (
                    <tr key={quote.id}>
                      <td>
                        <strong>{quote.id}</strong>
                        <small>{quote.date}</small>
                      </td>
                      <td>{quote.customer}</td>
                      <td>{quote.equipment}</td>
                      <td className="amount">{money(quote.amount)}</td>
                      <td>
                        <span
                          className={`status status-${quote.status
                            .toLowerCase()
                            .replaceAll(" ", "-")}`}
                        >
                          {quote.status}
                        </span>
                      </td>

                      <td>
                        <div className="quote-actions">
                          <button
                            className="action-button"
                            onClick={() => openQuote(quote.id)}
                          >
                            <Eye size={14} />
                            Details
                          </button>

                          {quote.status !== "Accepted" && (
                            <button
                              className="accept-button"
                              onClick={() => updateStatus(quote.id, "Accepted")}
                            >
                              Accept
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}

                  {filteredQuotes.length === 0 && (
                    <tr>
                      <td colSpan="6" className="empty-state">
                        No quotes match your search.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="table-footer">
              Showing {filteredQuotes.length} of {quotes.length} quotes
            </div>
          </section>
        )}

        <footer className="footer">
          RENTFLOW — Interactive prototype · Fictional demonstration data
        </footer>
      </main>

      {notification && (
        <div className="toast" role="status">
          <span>{notification}</span>
          <button
            onClick={() => setNotification("")}
            aria-label="Dismiss notification"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {showForm && (
        <div
          className="modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowForm(false);
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
                onClick={() => setShowForm(false)}
                aria-label="Close form"
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={addQuote} autoComplete="off">
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
      )}

      {selectedQuote && (
        <div
          className="detail-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeQuote();
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
                onClick={closeQuote}
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

                  <form className="followup-form" onSubmit={scheduleFollowUp}>
                    <label htmlFor="followup-date">
                      Follow-up date and time
                    </label>

                    <input
                      id="followup-date"
                      type="datetime-local"
                      required
                      value={followUpDate}
                      onChange={(event) => setFollowUpDate(event.target.value)}
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
              <div className="detail-section-title">
                <History size={19} />
                <h3>Activity History</h3>
              </div>
              <div className="detail-section">
                <FollowUpPreview
                  key={selectedQuote.id}
                  quote={selectedQuote}
                  scheduledAt={selectedFollowUp}
                  attemptsRemaining={
                    MAX_FOLLOWUPS -
                    getFollowUpCount(activityLog[selectedQuote.id] ?? [])
                  }
                  onSimulate={simulateFollowUp}
                />
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
      )}
    </div>
  );
}

export default App;

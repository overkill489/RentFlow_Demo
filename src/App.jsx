import { useEffect, useState } from "react";
import { LogOut } from "lucide-react";

import Sidebar from "./components/Sidebar";
import Header from "./components/Header";
import Toast from "./components/Toast";
import QuoteDetails from "./components/QuoteDetails";
import NewQuoteModal from "./components/NewQuoteModal";

import Overview from "./pages/Overview";
import RentalQuotes from "./pages/RentalQuotes";
import FollowUps from "./pages/FollowUps";
import AcceptedQuotes from "./pages/AcceptedQuotes";
import LoginScreen from "./pages/LoginScreen";

import useRentFlow from "./hooks/useRentFlow";
import { rentflowApi } from "./services/rentflowApi";

import "./App.css";

export default function App() {
  const [activePage, setActivePage] = useState("overview");
  const [currentUser, setCurrentUser] = useState(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [authError, setAuthError] = useState("");

  const flow = useRentFlow(currentUser?.companyId);

  useEffect(() => {
    const unsubscribe = rentflowApi.onSessionExpired(() => {
      setCurrentUser(null);
      setActivePage("overview");
      setAuthError("");
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [activePage]);

  const navigate = (page) => {
    if (page === "quotes") {
      flow.setFilter("All");
    }

    setActivePage(page);
    window.scrollTo(0, 0);
  };

  const reset = async () => {
    await flow.resetDemo();
  };

  const handleAuthenticated = (user) => {
    setCurrentUser(user);
    setAuthError("");
    setActivePage("overview");
  };

  const handleLogout = async () => {
    if (loggingOut) return;

    setLoggingOut(true);
    setAuthError("");

    try {
      await rentflowApi.logout();
    } catch (error) {
      setAuthError(error.message);
    } finally {
      flow.closeQuote();
      flow.setShowForm(false);
      setCurrentUser(null);
      setActivePage("overview");
      setLoggingOut(false);
    }
  };

  if (!currentUser) {
    return <LoginScreen onAuthenticated={handleAuthenticated} />;
  }

  if (!flow.ready) {
    return (
      <div className="rf-loading-page">
        <div className="rf-loading-card">
          <div className="rf-loading-logo">RENTFLOW</div>

          {flow.error ? (
            <>
              <h2>Connection failed</h2>

              <p>{flow.error}</p>

              <button
                type="button"
                className="rf-loading-primary"
                onClick={() => {
                  flow.refresh().catch((error) => {
                    flow.setNotification(error.message);
                  });
                }}
              >
                Try Again
              </button>

              <button
                type="button"
                className="rf-loading-secondary"
                onClick={handleLogout}
                disabled={loggingOut}
              >
                {loggingOut ? "Logging out..." : "Log Out"}
              </button>
            </>
          ) : (
            <>
              <div className="rf-loading-spinner" />

              <h2>Loading your workspace</h2>

              <p>
                Retrieving rental quotes and follow-ups for{" "}
                {currentUser.companyName}.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        activePage={activePage}
        onNavigate={navigate}
        actionDueCount={flow.actionDueCount}
        acceptedCount={flow.stats.accepted}
      />

      <main className="main-content">
        <Header
          activePage={activePage}
          onNewQuote={() => flow.setShowForm(true)}
        />

        <section className="rf-session-bar">
          <div className="rf-session-info">
            <span className="rf-session-label">SIGNED IN</span>

            <strong>{currentUser.companyName}</strong>

            <span className="rf-session-email">{currentUser.email}</span>
          </div>

          <button
            type="button"
            className="rf-session-logout"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            <LogOut size={16} />
            {loggingOut ? "Logging out..." : "Log Out"}
          </button>
        </section>

        {authError && (
          <p className="rf-session-error" role="alert">
            {authError}
          </p>
        )}

        <div className="rf-data-notice">
          CONNECTED WORKSPACE — Quotes and follow-ups are saved to your
          company's database. Email delivery is not enabled.
        </div>

        {flow.error && (
          <p className="rf-session-error" role="alert">
            {flow.error}
          </p>
        )}

        {activePage === "overview" && (
          <Overview
            flow={flow}
            onOpenQuote={flow.openQuote}
            onResetDemo={reset}
          />
        )}

        {activePage === "quotes" && (
          <RentalQuotes
            flow={flow}
            onOpenQuote={flow.openQuote}
            onResetDemo={reset}
          />
        )}

        {activePage === "followups" && (
          <FollowUps flow={flow} onOpenQuote={flow.openQuote} />
        )}

        {activePage === "accepted" && (
          <AcceptedQuotes quotes={flow.quotes} onOpenQuote={flow.openQuote} />
        )}

        <footer className="footer">
          RENTFLOW — Local development · Demo data until database integration is
          complete
        </footer>
      </main>

      {flow.notification && (
        <Toast
          notification={flow.notification}
          onDismiss={() => flow.setNotification("")}
        />
      )}

      {flow.showForm && (
        <NewQuoteModal
          form={flow.form}
          setForm={flow.setForm}
          onClose={() => flow.setShowForm(false)}
          onAddQuote={flow.addQuote}
        />
      )}

      {flow.selectedQuote && (
        <QuoteDetails
          selectedQuote={flow.selectedQuote}
          selectedFollowUp={flow.selectedFollowUp}
          selectedActivity={flow.selectedActivity}
          followUpDate={flow.followUpDate}
          onSetFollowUpDate={flow.setFollowUpDate}
          onScheduleFollowUp={flow.scheduleFollowUp}
          onSimulateFollowUp={flow.simulateFollowUp}
          onClose={flow.closeQuote}
        />
      )}
    </div>
  );
}

import {
  Truck,
  LayoutDashboard,
  FileText,
  Clock3,
  CheckCircle2,
  Menu,
  X,
} from "lucide-react";

import { useState, useEffect } from "react";

export default function Sidebar({
  activePage,
  onNavigate,
  actionDueCount,
  acceptedCount,
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [activePage]);

  useEffect(() => {
    if (!mobileMenuOpen) return;

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
      }
    };

    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [mobileMenuOpen]);

  const navigate = (page) => {
    onNavigate(page);
    setMobileMenuOpen(false);
  };

  return (
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

      <button
        type="button"
        className="mobile-menu-toggle"
        aria-label={mobileMenuOpen ? "Close navigation" : "Open navigation"}
        aria-expanded={mobileMenuOpen}
        aria-controls="rentflow-navigation"
        onClick={() => setMobileMenuOpen((open) => !open)}
      >
        {mobileMenuOpen ? <X size={23} /> : <Menu size={23} />}
      </button>

      <p className="sidebar-heading">WORKSPACE</p>

      <nav
        id="rentflow-navigation"
        className={`navigation ${mobileMenuOpen ? "mobile-open" : ""}`}
        aria-label="Main navigation"
      >
        <button
          type="button"
          className={`nav-item ${activePage === "overview" ? "active" : ""}`}
          onClick={() => navigate("overview")}
        >
          <LayoutDashboard size={18} />
          <span>Overview</span>
        </button>

        <button
          type="button"
          className={`nav-item ${activePage === "quotes" ? "active" : ""}`}
          onClick={() => navigate("quotes")}
        >
          <FileText size={18} />
          <span>Rental Quotes</span>
        </button>

        <button
          type="button"
          className={`nav-item ${activePage === "followups" ? "active" : ""}`}
          onClick={() => navigate("followups")}
        >
          <Clock3 size={18} />
          <span>Follow-ups</span>
          <span className="nav-count">{actionDueCount}</span>
        </button>

        <button
          type="button"
          className={`nav-item ${activePage === "accepted" ? "active" : ""}`}
          onClick={() => navigate("accepted")}
        >
          <CheckCircle2 size={18} />
          <span>Accepted Quotes</span>
          <span className="nav-count">{acceptedCount}</span>
        </button>
      </nav>

      <div className="sidebar-bottom">
        <div className="demo-indicator">
          <span className="live-dot" />
          CONNECTED WORKSPACE
        </div>

        <p>Company data secured. Email delivery not enabled.</p>
      </div>
    </aside>
  );
}

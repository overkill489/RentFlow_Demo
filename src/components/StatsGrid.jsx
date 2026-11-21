import { FileText, ArrowUpRight, Clock3, CheckCircle2 } from "lucide-react";

import { money } from "../utils/formatters";

export default function StatsGrid({ stats, actionDueCount }) {
  return (
    <section className="stats-grid" aria-label="Quote statistics">
      <article className="stat-card">
        <div className="stat-icon blue">
          <FileText size={20} />
        </div>

        <span className="stat-label">Total Quotes</span>
        <h2>{stats.total}</h2>
        <p>Quotes saved to your workspace</p>
      </article>

      <article className="stat-card">
        <div className="stat-icon purple">
          <ArrowUpRight size={20} />
        </div>

        <span className="stat-label">Outstanding Value</span>
        <h2>{money(stats.outstanding)}</h2>
        <p>Value of quotes not yet accepted</p>
      </article>

      <article className="stat-card">
        <div className="stat-icon orange">
          <Clock3 size={20} />
        </div>

        <span className="stat-label">Follow-ups Due</span>
        <h2>{actionDueCount}</h2>
        <p>Quotes requiring attention</p>
      </article>

      <article className="stat-card">
        <div className="stat-icon green">
          <CheckCircle2 size={20} />
        </div>

        <span className="stat-label">Accepted Quotes</span>
        <h2>{stats.accepted}</h2>
        <p>Quotes marked as accepted</p>
      </article>
    </section>
  );
}

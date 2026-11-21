import { Plus } from "lucide-react";

export default function Header({ activePage, onNewQuote }) {
  const pageContent = {
    overview: {
      title: "Overview",
      subtitle: "Track your quotes, follow-ups, and rental opportunities.",
    },
    quotes: {
      title: "Rental Quotes",
      subtitle: "Manage rental quotes and customer requests.",
    },
    followups: {
      title: "Follow-ups",
      subtitle: "Review upcoming and overdue customer follow-ups.",
    },
    accepted: {
      title: "Accepted Quotes",
      subtitle: "Review accepted quotes and their total value.",
    },
  };

  const currentPage = pageContent[activePage] ?? pageContent.overview;

  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">RENTAL OPERATIONS</p>

        <h1>{currentPage.title}</h1>

        <p className="subtitle">{currentPage.subtitle}</p>
      </div>

      <button type="button" className="primary-button" onClick={onNewQuote}>
        <Plus size={18} />
        New Quote
      </button>
    </header>
  );
}

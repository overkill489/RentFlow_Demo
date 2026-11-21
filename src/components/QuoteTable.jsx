
import { useEffect, useState } from "react";
import { RefreshCw, Search, Eye, ChevronDown } from "lucide-react";
import { money } from "../utils/formatters";

const MOBILE_PAGE_SIZE = 3;

export default function QuoteTable({
  filteredQuotes,
  quotes,
  search,
  setSearch,
  filter,
  setFilter,
  onResetDemo,
  onOpenQuote,
  onUpdateStatus,
}) {
  const [visibleMobileCount, setVisibleMobileCount] = useState(
    MOBILE_PAGE_SIZE
  );

  useEffect(() => {
    setVisibleMobileCount(MOBILE_PAGE_SIZE);
  }, [search, filter]);

  const visibleCount = Math.min(
    visibleMobileCount,
    filteredQuotes.length
  );

  const remainingQuotes = Math.max(
    filteredQuotes.length - visibleCount,
    0
  );

  const nextBatch = Math.min(
    MOBILE_PAGE_SIZE,
    remainingQuotes
  );

  const hasMoreMobileQuotes = remainingQuotes > 0;

  const handleReset = () => {
    setVisibleMobileCount(MOBILE_PAGE_SIZE);
    onResetDemo();
  };

  const handleViewMore = () => {
    setVisibleMobileCount((count) =>
      Math.min(
        count + MOBILE_PAGE_SIZE,
        filteredQuotes.length
      )
    );
  };

  return (
    <section className="quotes-section" id="quotes">
      <div className="section-top">
        <div>
          <h2>Rental Quotes</h2>
          <p>
            Manage outstanding quotes and customer follow-ups.
          </p>
        </div>

        <button
          type="button"
          className="reset-button"
          onClick={handleReset}
        >
          <RefreshCw size={16} />
          Reset Data
        </button>
      </div>

      <div className="table-toolbar">
        <div className="search-box">
          <Search size={18} />

          <input
            value={search}
            onChange={(event) =>
              setSearch(event.target.value)
            }
            placeholder="Search quotes or customers..."
            aria-label="Search quotes"
          />
        </div>

        <select
          value={filter}
          onChange={(event) =>
            setFilter(event.target.value)
          }
          aria-label="Filter quotes"
        >
          <option value="All">All Statuses</option>
          <option value="Pending">Pending</option>
          <option value="Follow-up Due">
            Follow-up Due
          </option>
          <option value="Follow-up Scheduled">
            Follow-up Scheduled
          </option>
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
            {filteredQuotes.map((quote, index) => (
              <tr
                key={quote.id}
                className={
                  index >= visibleMobileCount
                    ? "mobile-quote-hidden"
                    : ""
                }
              >
                <td>
                  <strong>{quote.id}</strong>
                  <small>{quote.date}</small>
                </td>

                <td>{quote.customer}</td>

                <td>{quote.equipment}</td>

                <td className="amount">
                  {money(quote.amount)}
                </td>

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
                      type="button"
                      className="action-button"
                      onClick={() =>
                        onOpenQuote(quote.id)
                      }
                    >
                      <Eye size={14} />
                      Details
                    </button>

                    {quote.status !== "Accepted" && (
                      <button
                        type="button"
                        className="accept-button"
                        onClick={() =>
                          onUpdateStatus(
                            quote.id,
                            "Accepted"
                          )
                        }
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
                <td
                  colSpan="6"
                  className="empty-state"
                >
                  No quotes match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {hasMoreMobileQuotes && (
        <div className="mobile-view-more">
          <button
            type="button"
            className="view-more-button"
            onClick={handleViewMore}
          >
            View {nextBatch} More{" "}
            {nextBatch === 1 ? "Quote" : "Quotes"}
            <ChevronDown size={17} />
          </button>
        </div>
      )}

      <div className="table-footer">
        <span className="desktop-quote-count">
          Showing {filteredQuotes.length} of{" "}
          {quotes.length} quotes
        </span>

        <span className="mobile-quote-count">
          Showing {visibleCount} of{" "}
          {filteredQuotes.length} matching quotes
        </span>
      </div>
    </section>
  );
}

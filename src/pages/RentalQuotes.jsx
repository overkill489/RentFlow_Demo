import QuoteTable from "../components/QuoteTable";
export default function RentalQuotes({ flow, onOpenQuote, onResetDemo }) {
  return <QuoteTable filteredQuotes={flow.filteredQuotes} quotes={flow.quotes} search={flow.search} setSearch={flow.setSearch} filter={flow.filter} setFilter={flow.setFilter} onResetDemo={onResetDemo} onOpenQuote={onOpenQuote} onUpdateStatus={flow.updateStatus} />;
}

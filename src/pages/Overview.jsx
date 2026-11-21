import StatsGrid from "../components/StatsGrid";
import FollowUpQueue from "../components/FollowUpQueue";
import QuoteTable from "../components/QuoteTable";

export default function Overview({ flow, onOpenQuote, onResetDemo }) {
  return (
    <>
      <StatsGrid stats={flow.stats} actionDueCount={flow.actionDueCount} />
      <FollowUpQueue
        followUpQueue={flow.followUpQueue}
        overdueCount={flow.overdueCount}
        onOpenQuote={onOpenQuote}
      />
      <QuoteTable
        filteredQuotes={flow.filteredQuotes}
        quotes={flow.quotes}
        search={flow.search}
        setSearch={flow.setSearch}
        filter={flow.filter}
        setFilter={flow.setFilter}
        onResetDemo={onResetDemo}
        onOpenQuote={onOpenQuote}
        onUpdateStatus={flow.updateStatus}
      />
    </>
  );
}

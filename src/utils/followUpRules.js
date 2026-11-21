export const MAX_FOLLOWUPS = 2;

// Business hours: Monday-Friday, 9 AM to 5 PM
export function isBusinessHours(date) {
  const day = date.getDay();
  const hour = date.getHours();

  return day >= 1 && day <= 5 && hour >= 9 && hour < 17;
}

// Count completed simulated follow-ups.
export function getFollowUpCount(events = []) {
  return events.filter(
    (event) =>
      event.type === "simulation" ||
      event.description?.startsWith("Follow-up simulated successfully"),
  ).length;
}

// Validate a follow-up before scheduling.
export function validateFollowUp({ quote, scheduledDate, activity = [] }) {
  if (!quote) {
    return "No quote selected.";
  }

  if (quote.status === "Accepted") {
    return "Accepted quotes cannot receive follow-ups.";
  }

  if (getFollowUpCount(activity) >= MAX_FOLLOWUPS) {
    return "The maximum number of follow-ups has been reached.";
  }

  if (!scheduledDate) {
    return "Please select a follow-up date.";
  }

  const date = new Date(scheduledDate);

  if (Number.isNaN(date.getTime())) {
    return "Please select a valid date and time.";
  }

  if (date.getTime() <= Date.now()) {
    return "Follow-ups must be scheduled in the future.";
  }

  if (!isBusinessHours(date)) {
    return "Schedule follow-ups Monday-Friday, 9 AM to 5 PM.";
  }

  return null;
}

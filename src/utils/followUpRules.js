export const MAX_FOLLOWUPS = 2;

// Monday through Friday, 9 AM to 5 PM.
// Uses the browser's local timezone.
export function isBusinessHours(date) {
  const day = date.getDay();
  const hour = date.getHours();

  const isWeekday = day >= 1 && day <= 5;
  const isWorkingHour = hour >= 9 && hour < 17;

  return isWeekday && isWorkingHour;
}

export function getFollowUpCount(events = []) {
  return events.filter(
    (event) =>
      event.type === "simulation" ||
      event.description?.startsWith("Follow-up simulated successfully"),
  ).length;
}

export function validateFollowUp({ quote, scheduledDate, activity = [] }) {
  if (!quote) {
    return "No quote selected.";
  }

  if (quote.status === "Accepted") {
    return "Accepted quotes cannot receive follow-ups.";
  }

  if (getFollowUpCount(activity) >= MAX_FOLLOWUPS) {
    return "The two-follow-up demonstration limit has been reached.";
  }

  const date = new Date(scheduledDate);

  if (Number.isNaN(date.getTime())) {
    return "Please select a valid date and time.";
  }

  if (date.getTime() <= Date.now()) {
    return "Follow-ups must be scheduled in the future.";
  }

  if (!isBusinessHours(date)) {
    return "Choose Monday–Friday between 9 AM and 5 PM.";
  }

  return null;
}

import { createUnsubscribeToken } from "./unsubscribeService.js";
import { getSenderIdentity } from "./senderIdentity.js";

export function createFollowUpEmailTemplate(
  db,
  {
    companyId,
    quoteId,
    customer,
    equipment,
    currentTime = new Date().toISOString(),
    baseUrl = process.env.RENTFLOW_UNSUBSCRIBE_BASE_URL ||
      "http://localhost:5000",
  },
) {
  if (
    !companyId ||
    !quoteId ||
    typeof customer !== "string" ||
    typeof equipment !== "string"
  ) {
    throw new Error("Invalid follow-up template data");
  }

  const origin = new URL(baseUrl);

  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    !["http:", "https:"].includes(origin.protocol)
  ) {
    throw new Error("Invalid unsubscribe base URL");
  }

  if (
    origin.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(origin.hostname)
  ) {
    throw new Error("Public unsubscribe URLs require HTTPS");
  }

  const sender = getSenderIdentity(db, companyId);

  const unsubscribe = createUnsubscribeToken(db, {
    companyId,
    quoteId,
    currentTime,
  });

  if (!unsubscribe) {
    throw new Error("Quote contact not found");
  }

  const unsubscribeUrl = new URL(
    `/api/unsubscribe/${unsubscribe.token}`,
    origin,
  ).toString();

  const subject = `Following up on your rental quote ${quoteId}`;

  const body = [
    `Hello ${customer},`,
    "",
    `I'm following up regarding your rental quote ${quoteId} for ${equipment}.`,
    "",
    "Please let us know if you have any questions or would like to discuss the rental.",
    "",
    "Thank you,",
    sender.displayName,
    ...(sender.replyToEmail
      ? ["", `Questions? Contact: ${sender.replyToEmail}`]
      : []),
    "",
    "---",
    "Unsubscribe from rental quote follow-up emails:",
    unsubscribeUrl,
  ].join("\n");

  return {
    subject,
    body,
    unsubscribeUrl,
    expiresAt: unsubscribe.expiresAt,
    senderDisplayName: sender.displayName,
    replyToEmail: sender.replyToEmail,
    senderConfigured: sender.configured,
    deliveryEnabled: false,
  };
}

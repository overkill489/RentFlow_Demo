import express from "express";
import cors from "cors";
import "dotenv/config";
import quoteRoutes from "./routes/quotes.js";
import followUpRoutes from "./routes/followups.js";
import authRoutes from "./routes/auth.js";
import { db } from "./database/db.js";
import { requireAuth } from "./middleware/requireAuth.js";
import { startFollowUpScheduler } from "./jobs/startFollowUpScheduler.js";
import deliveryRoutes from "./routes/delivery.js";
import deliveryReadinessRoutes from "./routes/deliveryReadiness.js";
import deliveryQueueRoutes from "./routes/deliveryQueue.js";
import { recoverDeliveryQueue } from "./services/deliveryQueueRecovery.js";
import { startDeliveryQueueScheduler } from "./jobs/startDeliveryQueueScheduler.js";
import unsubscribeRoutes from "./routes/unsubscribe.js";
import senderIdentityRoutes from "./routes/senderIdentity.js";
import senderVerificationRoutes from "./routes/senderVerification.js";
import providerReadinessRoutes from "./routes/providerReadiness.js";
import deliveryPreflightRoutes from "./routes/deliveryPreflight.js";
import deliveryPreflightAuditRoutes from "./routes/deliveryPreflightAudit.js";

const app = express();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 64) {
  throw new Error("JWT_SECRET must contain a strong random secret");
}

const PORT = process.env.PORT || 5000;

app.use(express.json({ limit: "20kb" }));

app.use(
  cors({
    origin: "http://localhost:5173",
  }),
);

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    application: "RentFlow API",
    status: "running",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/quotes", requireAuth, quoteRoutes);
app.use("/api/followups", requireAuth, followUpRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/delivery", requireAuth, deliveryRoutes);
app.use("/api/sender-identity", requireAuth, senderIdentityRoutes);
app.use("/api/sender-verification", requireAuth, senderVerificationRoutes);
app.use("/api/provider-readiness", requireAuth, providerReadinessRoutes);
app.use("/api/delivery-preflight", requireAuth, deliveryPreflightRoutes);
app.use("/api/delivery-preflight-audit", requireAuth, deliveryPreflightAuditRoutes);
app.use("/api/delivery-readiness", requireAuth, deliveryReadinessRoutes);
app.use("/api/delivery-queue", requireAuth, deliveryQueueRoutes);
app.use("/api/unsubscribe", unsubscribeRoutes);

app.use((error, req, res, next) => {
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      error: "Invalid JSON request body",
    });
  }

  console.error(error);

  res.status(500).json({
    success: false,
    error: "Internal server error",
  });
});

const recovery = recoverDeliveryQueue(db);

console.log(
  `[RentFlow Recovery] Scanned ${recovery.scanned}, cancelled ${recovery.cancelled}, healthy ${recovery.healthy}.`,
);

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`RentFlow API running on http://localhost:${PORT}`);
});

const stopFollowUpScheduler = startFollowUpScheduler();

const deliveryQueueScheduler = startDeliveryQueueScheduler();

server.on("close", () => {
  stopFollowUpScheduler();
  deliveryQueueScheduler.stop();
});

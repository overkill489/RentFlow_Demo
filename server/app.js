import express from "express";
import cors from "cors";
import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "./database/db.js";
import { createOperations, errorKind } from "./operations.js";
import followUpRoutes from "./routes/followups.js";
import quoteRoutes from "./routes/quotes.js";
import authRoutes from "./routes/auth.js";
import { requireAuth } from "./middleware/requireAuth.js";
import deliveryRoutes from "./routes/delivery.js";
import deliveryReadinessRoutes from "./routes/deliveryReadiness.js";
import deliveryQueueRoutes from "./routes/deliveryQueue.js";
import unsubscribeRoutes from "./routes/unsubscribe.js";
import senderIdentityRoutes from "./routes/senderIdentity.js";
import senderVerificationRoutes from "./routes/senderVerification.js";
import providerReadinessRoutes from "./routes/providerReadiness.js";
import deliveryPreflightRoutes from "./routes/deliveryPreflight.js";
import deliveryPreflightAuditRoutes from "./routes/deliveryPreflightAudit.js";

export function createApp({
  trustLoopbackProxy = false,
  metricsToken = "",
  operations = createOperations({ probe: () => db.prepare("SELECT 1 FROM companies LIMIT 1").get() }),
} = {}) {
  const app = express();
  app.locals.operations = operations;

  if (trustLoopbackProxy) {
    app.set("trust proxy", (address, hop) =>
      hop === 0 && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address));
  }

  app.use(
    cors({
      origin: "http://localhost:5173",
    }),
  );

  app.get(["/api/health", "/api/health/live"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(200).json({
      success: true,
      application: "RentFlow API",
      status: "running",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/health/ready", (req, res) => {
    const ready = operations.ready();
    res.set("Cache-Control", "no-store");
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready" });
  });

  const digest = (value) => createHash("sha256").update(value).digest();
  const expectedToken = metricsToken ? digest(metricsToken) : null;
  app.get("/api/metrics", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!expectedToken) return res.sendStatus(404);
    const authorization = req.get("Authorization") ?? "";
    if (!authorization.startsWith("Bearer ") ||
        !timingSafeEqual(expectedToken, digest(authorization.slice(7)))) {
      return res.sendStatus(401);
    }
    res.json(operations.snapshot());
  });

  app.use((req, res, next) => {
    operations.observeResponse(res);
    next();
  });
  app.use(express.json({ limit: "20kb" }));

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

  // Express identifies error middleware by its four arguments.
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    const kind = errorKind(error);
    operations.requestError(kind);
    if (res.headersSent) return res.destroy();

    if (kind === "invalid_json") {
      return res.status(400).json({
        success: false,
        error: "Invalid JSON request body",
      });
    }

    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  });

  return app;
}

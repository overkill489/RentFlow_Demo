import express from "express";
import { db } from "../database/db.js";
import {
  recordDeliveryPreflight,
  getDeliveryPreflightHistory,
} from "../services/deliveryPreflightAudit.js";

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");

  if (req.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      error: "Administrator access required",
    });
  }

  next();
});

function getActorId(req) {
  return req.user.id ?? req.user.userId ?? req.user.sub ?? null;
}

router.post("/:id/check", (req, res, next) => {
  try {
    const data = recordDeliveryPreflight(db, {
      companyId: req.user.companyId,
      queueId: req.params.id,
      actorId: getActorId(req),
      providerConfig: {
        provider: process.env.RENTFLOW_EMAIL_PROVIDER,
        fromEmail: process.env.RENTFLOW_FROM_EMAIL,
      },
    });

    if (!data) {
      return res.status(404).json({
        success: false,
        error: "Queue entry not found",
      });
    }

    res.status(201).json({
      success: true,
      message: "Preflight audit recorded. No email sent.",
      data,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/history", (req, res, next) => {
  try {
    const data = getDeliveryPreflightHistory(db, {
      companyId: req.user.companyId,
      queueId: req.params.id,
    });

    if (!data) {
      return res.status(404).json({
        success: false,
        error: "Queue entry not found",
      });
    }

    res.json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    next(error);
  }
});

export default router;

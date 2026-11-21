import express from "express";
import { db } from "../database/db.js";
import { getDeliveryPreflight } from "../services/deliveryPreflight.js";

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get("/:id", (req, res, next) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        error: "Administrator access required",
      });
    }

    const result = getDeliveryPreflight(db, {
      companyId: req.user.companyId,
      queueId: req.params.id,
      providerConfig: {
        provider: process.env.RENTFLOW_EMAIL_PROVIDER,
        fromEmail: process.env.RENTFLOW_FROM_EMAIL,
      },
    });

    if (!result) {
      return res.status(404).json({
        success: false,
        error: "Queue entry not found",
      });
    }

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

export default router;

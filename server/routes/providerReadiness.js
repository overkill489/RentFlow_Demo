import express from "express";
import { db } from "../database/db.js";
import { getProviderReadiness } from "../services/providerReadiness.js";

const router = express.Router();

router.get("/", (req, res, next) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        error: "Administrator access required",
      });
    }

    const result = getProviderReadiness(db, req.user.companyId, {
      provider: process.env.RENTFLOW_EMAIL_PROVIDER,
      fromEmail: process.env.RENTFLOW_FROM_EMAIL,
    });

    if (!result) {
      return res.status(404).json({
        success: false,
        error: "Company not found",
      });
    }

    res.set("Cache-Control", "no-store");

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

export default router;

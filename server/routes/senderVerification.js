import express from "express";
import { db } from "../database/db.js";
import {
  getSenderDomainReadiness,
  prepareSenderDomainVerification,
} from "../services/senderVerification.js";
import { checkSenderDnsVerification } from "../services/senderDnsCheck.js";

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get("/", (req, res, next) => {
  try {
    const result = getSenderDomainReadiness(db, req.user.companyId);

    if (!result) {
      return res.status(404).json({
        success: false,
        error: "Company not found",
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

router.post("/prepare", (req, res, next) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        error: "Administrator access required",
      });
    }

    const result = prepareSenderDomainVerification(db, req.user.companyId);

    if (!result.success) {
      return res.status(result.statusCode).json({
        success: false,
        error: result.error,
      });
    }

    res.status(result.statusCode).json({
      success: true,
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/check", async (req, res, next) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        error: "Administrator access required",
      });
    }

    const result = await checkSenderDnsVerification(db, {
      companyId: req.user.companyId,
    });

    if (!result.success) {
      return res.status(result.statusCode).json({
        success: false,
        error: result.error,
      });
    }

    res.status(result.statusCode).json({
      success: true,
      message: result.message,
      dnsMatched: result.dnsMatched,
      checkResult: result.checkResult,
      data: result.data,
      emailsSent: result.emailsSent,
    });
  } catch (error) {
    next(error);
  }
});

export default router;

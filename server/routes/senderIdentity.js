import express from "express";
import { db } from "../database/db.js";
import {
  getSenderIdentity,
  saveSenderIdentity,
} from "../services/senderIdentity.js";

const router = express.Router();

router.get("/", (req, res, next) => {
  try {
    const data = getSenderIdentity(db, req.user.companyId);

    res.set("Cache-Control", "no-store");

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
});

router.put("/", (req, res, next) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        error: "Administrator access required",
      });
    }

    const result = saveSenderIdentity(db, req.user.companyId, req.body);

    if (!result.success) {
      return res.status(result.statusCode).json({
        success: false,
        error: result.error,
      });
    }

    res.set("Cache-Control", "no-store");

    res.json({
      success: true,
      message: "Company sender settings saved",
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
});

export default router;

import express from "express";
import { db } from "../database/db.js";
import { getDeliveryReadiness } from "../services/deliveryReadiness.js";

const router = express.Router();

router.get("/quotes/:id/readiness", (req, res, next) => {
  try {
    const result = getDeliveryReadiness(db, req.user.companyId, req.params.id);

    if (!result) {
      return res.status(404).json({
        success: false,
        error: "Quote not found",
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

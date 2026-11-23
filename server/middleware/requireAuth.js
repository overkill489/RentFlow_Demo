import jwt from "jsonwebtoken";
import process from "node:process";
import { db } from "../database/db.js";

const findUser = db.prepare(`
  SELECT
    u.id,
    u.company_id AS companyId,
    u.email,
    u.role,
    c.name AS companyName
  FROM users u
  JOIN companies c ON c.id = u.company_id
  WHERE u.id = ?
`);

const findRevokedToken = db.prepare(`
  SELECT jti
  FROM revoked_tokens
  WHERE jti = ?
`);

export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? "";

  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: "Authentication required",
    });
  }

  const token = header.slice(7).trim();
  let payload;

  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "rentflow-api",
      audience: "rentflow-app",
    });

    if (
      typeof payload.sub !== "string" ||
      typeof payload.companyId !== "string" ||
      typeof payload.jti !== "string" ||
      !Number.isInteger(payload.exp)
    ) {
      throw new Error("Invalid token");
    }
  } catch {
    return res.status(401).json({
      success: false,
      error: "Invalid or expired token",
    });
  }

  try {
    if (findRevokedToken.get(payload.jti)) {
      return res.status(401).json({
        success: false,
        error: "Session has been revoked",
      });
    }

    const user = findUser.get(payload.sub);

    if (!user || user.companyId !== payload.companyId) {
      return res.status(401).json({
        success: false,
        error: "Account no longer available",
      });
    }

    req.user = user;

    req.authToken = {
      jti: payload.jti,
      expiresAt: payload.exp,
    };

  } catch (error) {
    return next(error);
  }

  next();
}

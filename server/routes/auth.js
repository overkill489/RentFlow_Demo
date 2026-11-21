import express from "express";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { db } from "../database/db.js";
import { hashPassword, verifyPassword } from "../utils/passwords.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { loginLimiter, registrationLimiter } from "../middleware/rateLimits.js";

const router = express.Router();

const findEmail = db.prepare(`
  SELECT id
  FROM users
  WHERE email = ?
`);

const findLogin = db.prepare(`
  SELECT
    u.id,
    u.company_id AS companyId,
    u.email,
    u.password_hash AS passwordHash,
    u.role,
    c.name AS companyName
  FROM users u
  JOIN companies c ON c.id = u.company_id
  WHERE u.email = ?
`);

const insertCompany = db.prepare(`
  INSERT INTO companies (
    id, name, created_at
  )
  VALUES (?, ?, ?)
`);

const insertUser = db.prepare(`
  INSERT INTO users (
    id, company_id, email,
    password_hash, role, created_at
  )
  VALUES (?, ?, ?, ?, ?, ?)
`);

function createToken(user) {
  return jwt.sign(
    {
      companyId: user.companyId,
    },
    process.env.JWT_SECRET,
    {
      jwtid: randomUUID(),
      subject: user.id,
      expiresIn: "1hr",
      algorithm: "HS256",
      issuer: "rentflow-api",
      audience: "rentflow-app",
    },
  );
}

function publicUser(user) {
  return {
    id: user.id,
    companyId: user.companyId,
    companyName: user.companyName,
    email: user.email,
    role: user.role,
  };
}

router.post("/register", registrationLimiter, async (req, res, next) => {
  try {
    const { companyName, email, password } = req.body ?? {};

    if (
      typeof companyName !== "string" ||
      !companyName.trim() ||
      companyName.trim().length > 120 ||
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
      email.trim().length > 254 ||
      typeof password !== "string" ||
      password.length < 12 ||
      password.length > 128
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Provide a company name, valid email, and password of 12-128 characters",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (findEmail.get(normalizedEmail)) {
      return res.status(409).json({
        success: false,
        error: "Account already exists",
      });
    }

    const companyId = randomUUID();
    const userId = randomUUID();
    const createdAt = new Date().toISOString();
    const passwordHash = await hashPassword(password);

    db.exec("BEGIN IMMEDIATE");

    try {
      insertCompany.run(companyId, companyName.trim(), createdAt);

      insertUser.run(
        userId,
        companyId,
        normalizedEmail,
        passwordHash,
        "admin",
        createdAt,
      );

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");

      if (String(error.message).includes("UNIQUE constraint")) {
        return res.status(409).json({
          success: false,
          error: "Account already exists",
        });
      }

      throw error;
    }

    const user = {
      id: userId,
      companyId,
      companyName: companyName.trim(),
      email: normalizedEmail,
      role: "admin",
    };

    res.status(201).json({
      success: true,
      token: createToken(user),
      user: publicUser(user),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      email.length > 254 ||
      password.length > 128
    ) {
      return res.status(400).json({
        success: false,
        error: "Email and password are required",
      });
    }

    const user = findLogin.get(email.trim().toLowerCase());

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return res.status(401).json({
        success: false,
        error: "Invalid email or password",
      });
    }

    res.json({
      success: true,
      token: createToken(user),
      user: publicUser(user),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/me", requireAuth, (req, res) => {
  res.json({
    success: true,
    user: req.user,
  });
});

const revokeToken = db.prepare(`
  INSERT OR IGNORE INTO revoked_tokens (
    jti,
    user_id,
    expires_at,
    revoked_at
  )
  VALUES (?, ?, ?, ?)
`);

const deleteExpiredTokens = db.prepare(`
  DELETE FROM revoked_tokens
  WHERE expires_at <= ?
`);

router.post("/logout", requireAuth, (req, res, next) => {
  try {
    const now = Math.floor(Date.now() / 1000);

    db.exec("BEGIN IMMEDIATE");

    try {
      revokeToken.run(
        req.authToken.jti,
        req.user.id,
        req.authToken.expiresAt,
        new Date().toISOString(),
      );

      deleteExpiredTokens.run(now);

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    res.json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    next(error);
  }
});

export default router;

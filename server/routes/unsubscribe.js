import express from "express";
import { db } from "../database/db.js";
import {
  inspectUnsubscribeToken,
  confirmUnsubscribe,
} from "../services/unsubscribeService.js";

const router = express.Router();

router.use(
  express.urlencoded({
    extended: false,
    limit: "1kb",
  }),
);

router.use((req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });

  next();
});

function renderPage(title, message, button = "") {
  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="referrer" content="no-referrer">
        <title>${title} | RentFlow</title>
        <style>
          * {
            box-sizing: border-box;
          }

          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            padding: 24px;
            background: #f5f7fb;
            color: #172033;
            font-family: Arial, sans-serif;
          }

          main {
            width: 100%;
            max-width: 440px;
            padding: 36px;
            border-radius: 16px;
            background: #ffffff;
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.06);
          }

          h1 {
            margin: 0 0 14px;
            font-size: 26px;
          }

          p {
            line-height: 1.65;
            color: #586174;
          }

          button {
            display: block;
            width: 100%;
            margin-top: 24px;
            padding: 14px;
            border: 0;
            border-radius: 8px;
            background: #172033;
            color: #ffffff;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>${title}</h1>
          <p>${message}</p>
          ${button}
        </main>
      </body>
    </html>
  `;
}

router.get("/:token", (req, res, next) => {
  try {
    const result = inspectUnsubscribeToken(db, req.params.token);

    if (!result.valid) {
      return res
        .status(400)
        .send(
          renderPage(
            "Link unavailable",
            "This unsubscribe link is invalid, expired, or has already been used.",
          ),
        );
    }

    const form = `
      <form method="POST">
        <button type="submit">
          Unsubscribe from follow-up emails
        </button>
      </form>
    `;

    res.send(
      renderPage(
        "Unsubscribe",
        "Confirm that you no longer wish to receive rental quote follow-up emails from this business.",
        form,
      ),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/:token", (req, res, next) => {
  try {
    const result = confirmUnsubscribe(db, req.params.token);

    if (!result.success) {
      return res
        .status(400)
        .send(
          renderPage(
            "Link unavailable",
            "This unsubscribe link is invalid, expired, or has already been used.",
          ),
        );
    }

    res.send(
      renderPage(
        "Successfully unsubscribed",
        "You have been unsubscribed from rental quote follow-up emails from this business.",
      ),
    );
  } catch (error) {
    next(error);
  }
});

export default router;

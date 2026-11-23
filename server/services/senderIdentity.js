const DEFAULT_DISPLAY_NAME = "The Rental Team";

export function installSenderIdentitySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_sender_settings (
      company_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      reply_to_email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (company_id)
        REFERENCES companies(id)
        ON DELETE CASCADE
    );
  `);
}

export function validateSenderIdentity(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      valid: false,
      error: "Sender settings must be an object",
    };
  }

  const { displayName, replyToEmail } = input;

  if (
    typeof displayName !== "string" ||
    displayName.trim().length < 2 ||
    displayName.trim().length > 80 ||
    // eslint-disable-next-line no-control-regex -- reject control characters in mail headers
    /[\x00-\x1f\x7f<>]/.test(displayName)
  ) {
    return {
      valid: false,
      error: "Display name must contain 2 to 80 valid characters",
    };
  }

  if (
    typeof replyToEmail !== "string" ||
    replyToEmail.length > 254 ||
    // eslint-disable-next-line no-control-regex -- reject control characters in mail headers
    /[\x00-\x20\x7f<>]/.test(replyToEmail) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyToEmail)
  ) {
    return {
      valid: false,
      error: "Provide a valid reply-to email address",
    };
  }

  const normalizedEmail = replyToEmail.toLowerCase();

  if (normalizedEmail.split("@")[0].length > 64) {
    return {
      valid: false,
      error: "Reply-to email address is too long",
    };
  }

  return {
    valid: true,
    data: {
      displayName: displayName.trim(),
      replyToEmail: normalizedEmail,
    },
  };
}

export function getSenderIdentity(db, companyId) {
  const settings = db
    .prepare(
      `
    SELECT
      display_name AS displayName,
      reply_to_email AS replyToEmail,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM company_sender_settings
    WHERE company_id = ?
  `,
    )
    .get(companyId);

  if (!settings) {
    return {
      configured: false,
      displayName: DEFAULT_DISPLAY_NAME,
      replyToEmail: null,
      createdAt: null,
      updatedAt: null,
      domainVerified: false,
      deliveryEnabled: false,
    };
  }

  return {
    configured: true,
    ...settings,
    domainVerified: false,
    deliveryEnabled: false,
  };
}

export function saveSenderIdentity(
  db,
  companyId,
  input,
  currentTime = new Date().toISOString(),
) {
  const validation = validateSenderIdentity(input);

  if (!validation.valid) {
    return {
      success: false,
      statusCode: 400,
      error: validation.error,
    };
  }

  const date = new Date(currentTime);

  if (!Number.isFinite(date.getTime())) {
    throw new Error("Invalid sender settings timestamp");
  }

  const company = db
    .prepare(
      `
    SELECT id
    FROM companies
    WHERE id = ?
  `,
    )
    .get(companyId);

  if (!company) {
    return {
      success: false,
      statusCode: 404,
      error: "Company not found",
    };
  }

  const now = date.toISOString();

  db.prepare(
    `
    INSERT INTO company_sender_settings (
      company_id,
      display_name,
      reply_to_email,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(company_id)
    DO UPDATE SET
      display_name = excluded.display_name,
      reply_to_email = excluded.reply_to_email,
      updated_at = excluded.updated_at
  `,
  ).run(
    companyId,
    validation.data.displayName,
    validation.data.replyToEmail,
    now,
    now,
  );

  return {
    success: true,
    statusCode: 200,
    data: getSenderIdentity(db, companyId),
  };
}

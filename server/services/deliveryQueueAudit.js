export function installDeliveryQueueAudit(db) {
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(delivery_queue)")
      .all()
      .map((column) => column.name),
  );

  const migrations = [
    ["created_by", "TEXT"],
    ["approved_by", "TEXT"],
    ["simulated_by", "TEXT"],
    ["cancelled_by", "TEXT"],
    ["cancel_reason", "TEXT"],
  ];

  for (const [name, type] of migrations) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE delivery_queue ADD COLUMN ${name} ${type}`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_queue_audit (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL,
      event_type TEXT NOT NULL
        CHECK (
          event_type IN (
            'queued',
            'approved',
            'simulated',
            'cancelled'
          )
        ),
      previous_status TEXT,
      new_status TEXT NOT NULL,
      actor_type TEXT NOT NULL
        CHECK (
          actor_type IN (
            'user',
            'system',
            'unknown'
          )
        ),
      actor_id TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (queue_id)
        REFERENCES delivery_queue(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_delivery_queue_audit_queue
    ON delivery_queue_audit(queue_id, created_at);

    CREATE TRIGGER IF NOT EXISTS audit_delivery_queue_insert
    AFTER INSERT ON delivery_queue
    BEGIN
      INSERT INTO delivery_queue_audit (
        id,
        queue_id,
        event_type,
        previous_status,
        new_status,
        actor_type,
        actor_id,
        reason,
        created_at
      )
      VALUES (
        lower(hex(randomblob(16))),
        NEW.id,
        'queued',
        NULL,
        NEW.status,
        CASE
          WHEN NEW.created_by IS NOT NULL THEN 'user'
          ELSE 'unknown'
        END,
        NEW.created_by,
        NULL,
        NEW.created_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS audit_delivery_queue_status
    AFTER UPDATE OF status ON delivery_queue
    WHEN OLD.status <> NEW.status
    BEGIN
      INSERT INTO delivery_queue_audit (
        id,
        queue_id,
        event_type,
        previous_status,
        new_status,
        actor_type,
        actor_id,
        reason,
        created_at
      )
      VALUES (
        lower(hex(randomblob(16))),
        NEW.id,
        NEW.status,
        OLD.status,
        NEW.status,
        CASE
          WHEN NEW.status = 'approved'
            AND NEW.approved_by IS NOT NULL
            THEN 'user'
          WHEN NEW.status = 'simulated'
            AND NEW.simulated_by IS NOT NULL
            THEN 'user'
          WHEN NEW.status = 'cancelled'
            AND NEW.cancelled_by IS NOT NULL
            THEN 'user'
          WHEN NEW.status = 'cancelled'
            THEN 'system'
          ELSE 'unknown'
        END,
        CASE
          WHEN NEW.status = 'approved'
            THEN NEW.approved_by
          WHEN NEW.status = 'simulated'
            THEN NEW.simulated_by
          WHEN NEW.status = 'cancelled'
            THEN NEW.cancelled_by
          ELSE NULL
        END,
        CASE
          WHEN NEW.status = 'cancelled'
            THEN COALESCE(
              NEW.cancel_reason,
              'AUTOMATIC_INVALIDATION'
            )
          ELSE NULL
        END,
        NEW.updated_at
      );
    END;
  `);
}

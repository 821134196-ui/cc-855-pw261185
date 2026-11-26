import { requiredColumnInfo } from './migration.js';
import { scalar } from './db.js';

/** Orders the traffic loops may touch, biased to recently-created rows. */
export function listTickOrders(db, limit = 12) {
  return db
    .prepare(
      `SELECT id, status, ${hasHandling(db) ? 'handling' : 'NULL AS handling'}
         FROM orders ORDER BY id DESC LIMIT ?`,
    )
    .all(limit);
}

/** True once the expand step has added the required column. */
export function hasHandling(db) {
  return requiredColumnInfo(db).exists;
}

/** Rows a modern update may touch: those whose current value it can revise. */
export function modernTickOrders(db, limit = 12) {
  if (!hasHandling(db)) {
    return db.prepare('SELECT id, NULL AS handling FROM orders ORDER BY id DESC LIMIT ?').all(limit);
  }
  return db
    .prepare(
      `SELECT o.id, o.handling
         FROM orders o
         LEFT JOIN handling_provenance p ON p.order_id = o.id
        WHERE o.handling IS NOT NULL
        ORDER BY (p.origin = 'modern') DESC, o.id DESC
        LIMIT ?`,
    )
    .all(limit);
}

/** A modern read includes the required column; before expand it reads NULL. */
export function modernSelectColumns(db) {
  return hasHandling(db)
    ? 'id, ref, customer, amount_cents, priority, status, created_at, handling'
    : 'id, ref, customer, amount_cents, priority, status, created_at, NULL AS handling';
}

export function orderCount(db) {
  return scalar(db, 'SELECT COUNT(*) FROM orders');
}

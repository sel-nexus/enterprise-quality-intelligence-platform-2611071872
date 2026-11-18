/** Persist identity records in a versioned, file-backed SQLite database. */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
// Vitest's Vite resolver predates node:sqlite; native require preserves the Node builtin.
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';

export interface UserRecord {
  id: string;
  email: string;
  role: string;
  active: number;
  password_hash: string;
}

/** Own the SQLite connection and initialize the development administrator once. */
@Injectable()
export class Database implements OnModuleDestroy {
  readonly db: DatabaseSyncType;

  constructor() {
    const path = resolve(process.env.DATABASE_PATH || './data/eqip.sqlite');
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON;');
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 2) throw new Error('Database schema is newer than this application');
    if (version.user_version === 0) {
      this.db.exec(`BEGIN;
        CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, password_hash TEXT NOT NULL);
        CREATE TABLE user_segments (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, segment_id TEXT NOT NULL, PRIMARY KEY (user_id, segment_id));
        PRAGMA user_version = 1;
        COMMIT;`);
    }
    if (version.user_version < 2) {
      this.db.exec(`BEGIN;
        CREATE TABLE segments (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE applications (id TEXT PRIMARY KEY, name TEXT NOT NULL, segment_id TEXT NOT NULL REFERENCES segments(id), owner TEXT NOT NULL, lifecycle TEXT NOT NULL, criticality TEXT NOT NULL, quality_score REAL CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 100)));
        CREATE INDEX applications_segment_idx ON applications(segment_id);
        PRAGMA user_version = 2;
        COMMIT;`);
    }
    if (process.env.NODE_ENV !== 'production' && process.env.DEV_LOGIN_ENABLED === 'true') {
      const email = process.env.DEV_ADMIN_EMAIL?.trim().toLowerCase();
      const password = process.env.DEV_ADMIN_PASSWORD;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !password || password.length < 12 || password.length > 256) {
        throw new Error('Valid DEV_ADMIN_EMAIL and a 12–256 character DEV_ADMIN_PASSWORD are required');
      }
      if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
      const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (!existing) {
        const salt = randomBytes(16).toString('hex');
        const hash = scryptSync(password, salt, 64).toString('hex');
        this.db.prepare('INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, ?, ?)').run(randomUUID(), email, 'admin', `${salt}:${hash}`);
      }
    }
  }

  /** Close the database on application shutdown. */
  onModuleDestroy(): void { this.db.close(); }
}

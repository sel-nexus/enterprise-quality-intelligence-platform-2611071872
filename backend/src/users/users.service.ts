/** Administer development identities and record access changes atomically. */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { Database, UserRecord } from '../database';
import { AuthUser } from '../auth/auth.service';

const roles = ['admin', 'executive', 'segment_leader', 'qe_leader', 'qe_manager', 'engineer', 'release_manager', 'auditor', 'vendor', 'viewer'];
export interface ManagedUser { id: string; email: string; role: string; active: boolean; segments: string[] }
export interface AuditEntry { id: number; actorId: string; targetId: string; occurredAt: string; oldValues: ManagedUser | null; newValues: ManagedUser }

/** Reject unexpected or empty request bodies. */
function input(body: unknown, allowed: string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(key => !allowed.includes(key))) throw new BadRequestException('Invalid input');
  return body as Record<string, unknown>;
}

/** Enforce administrative access at the service boundary. */
@Injectable()
export class UsersService {
  constructor(@Inject(Database) private readonly database: Database) {}

  private admin(actor: AuthUser): void {
    const current = this.database.db.prepare('SELECT role, active FROM users WHERE id = ?').get(actor.id) as { role: string; active: number } | undefined;
    if (!current || current.role !== 'admin' || current.active !== 1) throw new ForbiddenException('Administrator access required');
  }

  private publicUser(row: UserRecord): ManagedUser {
    const segments = this.database.db.prepare('SELECT segment_id FROM user_segments WHERE user_id = ? ORDER BY segment_id').all(row.id) as { segment_id: string }[];
    return { id: row.id, email: row.email, role: row.role, active: row.active === 1, segments: segments.map(segment => segment.segment_id) };
  }

  private get(id: string): ManagedUser {
    const row = this.database.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRecord | undefined;
    if (!row) throw new NotFoundException('User not found');
    return this.publicUser(row);
  }

  private validate(role: unknown, active: unknown, segments: unknown): { role: string; active: boolean; segments: string[] } {
    if (typeof role !== 'string' || !roles.includes(role)) throw new BadRequestException('Invalid role');
    if (typeof active !== 'boolean') throw new BadRequestException('Invalid status');
    if (!Array.isArray(segments) || segments.some(id => typeof id !== 'string' || !id || id.length > 80) || new Set(segments).size !== segments.length) throw new BadRequestException('Invalid segments');
    for (const id of segments) if (!this.database.db.prepare('SELECT id FROM segments WHERE id = ?').get(id)) throw new BadRequestException('Segment does not exist');
    return { role, active, segments: [...segments].sort() as string[] };
  }

  private transaction<T>(action: () => T): T {
    this.database.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.database.db.exec('COMMIT'); return result; }
    catch (error) { this.database.db.exec('ROLLBACK'); throw error; }
  }

  private audit(actor: AuthUser, before: ManagedUser | null, after: ManagedUser): void {
    this.database.db.prepare('INSERT INTO user_audit (actor_id, target_id, occurred_at, old_values, new_values) VALUES (?, ?, ?, ?, ?)')
      .run(actor.id, after.id, new Date().toISOString(), before ? JSON.stringify(before) : null, JSON.stringify(after));
  }

  /** List public user data for administrators only. */
  list(actor: AuthUser): { items: ManagedUser[] } {
    this.admin(actor);
    const rows = this.database.db.prepare('SELECT * FROM users ORDER BY email, id').all() as unknown as UserRecord[];
    return { items: rows.map(row => this.publicUser(row)) };
  }

  /** Return recorded access changes without credentials. */
  history(actor: AuthUser): { items: AuditEntry[] } {
    this.admin(actor);
    const rows = this.database.db.prepare('SELECT id, actor_id, target_id, occurred_at, old_values, new_values FROM user_audit ORDER BY id DESC').all() as unknown as { id: number; actor_id: string; target_id: string; occurred_at: string; old_values: string | null; new_values: string }[];
    return { items: rows.map(row => ({ id: row.id, actorId: row.actor_id, targetId: row.target_id, occurredAt: row.occurred_at, oldValues: row.old_values ? JSON.parse(row.old_values) as ManagedUser : null, newValues: JSON.parse(row.new_values) as ManagedUser })) };
  }

  /** Create a local-development account and audit its initial access. */
  create(actor: AuthUser, body: unknown): ManagedUser {
    this.admin(actor);
    if (process.env.NODE_ENV === 'production' || process.env.DEV_LOGIN_ENABLED !== 'true') throw new ForbiddenException('Development account creation is disabled');
    const data = input(body, ['email', 'password', 'role', 'active', 'segments']);
    if (typeof data.email !== 'string' || data.email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) throw new BadRequestException('Invalid email');
    if (typeof data.password !== 'string' || data.password.length < 12 || data.password.length > 256) throw new BadRequestException('Password must be 12–256 characters');
    const email = data.email.trim().toLowerCase();
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(data.password, salt, 64).toString('hex');
    return this.transaction(() => {
      this.admin(actor);
      const values = this.validate(data.role, data.active, data.segments);
      if (this.database.db.prepare('SELECT id FROM users WHERE email = ?').get(email)) throw new ConflictException('Email already exists');
      const id = randomUUID();
      this.database.db.prepare('INSERT INTO users (id, email, role, active, password_hash) VALUES (?, ?, ?, ?, ?)').run(id, email, values.role, values.active ? 1 : 0, `${salt}:${hash}`);
      for (const segment of values.segments) this.database.db.prepare('INSERT INTO user_segments (user_id, segment_id) VALUES (?, ?)').run(id, segment);
      const created = this.get(id);
      this.audit(actor, null, created);
      return created;
    });
  }

  /** Update access and audit both snapshots in the same write transaction. */
  update(actor: AuthUser, id: string, body: unknown): ManagedUser {
    this.admin(actor);
    const data = input(body, ['role', 'active', 'segments']);
    return this.transaction(() => {
      this.admin(actor);
      const before = this.get(id);
      const values = this.validate(data.role === undefined ? before.role : data.role, data.active === undefined ? before.active : data.active, data.segments === undefined ? before.segments : data.segments);
      if (before.role === 'admin' && before.active && (values.role !== 'admin' || !values.active)) {
        const count = this.database.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").get() as { count: number };
        if (count.count <= 1) throw new ConflictException('At least one active administrator is required');
      }
      this.database.db.prepare('UPDATE users SET role = ?, active = ?, session_version = session_version + ? WHERE id = ?').run(values.role, values.active ? 1 : 0, before.active && !values.active ? 1 : 0, id);
      this.database.db.prepare('DELETE FROM user_segments WHERE user_id = ?').run(id);
      for (const segment of values.segments) this.database.db.prepare('INSERT INTO user_segments (user_id, segment_id) VALUES (?, ?)').run(id, segment);
      const after = this.get(id);
      if (JSON.stringify(before) !== JSON.stringify(after)) this.audit(actor, before, after);
      return after;
    });
  }
}

/** Authenticate the configured development account and verify signed sessions. */
import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Database, UserRecord } from '../database';

export interface AuthUser { id: string; email: string; role: string; segments: string[] }

/** Resolve identities from persisted users rather than caller-supplied claims. */
@Injectable()
export class AuthService {
  constructor(@Inject(Database) private readonly database: Database) {}

  /** Refuse all development sessions unless explicitly enabled outside production. */
  private enabled(): boolean {
    return process.env.NODE_ENV !== 'production' && process.env.DEV_LOGIN_ENABLED === 'true' && !!process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32;
  }

  /** Return only public identity and current persisted segment assignments. */
  private publicUser(user: UserRecord): AuthUser {
    const rows = this.database.db.prepare('SELECT segment_id FROM user_segments WHERE user_id = ? ORDER BY segment_id').all(user.id) as { segment_id: string }[];
    return { id: user.id, email: user.email, role: user.role, segments: rows.map(row => row.segment_id) };
  }

  /** Validate credentials and issue a short-lived signed session. */
  login(body: unknown): { token: string; user: AuthUser } {
    if (!this.enabled()) throw new UnauthorizedException('Development login is disabled');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Email and password are required');
    const data = body as Record<string, unknown>;
    if (Object.keys(data).some(key => key !== 'email' && key !== 'password') || typeof data.email !== 'string' || typeof data.password !== 'string' || data.email.length > 254 || data.password.length > 256 || data.password.length === 0 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) {
      throw new BadRequestException('Invalid login input');
    }
    const user = this.database.db.prepare('SELECT * FROM users WHERE email = ?').get(data.email.trim().toLowerCase()) as unknown as UserRecord | undefined;
    // Use the same password derivation for unknown users to avoid a trivial timing oracle.
    const [salt, expected] = (user?.password_hash || `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
    const actual = scryptSync(data.password, salt, 64);
    const saved = Buffer.from(expected, 'hex');
    if (!user || user.active !== 1 || saved.length !== actual.length || !timingSafeEqual(actual, saved)) throw new UnauthorizedException('Invalid email or password');
    const token = jwt.sign({ sub: user.id, sessionVersion: user.session_version }, process.env.SESSION_SECRET!, { algorithm: 'HS256', expiresIn: '8h' });
    return { token, user: this.publicUser(user) };
  }

  /** Verify the session and reload current authorization data on every request. */
  authenticate(authorization: string | undefined): AuthUser {
    if (!this.enabled() || !authorization || !/^Bearer [^\s]+$/.test(authorization)) throw new UnauthorizedException();
    let subject: string | undefined;
    let sessionVersion: number | undefined;
    try {
      const payload = jwt.verify(authorization.slice(7), process.env.SESSION_SECRET!, { algorithms: ['HS256'] });
      if (typeof payload !== 'string' && typeof payload.sub === 'string') {
        subject = payload.sub;
        sessionVersion = payload.sessionVersion === undefined ? 0 : payload.sessionVersion;
      }
    } catch {
      throw new UnauthorizedException();
    }
    if (!subject) throw new UnauthorizedException();
    const user = this.database.db.prepare('SELECT * FROM users WHERE id = ?').get(subject) as unknown as UserRecord | undefined;
    if (!user || user.active !== 1 || sessionVersion !== user.session_version) throw new UnauthorizedException();
    return this.publicUser(user);
  }
}

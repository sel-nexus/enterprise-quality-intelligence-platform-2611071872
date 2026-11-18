/** Persist and authorize segment and application inventory. */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Database } from '../database';
import { AuthUser } from '../auth/auth.service';

export interface Segment { id: string; name: string }
export interface Application { id: string; name: string; segmentId: string; owner: string; lifecycle: string; criticality: string; qualityScore: number | null }

/** Validate a bounded, nonblank field. */
function text(value: unknown, field: string, id = false): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > (id ? 80 : 200) || (id && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.trim()))) throw new BadRequestException(`Invalid ${field}`);
  return value.trim();
}

/** Reject non-object bodies and unexpected properties. */
function input(body: unknown, keys: string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw new BadRequestException('Invalid input');
  return body as Record<string, unknown>;
}

/** Use persisted identity and assignments for all access decisions. */
@Injectable()
export class InventoryService {
  constructor(@Inject(Database) private readonly database: Database) {}

  /** Require an administrator for all writes. */
  private admin(user: AuthUser): void { if (user.role !== 'admin') throw new ForbiddenException('Administrator access required'); }

  /** Return only the segments visible to the current user. */
  segments(user: AuthUser): { items: Segment[] } {
    const rows = this.database.db.prepare('SELECT id, name FROM segments ORDER BY name, id').all() as unknown as Segment[];
    return { items: user.role === 'admin' || user.role === 'executive' ? rows : rows.filter(row => user.segments.includes(row.id)) };
  }

  /** Create a segment with a unique identifier. */
  createSegment(user: AuthUser, body: unknown): Segment {
    this.admin(user);
    const data = input(body, ['id', 'name']);
    const segment = { id: text(data.id, 'id', true), name: text(data.name, 'name') };
    if (this.database.db.prepare('SELECT id FROM segments WHERE id = ?').get(segment.id)) throw new ConflictException('Segment identifier already exists');
    this.database.db.prepare('INSERT INTO segments (id, name) VALUES (?, ?)').run(segment.id, segment.name);
    return segment;
  }

  /** Rename an existing segment without changing its identifier. */
  updateSegment(user: AuthUser, id: string, body: unknown): Segment {
    this.admin(user);
    const data = input(body, ['name']);
    const name = text(data.name, 'name');
    if (!this.database.db.prepare('SELECT id FROM segments WHERE id = ?').get(id)) throw new NotFoundException('Segment not found');
    this.database.db.prepare('UPDATE segments SET name = ? WHERE id = ?').run(name, id);
    return { id, name };
  }

  /** List applications only within the caller's authorized segments. */
  applications(user: AuthUser): { items: Application[] } {
    const rows = this.database.db.prepare('SELECT id, name, segment_id AS segmentId, owner, lifecycle, criticality, quality_score AS qualityScore FROM applications ORDER BY name, id').all() as unknown as Application[];
    return { items: user.role === 'admin' || user.role === 'executive' ? rows : rows.filter(row => user.segments.includes(row.segmentId)) };
  }

  /** Validate a complete application and its referenced segment. */
  private validateApplication(data: Record<string, unknown>): Application {
    const application: Application = { id: text(data.id, 'id', true), name: text(data.name, 'name'), segmentId: text(data.segmentId, 'segmentId', true), owner: text(data.owner, 'owner'), lifecycle: text(data.lifecycle, 'lifecycle'), criticality: text(data.criticality, 'criticality'), qualityScore: null };
    if (data.qualityScore !== undefined && data.qualityScore !== null) {
      if (typeof data.qualityScore !== 'number' || !Number.isFinite(data.qualityScore) || data.qualityScore < 0 || data.qualityScore > 100) throw new BadRequestException('Invalid qualityScore');
      application.qualityScore = data.qualityScore;
    }
    if (!this.database.db.prepare('SELECT id FROM segments WHERE id = ?').get(application.segmentId)) throw new BadRequestException('Segment does not exist');
    return application;
  }

  /** Create an application in an existing segment. */
  createApplication(user: AuthUser, body: unknown): Application {
    this.admin(user);
    const data = input(body, ['id', 'name', 'segmentId', 'owner', 'lifecycle', 'criticality', 'qualityScore']);
    const app = this.validateApplication(data);
    if (this.database.db.prepare('SELECT id FROM applications WHERE id = ?').get(app.id)) throw new ConflictException('Application identifier already exists');
    this.database.db.prepare('INSERT INTO applications (id, name, segment_id, owner, lifecycle, criticality, quality_score) VALUES (?, ?, ?, ?, ?, ?, ?)').run(app.id, app.name, app.segmentId, app.owner, app.lifecycle, app.criticality, app.qualityScore);
    return app;
  }

  /** Update mutable application fields while retaining its identifier. */
  updateApplication(user: AuthUser, id: string, body: unknown): Application {
    this.admin(user);
    const data = input(body, ['name', 'segmentId', 'owner', 'lifecycle', 'criticality', 'qualityScore']);
    if (!Object.keys(data).length) throw new BadRequestException('At least one field is required');
    const existing = this.database.db.prepare('SELECT id, name, segment_id AS segmentId, owner, lifecycle, criticality, quality_score AS qualityScore FROM applications WHERE id = ?').get(id) as unknown as Application | undefined;
    if (!existing) throw new NotFoundException('Application not found');
    const app = this.validateApplication({ ...existing, ...data });
    this.database.db.prepare('UPDATE applications SET name = ?, segment_id = ?, owner = ?, lifecycle = ?, criticality = ?, quality_score = ? WHERE id = ?').run(app.name, app.segmentId, app.owner, app.lifecycle, app.criticality, app.qualityScore, id);
    return app;
  }
}

/** Build reports from the inventory's existing authorization boundary. */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { AuthUser } from '../auth/auth.service';
import { InventoryService } from '../inventory/inventory.service';

export interface Overview {
  segmentCount: number;
  applicationCount: number;
  scoredApplicationCount: number;
  unknownScoreCount: number;
  segments: { id: string; name: string; applicationCount: number }[];
}

/** Quote CSV fields and neutralize spreadsheet formula prefixes. */
function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Aggregate only records the inventory service allows this identity to see. */
@Injectable()
export class ReportsService {
  constructor(@Inject(InventoryService) private readonly inventory: InventoryService) {}

  /** Return persisted inventory counts, including unscored applications. */
  overview(user: AuthUser): Overview {
    const segments = this.inventory.segments(user).items;
    const applications = this.inventory.applications(user).items;
    const scoredApplicationCount = applications.filter(app => app.qualityScore !== null).length;
    return {
      segmentCount: segments.length,
      applicationCount: applications.length,
      scoredApplicationCount,
      unknownScoreCount: applications.length - scoredApplicationCount,
      segments: segments.map(segment => ({ ...segment, applicationCount: applications.filter(app => app.segmentId === segment.id).length })),
    };
  }

  /** Export scoped inventory for authorized enterprise roles without owner details. */
  applicationsCsv(user: AuthUser): string {
    if (user.role !== 'admin' && user.role !== 'executive') throw new ForbiddenException('Export requires administrator or executive access');
    const rows = this.inventory.applications(user).items;
    const header = ['Sensitivity', 'Application ID', 'Application name', 'Segment ID', 'Lifecycle', 'Criticality', 'Quality score'];
    return [header, ...rows.map(app => ['Internal', app.id, app.name, app.segmentId, app.lifecycle, app.criticality, app.qualityScore])]
      .map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
}

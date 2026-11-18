/** Expose authenticated, scoped overview and export endpoints. */
import { Controller, Get, Header, Inject, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../auth/auth.guard';
import { Overview, ReportsService } from './reports.service';

/** Delegate reporting and export authorization to the service. */
@Controller('api/v1/reports')
@UseGuards(AuthGuard)
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  /** Return the current caller's scoped inventory summary. */
  @Get('overview')
  overview(@Req() request: AuthenticatedRequest): Overview { return this.reports.overview(request.user); }

  /** Return a labeled CSV attachment when the caller is authorized. */
  @Get('applications.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="applications.csv"')
  @Header('Cache-Control', 'no-store')
  csv(@Req() request: AuthenticatedRequest): string { return this.reports.applicationsCsv(request.user); }
}

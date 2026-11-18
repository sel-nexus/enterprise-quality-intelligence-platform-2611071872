/** Expose authenticated inventory endpoints. */
import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../auth/auth.guard';
import { Application, InventoryService, Segment } from './inventory.service';

/** Delegate inventory requests to server-side authorization and persistence. */
@Controller('api/v1')
@UseGuards(AuthGuard)
export class InventoryController {
  constructor(@Inject(InventoryService) private readonly inventory: InventoryService) {}

  /** List accessible segments. */
  @Get('segments')
  segments(@Req() request: AuthenticatedRequest): { items: Segment[] } { return this.inventory.segments(request.user); }

  /** Create a segment as an administrator. */
  @Post('segments')
  createSegment(@Req() request: AuthenticatedRequest, @Body() body: unknown): Segment { return this.inventory.createSegment(request.user, body); }

  /** Update a segment as an administrator. */
  @Patch('segments/:id')
  updateSegment(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown): Segment { return this.inventory.updateSegment(request.user, id, body); }

  /** List accessible applications. */
  @Get('applications')
  applications(@Req() request: AuthenticatedRequest): { items: Application[] } { return this.inventory.applications(request.user); }

  /** Create an application as an administrator. */
  @Post('applications')
  createApplication(@Req() request: AuthenticatedRequest, @Body() body: unknown): Application { return this.inventory.createApplication(request.user, body); }

  /** Update an application as an administrator. */
  @Patch('applications/:id')
  updateApplication(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown): Application { return this.inventory.updateApplication(request.user, id, body); }
}

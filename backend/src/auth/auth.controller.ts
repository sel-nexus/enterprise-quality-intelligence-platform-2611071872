/** Expose development login and the authenticated identity endpoint. */
import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from './auth.guard';
import { AuthService, AuthUser } from './auth.service';

/** Serve the identity API. */
@Controller('api/v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** Exchange development credentials for a signed session. */
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown): { token: string; user: AuthUser } { return this.auth.login(body); }

  /** Return the authenticated user's current identity. */
  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() request: AuthenticatedRequest): AuthUser { return request.user; }
}

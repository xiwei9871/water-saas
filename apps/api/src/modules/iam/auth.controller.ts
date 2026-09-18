import { BadRequestException, Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../common/public.decorator.js';
import { AuthService } from './auth.service.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * POST /auth/login {tenantCode, login, password}
   * → {accessToken (15m), refreshToken (7d), staff, roles, perms}
   */
  @Public()
  @Post('login')
  login(@Body() body: { tenantCode?: string; login?: string; password?: string }) {
    if (!body?.tenantCode || !body?.login || !body?.password) {
      throw new BadRequestException({ code: 'LOGIN_FIELDS_REQUIRED' });
    }
    return this.auth.login({
      tenantCode: body.tenantCode,
      login: body.login,
      password: body.password,
    });
  }

  /** POST /auth/refresh {refreshToken} → new token pair. */
  @Public()
  @Post('refresh')
  refresh(@Body() body: { refreshToken?: string }) {
    if (!body?.refreshToken) {
      throw new BadRequestException({ code: 'REFRESH_TOKEN_REQUIRED' });
    }
    return this.auth.refresh(body.refreshToken);
  }

  /** GET /auth/me → fresh staff + roles + perms + orgScope. */
  @Get('me')
  me(@Req() req: Request) {
    return this.auth.me(req.user!);
  }
}

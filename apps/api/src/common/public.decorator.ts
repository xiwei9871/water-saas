import { SetMetadata } from '@nestjs/common';

/** Routes marked @Public() skip JwtAuthGuard (login / refresh / health). */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

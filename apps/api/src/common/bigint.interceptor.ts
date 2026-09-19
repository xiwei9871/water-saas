import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { toJsonSafe } from './json-safe.js';

/**
 * Global response normalizer: converts BigInt → string and Prisma Decimal →
 * string recursively so `JSON.stringify` never crashes on Prisma rows.
 * Registered via APP_INTERCEPTOR in AppModule.
 */
@Injectable()
export class BigIntInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => toJsonSafe(data)));
  }
}

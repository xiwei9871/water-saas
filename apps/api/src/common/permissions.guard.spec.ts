import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { describe, it, expect } from 'vitest';
import { PermissionsGuard } from './permissions.guard.js';
import { PERMISSIONS_KEY } from './permissions.decorator.js';
function context(perms: string[], all?: string[], any?: string[]) {
  const handler = () => {};
  if (all) Reflect.defineMetadata(PERMISSIONS_KEY, all, handler);
  if (any) Reflect.defineMetadata('anyPermissions', any, handler);
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user: { perms } }) }),
  } as any;
}
describe('permission alternatives preserve fail-closed and ALL semantics', () => {
  const guard = new PermissionsGuard(new Reflector());
  it('denies callers with neither QC nor write', () =>
    expect(() =>
      guard.canActivate(
        context(['metering:read'], undefined, [
          'metering:qc',
          'metering:write',
        ]),
      ),
    ).toThrow());
  it('accepts QC-only, legacy write, and admin', () => {
    for (const perms of [['metering:qc'], ['metering:write'], ['*']])
      expect(
        guard.canActivate(
          context(perms, undefined, ['metering:qc', 'metering:write']),
        ),
      ).toBe(true);
  });
  it('ALL metadata still requires every permission', () =>
    expect(() =>
      guard.canActivate(
        context(['customer:read'], ['customer:read', 'customer:write']),
      ),
    ).toThrow());
  it('when combined requires both ALL and one alternative', () => {
    expect(() =>
      guard.canActivate(
        context(
          ['metering:read'],
          ['metering:read'],
          ['metering:qc', 'metering:write'],
        ),
      ),
    ).toThrow();
    expect(
      guard.canActivate(
        context(
          ['metering:read', 'metering:qc'],
          ['metering:read'],
          ['metering:qc', 'metering:write'],
        ),
      ),
    ).toBe(true);
  });
});

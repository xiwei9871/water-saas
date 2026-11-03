import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Stage2 C：所有 e2e 共享同一 watersaas_test——文件级串行执行，
    // 消除跨文件数据污染（service-order/e10/dma 并行 flake 根治）。
    fileParallelism: false,
  },
});

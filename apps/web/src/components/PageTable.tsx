import { useLayoutEffect, useRef, useState } from 'react';
import { Table } from 'antd';
import type { TableProps } from 'antd';

/**
 * 原则四：清单表「表头固定 + 横向滚动条常驻」统一封装。
 *
 * - scroll.y 动态取「视口高度 − 表格实际顶位置 − 预留（分页/边距）」，
 *   保证表体限高后横向滚动条始终落在可视区内，不受筛选区高低影响；
 * - 隐藏页签/抽屉里的表格先按缺省值渲染，ResizeObserver 在其获得
 *   实际尺寸后重新测量；
 * - x 缺省 'max-content'，保留各列自然宽度、超宽出横向滚动条。
 */
export default function PageTable<RecordType extends object>(
  props: TableProps<RecordType>,
) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [y, setY] = useState<number | string>('calc(100vh - 340px)');

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top;
      if (top <= 0) return; // 仍在隐藏容器中，等下次尺寸变化
      const h = Math.max(200, Math.floor(window.innerHeight - top - 88));
      setY(h);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const scroll = {
    x: 'max-content' as const,
    ...(props.scroll ?? {}),
    y,
  };
  return (
    <div ref={wrapRef} className="page-table">
      <Table<RecordType> {...props} scroll={scroll} />
    </div>
  );
}

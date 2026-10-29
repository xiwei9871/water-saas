import { useRef } from 'react';
import { App as AntdApp, Dropdown, Select } from 'antd';
import type { SelectProps } from 'antd';

/**
 * 20261028 筛选栏下拉与复制修订：全局通用下拉包装。
 * ① 右键复制：选中值后右键弹「复制」，复制的是显示文本（label），
 *    不是 value/英文码——遵循原则一。
 * ② 关键字录入：默认 showSearch + optionFilterProp=label，
 *    输入时下拉同步聚焦匹配项（原则三）；远程检索下拉
 *    （显式传 filterOption={false}）不受影响。
 * 原 Select 全部 props/交互透传，不影响展开/清空/搜索。
 */
export default function CopySelect<
  ValueType = unknown,
  OptionType extends { label?: unknown; value?: unknown } = { label?: unknown; value?: unknown },
>(props: SelectProps<ValueType, OptionType>) {
  const { message } = AntdApp.useApp();
  const ref = useRef<HTMLDivElement>(null);
  const hasValue =
    props.value !== undefined && props.value !== null &&
    !(Array.isArray(props.value) && props.value.length === 0);

  const copy = async () => {
    const root = ref.current;
    if (!root) return;
    // 直接取渲染出的显示文本（多选取全部标签），与所见一致。
    const items = [...root.querySelectorAll('.ant-select-selection-item')]
      .map((el) => (el.getAttribute('title') || el.textContent || '').trim())
      .filter(Boolean);
    const text = items.join('、');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      message.success(`已复制：${text}`);
    } catch {
      message.warning('复制失败，请手动选择文本复制');
    }
  };

  const merged = {
    showSearch: true,
    optionFilterProp: 'label' as const,
    ...props,
  };

  return (
    <Dropdown
      trigger={['contextMenu']}
      menu={{
        items: [{ key: 'copy', label: '复制', disabled: !hasValue }],
        onClick: ({ key }) => key === 'copy' && void copy(),
      }}
    >
      <div ref={ref} style={{ display: 'inline-block', width: '100%' }}>
        <Select {...merged} style={{ width: '100%', ...merged.style }} />
      </div>
    </Dropdown>
  );
}

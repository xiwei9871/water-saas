import { Form, Input, Select as AntSelect } from 'antd';

interface Props {
  options: { value: string; label: string }[];
  value?: string;
  onChange?: (v: string | undefined) => void;
  /** 选 OTHER 时必填文本域绑定字段名（提交体 {code:'OTHER',otherText}）。 */
  otherFieldName?: string;
  placeholder?: string;
  size?: 'large' | 'middle' | 'small';
}

/** 1112v8-S6：字典下拉统一「其他」交互——选 OTHER 出现必填文本域。 */
export default function SmartSelect({ options, value, onChange, otherFieldName = 'otherText', placeholder, size }: Props) {
  const isOther = value === 'OTHER';
  return (
    <>
      <AntSelect
        showSearch optionFilterProp="label" allowClear
        options={options}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        size={size}
      />
      {isOther && (
        <Form.Item name={otherFieldName} noStyle rules={[{ required: true, message: '选「其他」须填写说明' }]}>
          <Input.TextArea rows={2} style={{ marginTop: 6 }} placeholder="请填写「其他」的具体说明（必填）" />
        </Form.Item>
      )}
    </>
  );
}
export const renderOther = (code: string | null | undefined, text?: string | null): string =>
  code === 'OTHER' ? `其他：${text ?? ''}` : (code ?? '—');

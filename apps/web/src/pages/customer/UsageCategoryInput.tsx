import { Select } from "antd";
import { USAGE_CATEGORY_OPTIONS } from "../common";

/** Preserve Form's id/value/onChange contract, including accessible label association. */
export default function UsageCategoryInput(props: {
  id?: string;
  value?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <Select
      {...props}
      style={{ width: "100%" }}
      options={USAGE_CATEGORY_OPTIONS}
      placeholder="选择用水类别"
      showSearch
      optionFilterProp="label"
    />
  );
}

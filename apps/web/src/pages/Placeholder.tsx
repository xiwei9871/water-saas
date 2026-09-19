import { Card, Empty } from 'antd';

/**
 * Placeholder for menu groups whose pages ship in T15/T16. The route entry
 * exists (menu visible per permission) but `element` is unset — App.tsx
 * renders this instead.
 */
export default function Placeholder({ title }: { title: string }) {
  return (
    <Card title={title}>
      <Empty description="该模块将在后续任务（T15/T16）中实现" />
    </Card>
  );
}

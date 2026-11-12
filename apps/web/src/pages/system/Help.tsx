import { Card, Collapse, Form, Input, Button, message } from 'antd';
import { api, apiErrorText } from '../../api/client';

/** T1/T2/T4：系统内帮助入口 + 问题反馈通道（反馈写入字典 FEEDBACK 由运维查看）。 */
export default function Help() {
  const [form] = Form.useForm<{ title: string; desc: string }>();
  return (
    <Card title="帮助中心" size="small">
      <Collapse
        defaultActiveKey={['faq']}
        items={[
          { key: 'faq', label: '常见问题 FAQ', children: (
            <ul>
              <li>抄表计划不生成？→ 抄表管理→生成抄表计划，手动触发并查看"生成记录"；确认租户已启用自动生成（系统管理→租户参数 autoPlanEnabled）。</li>
              <li>报装卡在待放号？→ 检查已填报安装水表（详情页"填报水表"按钮），水表齐备后才能放号。</li>
              <li>读数被质检驳回？→ 估抄记录可在质检前走"修订"（需填原因，最多3次）；实抄写错走冲正。</li>
              <li>重复开账报错？→ 同账期已有开账批次（409 DUPLICATE_PERIOD_RUN）；已终结账期禁止补录。</li>
              <li>换账号后数据错乱？→ 退出重新登录（会清空本地缓存），或 Ctrl+Shift+R 强刷。</li>
            </ul>
          ) },
          { key: 'flow', label: '业务指引', children: (
            <ul>
              <li>报装全流程：申请 → 安装完成（上传完工凭证）→ 填报水表 → 待放号 → 放号立户。</li>
              <li>催缴：收费→催缴管理 筛选欠费户 → 全选 → 批量生成通知单（每户自动挂催收任务）。</li>
              <li>外部对接：安装完成凭证回推走 external-complete；出站推送在 webhook-subscriptions 配置。</li>
            </ul>
          ) },
          { key: 'fb', label: '问题反馈', children: (
            <Form form={form} layout="vertical" onFinish={async (v) => {
              try {
                await api.post('/iam/dicts', { category: 'FEEDBACK', code: `FB-${Date.now()}`, name: v.title, value: { desc: v.desc } });
                message.success('已提交反馈，运维团队会跟进'); form.resetFields();
              } catch (e) { message.error(apiErrorText(e)); }
            }}>
              <Form.Item name="title" label="问题标题" rules={[{ required: true }]}><Input /></Form.Item>
              <Form.Item name="desc" label="问题描述（页面/操作/期望结果）" rules={[{ required: true }]}><Input.TextArea rows={4} /></Form.Item>
              <Button type="primary" htmlType="submit">提交反馈</Button>
            </Form>
          ) },
        ]}
      />
    </Card>
  );
}

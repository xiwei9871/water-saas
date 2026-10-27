import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { App as AntdApp, Button, Card, Col, Form, Input, Modal, Popconfirm, Row, Select, Space, Tabs, Tag, Tree } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiErrorText } from '../../api/client';
import { useDebounced } from '../pickers';
import Table from '../../components/PageTable';


interface Warehouse {
  id: string;
  code: string;
  name: string;
  owner: string | null;
  status: string;
  locations: { id: string; code: string; name: string; status: string }[];
}

interface Movement {
  id: string;
  meterId: string;
  meterNo: string | null;
  movementType: string;
  docNo: string | null;
  supplier: string | null;
  batchNo: string | null;
  warehouseId: string | null;
  warehouse: { code: string; name: string } | null;
  movedAt: string;
  remark: string | null;
}

interface StockRow {
  id: string;
  meterNo: string;
  brand: string | null;
  caliber: string | null;
  status: string;
  warehouse: { name: string } | null;
  location: { name: string } | null;
}

const MOVE_LABEL: Record<string, string> = {
  PURCHASE_IN: '采购入库',
  ISSUE_OUT: '领用出库',
  RETURN_IN: '退库回库',
  SCRAP_OUT: '报废出库',
  TRANSFER: '库间调拨',
};
const MOVE_COLOR: Record<string, string> = {
  PURCHASE_IN: 'green',
  ISSUE_OUT: 'blue',
  RETURN_IN: 'cyan',
  SCRAP_OUT: 'red',
  TRANSFER: 'orange',
};

/** 20261021 整改 任务D：水表库房 — 库房货位维护/出入库/库存/轨迹。 */
export default function MeterStock() {
  const { message } = AntdApp.useApp();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [stockRows, setStockRows] = useState<StockRow[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [whLoading, setWhLoading] = useState(false);
  const [whModal, setWhModal] = useState<'warehouse' | 'location' | 'move' | null>(null);
  const [selWh, setSelWh] = useState<string | undefined>();
  const [whForm] = Form.useForm();
  const [locForm] = Form.useForm();
  const [mvForm] = Form.useForm();
  const mvType = Form.useWatch('type', mvForm);

  const loadWarehouses = useCallback(async () => {
    try {
      const res = await api.get<Warehouse[]>('/meter-warehouses');
      setWarehouses(res.data);
    } catch (e) {
      message.error(apiErrorText(e));
    }
  }, [message]);

  const loadStock = useCallback(
    async (warehouseId?: string) => {
      try {
        const res = await api.get<{ items: StockRow[] }>('/meter-stock', {
          params: { take: 200, ...(warehouseId ? { warehouseId } : {}) },
        });
        setStockRows(res.data.items);
      } catch (e) {
        message.error(apiErrorText(e));
      }
    },
    [message],
  );

  const loadMovements = useCallback(async () => {
    try {
      const res = await api.get<{ items: Movement[] }>('/meter-stock/movements', {
        params: { take: 100 },
      });
      setMovements(res.data.items);
    } catch (e) {
      message.error(apiErrorText(e));
    }
  }, [message]);

  const loadAll = useCallback(async () => {
    setWhLoading(true);
    await Promise.all([loadWarehouses(), loadStock(selWh), loadMovements()]);
    setWhLoading(false);
  }, [loadWarehouses, loadStock, loadMovements, selWh]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const onCreateWarehouse = async () => {
    const v = await whForm.validateFields();
    try {
      await api.post('/meter-warehouses', v);
      message.success('库房已建');
      setWhModal(null);
      whForm.resetFields();
      void loadWarehouses();
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const onCreateLocation = async () => {
    const v = await locForm.validateFields();
    try {
      await api.post(`/meter-warehouses/${v.warehouseId}/locations`, {
        code: v.code,
        name: v.name,
      });
      message.success('货位已建');
      setWhModal(null);
      locForm.resetFields();
      void loadWarehouses();
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  // ---- X1 库房/货位 编辑·停用·删除 ----
  const [editForm] = Form.useForm<{ name: string; owner?: string }>();
  const [editing, setEditing] = useState<{
    kind: 'wh' | 'loc';
    whId?: string;
    row: { id: string; code: string; name: string };
  } | null>(null);

  const openEdit = (
    kind: 'wh' | 'loc',
    v: { whId?: string; row: { id: string; code: string; name: string } },
  ) => {
    setEditing({ kind, whId: v.whId, row: v.row });
    editForm.setFieldsValue({ name: v.row.name });
  };

  const saveEdit = async () => {
    if (!editing) return;
    const v = await editForm.validateFields();
    try {
      const path =
        editing.kind === 'wh'
          ? `/meter-warehouses/${editing.row.id}`
          : `/meter-warehouses/${editing.whId}/locations/${editing.row.id}`;
      await api.patch(path, editing.kind === 'wh' ? v : { name: v.name });
      message.success('已保存');
      setEditing(null);
      editForm.resetFields();
      void loadWarehouses();
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const toggleWh = async (id: string, disable: boolean) => {
    try {
      await api.patch(`/meter-warehouses/${id}`, {
        status: disable ? 'DISABLED' : 'ACTIVE',
      });
      message.success(disable ? '库房已停用（不再出现于出入库选项）' : '库房已启用');
      void loadWarehouses();
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };
  const delWh = async (id: string) => {
    try {
      await api.delete(`/meter-warehouses/${id}`);
      message.success('库房已删除');
      void loadWarehouses();
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };
  const toggleLoc = async (whId: string, locId: string, disable: boolean) => {
    try {
      await api.patch(`/meter-warehouses/${whId}/locations/${locId}`, {
        status: disable ? 'DISABLED' : 'ACTIVE',
      });
      message.success(disable ? '货位已停用' : '货位已启用');
      void loadWarehouses();
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };
  const delLoc = async (whId: string, locId: string) => {
    try {
      await api.delete(`/meter-warehouses/${whId}/locations/${locId}`);
      message.success('货位已删除');
      void loadWarehouses();
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  // 20261023 D1 分源多选：按流水类型加载候选表（采购入库则录新号）。
  const [candidates, setCandidates] = useState<
    { id: string; meterNo: string; status: string; warehouse: { name: string } | null }[]
  >([]);
  const loadCandidates = useCallback(
    async (type?: string, kw = '') => {
      if (!type || type === 'PURCHASE_IN') {
        setCandidates([]);
        return;
      }
      try {
        // T1：kw 远程搜索（后端已支持），不再一次性全量加载
        const res = await api.get<typeof candidates>('/meter-stock/selectable', {
          params: { type, take: 50, ...(kw.trim() ? { kw: kw.trim() } : {}) },
        });
        setCandidates(res.data);
      } catch (e) {
        message.error(apiErrorText(e));
      }
    },
    [message],
  );
  const candidateSearch = useDebounced((kw) => void loadCandidates(mvType, kw));
  useEffect(() => {
    if (whModal === 'move') void loadCandidates(mvType);
  }, [mvType, whModal, loadCandidates]);

  const onMove = async () => {
    const v = await mvForm.validateFields();
    try {
      await api.post('/meter-stock/movements', {
        type: v.type,
        meterIds: v.type === 'PURCHASE_IN' ? undefined : v.meterIds,
        meterNos: v.type === 'PURCHASE_IN' ? v.meterNos : undefined,
        warehouseId: v.warehouseId,
        locationId: v.locationId,
        brand: v.brand,
        model: v.model,
        caliber: v.caliber,
        docNo: v.docNo,
        supplier: v.supplier,
        batchNo: v.batchNo,
        remark: v.remark,
      });
      message.success('出入库已记流水');
      setWhModal(null);
      mvForm.resetFields();
      void loadAll();
    } catch (e) {
      message.error(apiErrorText(e));
    }
  };

  const whTree = useMemo(
    () =>
      warehouses.map((w) => ({
        title: `${w.code} ${w.name}${w.owner ? `（${w.owner}）` : ''}`,
        key: w.id,
        children: w.locations.map((l) => ({ title: `${l.code} ${l.name}`, key: l.id })),
      })),
    [warehouses],
  );
  // X1：停用库房/货位不再出现在出入库可选项中
  const whOptions = warehouses
    .filter((w) => w.status === 'ACTIVE')
    .map((w) => ({ value: w.id, label: `${w.code} ${w.name}` }));
  const locOptions = (whId?: string) =>
    warehouses
      .find((w) => w.id === whId)
      ?.locations.filter((l) => l.status === 'ACTIVE')
      .map((l) => ({
        value: l.id,
        label: `${l.code} ${l.name}`,
      })) ?? [];

  const stockCols: ColumnsType<StockRow> = [
    { title: '表号', dataIndex: 'meterNo' },
    { title: '品牌', dataIndex: 'brand', render: (v) => v ?? '—' },
    { title: '口径', dataIndex: 'caliber', width: 90 },
    { title: '库房', render: (_, r) => r.warehouse?.name ?? '—' },
    { title: '货位', render: (_, r) => r.location?.name ?? '—' },
    { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag>{v}</Tag> },
  ];
  const mvCols: ColumnsType<Movement> = [
    { title: '表号', dataIndex: 'meterNo', render: (v) => v ?? '—' },
    {
      title: '类型',
      dataIndex: 'movementType',
      width: 110,
      render: (v: string) => <Tag color={MOVE_COLOR[v]}>{MOVE_LABEL[v] ?? v}</Tag>,
    },
    { title: '库房', render: (_, r) => r.warehouse?.name ?? '—' },
    { title: '单据号', dataIndex: 'docNo', render: (v) => v ?? '—' },
    { title: '供应商', dataIndex: 'supplier', render: (v) => v ?? '—' },
    { title: '批次', dataIndex: 'batchNo', render: (v) => v ?? '—' },
    { title: '时间', dataIndex: 'movedAt', render: (v: string) => v.slice(0, 19).replace('T', ' ') },
    { title: '备注', dataIndex: 'remark', render: (v) => v ?? '—' },
  ];

  return (
    <Card
      title="水表库房管理"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void loadAll()} loading={whLoading} />
          <Button onClick={() => setWhModal('warehouse')}>建库房</Button>
          <Button onClick={() => setWhModal('location')}>建货位</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setWhModal('move')}>
            出入库登记
          </Button>
        </Space>
      }
    >
      <Tabs
        items={[
          {
            key: 'stock',
            label: '库存',
            children: (
              <Row gutter={16}>
                <Col span={6}>
                  <Tree
                    treeData={whTree}
                    defaultExpandAll
                    selectedKeys={selWh ? [selWh] : []}
                    onSelect={(keys) => {
                      const k = keys[0] as string | undefined;
                      const isWh = warehouses.some((w) => w.id === k);
                      setSelWh(isWh ? k : undefined);
                      void loadStock(isWh ? k : undefined);
                    }}
                  />
                </Col>
                <Col span={18}>
                  <Table<StockRow> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
                    rowKey="id"
                    size="small"
                    columns={stockCols}
                    dataSource={stockRows}
                    pagination={{ pageSize: 20 }}
                  />
                </Col>
              </Row>
            ),
          },
          {
            key: 'movements',
            label: '出入库流水',
            children: (
              <Table<Movement> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
                rowKey="id"
                size="small"
                columns={mvCols}
                dataSource={movements}
                pagination={{ pageSize: 20 }}
              />
            ),
          },
          {
            key: 'manage',
            label: '库房货位',
            children: (
              <Table<Warehouse> scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
                rowKey="id"
                size="small"
                pagination={false}
                expandable={{
                  expandedRowRender: (w) => (
                    <Table scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
                      rowKey="id"
                      size="small"
                      pagination={false}
                      columns={[
                        { title: '货位编号', dataIndex: 'code', width: 140 },
                        { title: '货位名称', dataIndex: 'name' },
                        {
                          title: '状态',
                          dataIndex: 'status',
                          width: 90,
                          render: (s: string) =>
                            s === 'ACTIVE' ? (
                              <Tag color="green">启用</Tag>
                            ) : (
                              <Tag>停用</Tag>
                            ),
                        },
                        {
                          title: '操作',
                          key: 'op',
                          width: 220,
                          render: (_, l) => (
                            <Space>
                              <Button
                                size="small"
                                onClick={() => openEdit('loc', { whId: w.id, row: l })}
                              >
                                编辑
                              </Button>
                              <Button
                                size="small"
                                onClick={() =>
                                  void toggleLoc(w.id, l.id, l.status === 'ACTIVE')
                                }
                              >
                                {l.status === 'ACTIVE' ? '停用' : '启用'}
                              </Button>
                              <Popconfirm
                                title="删除该货位？（有在库表/流水将被拦截）"
                                onConfirm={() => void delLoc(w.id, l.id)}
                              >
                                <Button size="small" danger>
                                  删除
                                </Button>
                              </Popconfirm>
                            </Space>
                          ),
                        },
                      ]}
                      dataSource={w.locations}
                    />
                  ),
                }}
                columns={[
                  { title: '库房编号', dataIndex: 'code', width: 140 },
                  { title: '库房名称', dataIndex: 'name' },
                  { title: '所属单位', dataIndex: 'owner', render: (v) => v ?? '—' },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    width: 90,
                    render: (s: string) =>
                      s === 'ACTIVE' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>,
                  },
                  {
                    title: '操作',
                    key: 'op',
                    width: 240,
                    render: (_, w) => (
                      <Space>
                        <Button size="small" onClick={() => openEdit('wh', { row: w })}>
                          编辑
                        </Button>
                        <Button
                          size="small"
                          onClick={() => void toggleWh(w.id, w.status === 'ACTIVE')}
                        >
                          {w.status === 'ACTIVE' ? '停用' : '启用'}
                        </Button>
                        <Popconfirm
                          title="删除该库房？（有货位/库存/流水将被拦截）"
                          onConfirm={() => void delWh(w.id)}
                        >
                          <Button size="small" danger>
                            删除
                          </Button>
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]}
                dataSource={warehouses}
              />
            ),
          },
        ]}
      />

      {/* 编辑库房 / 货位（X1） */}
      <Modal
        title={editing?.kind === 'wh' ? '编辑库房' : '编辑货位'}
        open={editing !== null}
        onOk={() => void saveEdit()}
        onCancel={() => setEditing(null)}
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical">
          <Form.Item label="编号（不可改）">
            <Input value={editing?.row.code} disabled />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请填名称' }]}>
            <Input />
          </Form.Item>
          {editing?.kind === 'wh' && (
            <Form.Item name="owner" label="所属单位">
              <Input />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* 建库房 */}
      <Modal
        title="建库房"
        open={whModal === 'warehouse'}
        onOk={() => void onCreateWarehouse()}
        onCancel={() => setWhModal(null)}
        destroyOnHidden
      >
        <Form form={whForm} layout="vertical">
          <Form.Item name="code" label="库房编号" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="name" label="库房名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="owner" label="所属单位">
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      {/* 建货位 */}
      <Modal
        title="建货位"
        open={whModal === 'location'}
        onOk={() => void onCreateLocation()}
        onCancel={() => setWhModal(null)}
        destroyOnHidden
      >
        <Form form={locForm} layout="vertical">
          <Form.Item name="warehouseId" label="库房" rules={[{ required: true }]}>
            <Select options={whOptions} />
          </Form.Item>
          <Form.Item name="code" label="货位编号" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="name" label="货位名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      {/* 出入库登记 */}
      <Modal
        title="出入库登记"
        open={whModal === 'move'}
        onOk={() => void onMove()}
        onCancel={() => setWhModal(null)}
        destroyOnHidden
        width={560}
      >
        <Form form={mvForm} layout="vertical">
          <Form.Item name="type" label="类型" rules={[{ required: true }]}>
            <Select
              options={Object.entries(MOVE_LABEL).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
          {mvType === 'PURCHASE_IN' ? (
            <>
              <Form.Item
                name="meterNos"
                label="新表号（批量录入，回车分隔）"
                rules={[{ required: true, message: '至少录入一个新表号' }]}
                extra="表号与全局档案池比对，重号整单拒绝。"
              >
                <Select
                  mode="tags"
                  open={false}
                  suffixIcon={null}
                  placeholder="输入表号后回车，如 YS202610-001"
                  tokenSeparators={[',', '，', ' ', '\n']}
                />
              </Form.Item>
              <Space.Compact block>
                <Form.Item name="brand" label="品牌" style={{ flex: 1 }}>
                  <Input placeholder="同批统一品牌" />
                </Form.Item>
                <Form.Item name="model" label="型号" style={{ flex: 1 }}>
                  <Input />
                </Form.Item>
                <Form.Item name="caliber" label="口径" style={{ flex: 1 }}>
                  <Input placeholder="DN15（自动带检定周期）" />
                </Form.Item>
              </Space.Compact>
            </>
          ) : (
            <Form.Item
              name="meterIds"
              label={
                mvType === 'RETURN_IN'
                  ? '已出库水表（可多选）'
                  : mvType === 'TRANSFER'
                    ? '调拨水表（在库，可多选）'
                    : mvType === 'SCRAP_OUT'
                      ? '报废水表（未装表，可多选）'
                      : '在库水表（可多选）'
              }
              rules={[{ required: true }]}
            >
              <Select
                mode="multiple"
                optionLabelProp="label"
                showSearch
                filterOption={false}
                onSearch={candidateSearch}
                options={candidates.map((m) => ({
                  value: m.id,
                  label: `${m.meterNo}${m.warehouse ? ` · ${m.warehouse.name}` : ''}`,
                }))}
                placeholder={
                  mvType === 'RETURN_IN'
                    ? '选择已领用/在途的水表'
                    : '选择在库水表'
                }
                notFoundContent="该类型无可选水表"
              />
            </Form.Item>
          )}
          {mvType !== 'ISSUE_OUT' && mvType !== 'SCRAP_OUT' && (
            <>
              <Form.Item name="warehouseId" label="目标库房" rules={[{ required: true }]}>
                <Select options={whOptions} />
              </Form.Item>
              <Form.Item
                noStyle
                shouldUpdate={(a, b) => a.warehouseId !== b.warehouseId}
              >
                {() => (
                  <Form.Item name="locationId" label="货位">
                    <Select allowClear options={locOptions(mvForm.getFieldValue('warehouseId'))} />
                  </Form.Item>
                )}
              </Form.Item>
            </>
          )}
          {mvType === 'PURCHASE_IN' && (
            <>
              <Form.Item name="supplier" label="供应商" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="batchNo" label="批次号" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </>
          )}
          <Form.Item name="docNo" label="单据号">
            <Input placeholder="采购单/领用单/退库单号" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

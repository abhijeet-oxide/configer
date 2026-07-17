import {
  Alert,
  App as AntApp,
  Input,
  Modal,
  Select,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { SearchOutlined, LinkOutlined, FileTextOutlined } from "../icons";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, bindingsOf, primaryBinding, type Grid, type Parameter, type ScanCandidate } from "../api";
import { fmtValue } from "../rules";

// PathPicker is the interactive attach flow: the user never hunts for a
// JSONPath or XPath. Pick a configuration file, see the settings it contains
// with their live values, click the one you mean; the path is mapped
// automatically. Used to complete a design-phase parameter and to re-map an
// attached one (e.g. after a file was renamed on Git).

export default function PathPicker({
  open,
  onClose,
  param,
  grid,
}: {
  open: boolean;
  onClose: () => void;
  param: Parameter;
  grid: Grid;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const scanQ = useQuery({
    queryKey: ["scan-picker"],
    queryFn: api.scan,
    enabled: open,
    staleTime: 30_000,
  });
  const [file, setFile] = useState<string | null>(null);
  const [q, setQ] = useState("");

  // Paths already claimed by another parameter: two parameters writing the
  // same key would fight over it, so those rows are shown but not selectable.
  const usedBy = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of grid.rows) {
      if (r.param.id === param.id) continue;
      for (const b of bindingsOf(r.param)) m.set(`${b.file}|${b.path}`, r.param.name);
    }
    return m;
  }, [grid.rows, param.id]);

  const files = scanQ.data?.files ?? [];
  // note: a design-phase parameter has an EMPTY source file, so fall through
  const activeFile = file || primaryBinding(param).file || files[0]?.file || null;
  const current = files.find((f) => f.file === activeFile);
  const needle = q.trim().toLowerCase();
  const cands = (current?.candidates ?? []).filter(
    (c) =>
      !needle ||
      c.name.toLowerCase().includes(needle) ||
      c.path.toLowerCase().includes(needle) ||
      fmtValue(c.value).toLowerCase().includes(needle),
  );

  const attach = useMutation({
    mutationFn: (c: ScanCandidate) =>
      api.updateParameter(param.id, {
        bindings: [{ file: c.file, path: c.path, format: c.format }],
        author: "demo-user",
      }),
    onSuccess: (p) => {
      message.success(
        `${p.name} is now attached to ${primaryBinding(p).file}. Edits write back into the file from here on (committed to Git).`,
        6,
      );
      qc.invalidateQueries();
      onClose();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const isDesign = !primaryBinding(param).file;

  return (
    <Modal
      title={
        <>
          <LinkOutlined /> {isDesign ? "Attach" : "Re-map"} <span className="mono">{param.name}</span>
        </>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={760}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>
        Pick the configuration file, then click the setting this parameter should live at; the
        path is mapped for you. One commit updates the catalog
        {isDesign ? ", and values you already set start rendering immediately." : "."}
      </Typography.Paragraph>
      <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
        <Select
          style={{ flex: 1 }}
          loading={scanQ.isLoading}
          value={activeFile ?? undefined}
          placeholder="Choose a configuration file"
          showSearch
          filterOption={(input, opt) => String(opt?.value ?? "").toLowerCase().includes(input.toLowerCase())}
          onChange={(v) => setFile(v)}
          options={files.map((f) => ({
            value: f.file,
            label: (
              <span>
                <FileTextOutlined style={{ opacity: 0.6, marginInlineEnd: 6 }} />
                <span className="mono">{f.file}</span>
                <span style={{ opacity: 0.5, fontSize: 12, marginInlineStart: 8 }}>
                  {f.candidates?.length ?? 0} settings
                </span>
              </span>
            ),
          }))}
        />
        <Input
          style={{ width: 220 }}
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Filter settings"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {!isDesign && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 10 }}
          message={
            <>
              Currently attached to <span className="mono">{primaryBinding(param).file}</span> at{" "}
              <span className="mono">{primaryBinding(param).path}</span>. Selecting a new spot re-points it.
            </>
          }
        />
      )}
      <Table<ScanCandidate>
        size="small"
        rowKey={(c) => `${c.file}|${c.path}`}
        loading={scanQ.isLoading}
        dataSource={cands}
        pagination={cands.length > 12 ? { pageSize: 12, size: "small" } : false}
        onRow={(c) => {
          const owner = usedBy.get(`${c.file}|${c.path}`);
          const isCurrent = c.file === primaryBinding(param).file && c.path === primaryBinding(param).path;
          return {
            onClick: () => {
              if (owner || isCurrent || attach.isPending) return;
              Modal.confirm({
                title: `Attach ${param.name} here?`,
                content: (
                  <span>
                    <span className="mono">{c.path}</span> in <span className="mono">{c.file}</span>{" "}
                    (current value: <span className="mono">{fmtValue(c.value)}</span>)
                  </span>
                ),
                okText: "Attach",
                onOk: () => attach.mutate(c),
              });
            },
            style: { cursor: owner || isCurrent ? "not-allowed" : "pointer", opacity: owner ? 0.55 : 1 },
          };
        }}
        columns={[
          {
            title: "Setting",
            render: (_v, c) => <span className="mono">{c.name}</span>,
          },
          {
            title: "Path (mapped for you)",
            render: (_v, c) => (
              <span className="mono" style={{ fontSize: 11, opacity: 0.65 }}>{c.path}</span>
            ),
          },
          {
            title: "Current value",
            width: 160,
            render: (_v, c) => <span className="mono">{fmtValue(c.value)}</span>,
          },
          {
            title: "",
            width: 150,
            render: (_v, c) => {
              const owner = usedBy.get(`${c.file}|${c.path}`);
              if (c.file === primaryBinding(param).file && c.path === primaryBinding(param).path)
                return <Tag color="blue">current mapping</Tag>;
              if (owner)
                return (
                  <Tooltip title={`Already managed by ${owner}; a path can belong to one parameter.`}>
                    <Tag>managed by {owner}</Tag>
                  </Tooltip>
                );
              return <Typography.Link>Attach here</Typography.Link>;
            },
          },
        ]}
      />
    </Modal>
  );
}

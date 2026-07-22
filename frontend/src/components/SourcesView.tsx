import {
  Button,
  Card,
  Checkbox,
  Empty,
  List,
  Popconfirm,
  Space,
  Tag,
  Tooltip,
  Typography,
  App as AntApp,
} from "antd";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Source, type IncomingChange } from "../api";
import { PlusOutlined, ReloadOutlined, LinkOutlined, DeleteOutlined, CheckOutlined, EyeOutlined } from "../icons";
import { sourceIcon, sourceHex } from "./sourceVisual";
import AddSourceModal from "./AddSourceModal";
import MapSourceModal from "./MapSourceModal";
import SourceDetailDrawer from "./SourceDetailDrawer";
import { useUI } from "../store";

// SourcesView is the application's "Sources" tab: the external systems that
// feed parameter values (another Git repo, a secret store), the values they
// currently expose, and the incoming changes a reviewer accepts into the draft.
// It reuses the whole change/draft/submit machinery: accepting an incoming
// change stages an ordinary edit that is submitted like any other.
export default function SourcesView() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const setSection = useUI((s) => s.setSection);
  const [adding, setAdding] = useState(false);
  const [mapping, setMapping] = useState(false);
  const [detail, setDetail] = useState<Source | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const sourcesQ = useQuery({ queryKey: ["sources"], queryFn: api.sources });
  const incomingQ = useQuery({ queryKey: ["sources", "incoming"], queryFn: api.incomingChanges, retry: false });
  const gridQ = useQuery({ queryKey: ["grid"], queryFn: api.grid, staleTime: 10_000 });

  const params = useMemo(() => (gridQ.data?.rows ?? []).map((r) => ({ id: r.param.id, name: r.param.name })), [gridQ.data]);
  const instances = useMemo(() => (gridQ.data?.instances ?? []).map((i) => ({ name: i.name })), [gridQ.data]);

  const refresh = useMutation({
    mutationFn: () => api.refreshSources(),
    onSuccess: (r) => {
      const failed = r.sources.filter((s) => !s.ok);
      if (failed.length) message.warning(`${failed.length} source(s) could not be read`);
      else message.success("Sources refreshed");
      qc.invalidateQueries({ queryKey: ["sources"] });
    },
    onError: (e: unknown) => message.error(e instanceof Error ? e.message : "Could not refresh sources"),
  });

  const changes = incomingQ.data?.changes ?? [];
  const selectedKeys = Object.keys(selected).filter((k) => selected[k]);

  const accept = useMutation({
    mutationFn: () => {
      const picked = changes.filter((c) => selected[changeKey(c)]);
      const target = picked.length ? picked : changes;
      return api.acceptIncoming(target.map((c) => ({ paramId: c.paramId, instance: c.instance })));
    },
    onSuccess: (r) => {
      message.success(`${r.staged} change(s) added to the draft`);
      setSelected({});
      qc.invalidateQueries();
    },
    onError: (e: unknown) => message.error(e instanceof Error ? e.message : "Could not accept the changes"),
  });

  const sources = sourcesQ.data ?? [];

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Sources
          </Typography.Title>
          <Typography.Text type="secondary">
            Pull parameter values from outside this repository and review them before they land.
          </Typography.Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} loading={refresh.isPending} onClick={() => refresh.mutate()}>
            Refresh
          </Button>
          <Button icon={<LinkOutlined />} disabled={!sources.length} onClick={() => setMapping(true)}>
            Map parameter
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
            Add source
          </Button>
        </Space>
      </div>

      {/* Incoming changes: the reviewer's queue. Only meaningful once at least
          one source is configured - with no sources there is nothing to reconcile
          against, so we skip it entirely and show the single "no sources" empty
          state below rather than two stacked empty states. */}
      {sources.length > 0 && (
      <Card
        size="small"
        style={{ marginBottom: 16 }}
        title={
          <span>
            Incoming changes {changes.length > 0 && <Tag color="blue">{changes.length}</Tag>}
          </span>
        }
        extra={
          changes.length > 0 && (
            <Button
              type="primary"
              size="small"
              icon={<CheckOutlined />}
              loading={accept.isPending}
              onClick={() => accept.mutate()}
            >
              {selectedKeys.length ? `Add ${selectedKeys.length} to draft` : "Add all to draft"}
            </Button>
          )
        }
      >
        {changes.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              incomingQ.isError
                ? "Could not read one or more sources. Check the source configuration."
                : "No incoming changes. Mapped parameters match their sources."
            }
          />
        ) : (
          <List
            size="small"
            dataSource={changes}
            renderItem={(c) => (
              <List.Item
                actions={[
                  <Tooltip title="Jump to this parameter" key="go">
                    <Button
                      type="text"
                      size="small"
                      icon={<EyeOutlined />}
                      onClick={() => {
                        useUI.getState().selectParam(c.paramId);
                        if (c.instance) useUI.getState().selectInstance(c.instance);
                        setSection("config");
                      }}
                    />
                  </Tooltip>,
                ]}
              >
                <Checkbox
                  checked={!!selected[changeKey(c)]}
                  onChange={(e) => setSelected((s) => ({ ...s, [changeKey(c)]: e.target.checked }))}
                  style={{ marginRight: 10 }}
                />
                <List.Item.Meta
                  title={
                    <span>
                      <Typography.Text strong>{c.paramName}</Typography.Text>{" "}
                      {c.instance ? <Tag>{c.instance}</Tag> : <Tag color="geekblue">all</Tag>}
                      {c.secret && <Tag color="gold">secret</Tag>}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        from {c.sourceName}
                      </Typography.Text>
                    </span>
                  }
                  description={
                    <span style={{ fontSize: 12 }}>
                      <Typography.Text delete type="secondary">
                        {fmt(c.current)}
                      </Typography.Text>{" "}
                      <span style={{ color: "var(--c-ok)" }}>→ {fmt(c.incoming)}</span>
                    </span>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Card>
      )}

      {/* Configured sources. */}
      {sources.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No sources yet. Add one to pull values from another repository or a secret store."
        >
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
            Add source
          </Button>
        </Empty>
      ) : (
        <List
          grid={{ gutter: 16, column: 2 }}
          dataSource={sources}
          renderItem={(s) => <SourceCard source={s} onOpen={() => setDetail(s)} onDelete={() => qc.invalidateQueries()} />}
        />
      )}

      <AddSourceModal open={adding} onClose={() => setAdding(false)} />
      <MapSourceModal
        open={mapping}
        onClose={() => setMapping(false)}
        sources={sources}
        params={params}
        instances={instances}
      />
      <SourceDetailDrawer
        source={detail}
        onClose={() => setDetail(null)}
        params={params}
        instances={instances}
        sources={sources}
      />
    </div>
  );
}

function SourceCard({ source, onOpen, onDelete }: { source: Source; onOpen: () => void; onDelete: () => void }) {
  const { message } = AntApp.useApp();
  const del = useMutation({
    mutationFn: () => api.deleteSource(source.id),
    onSuccess: () => {
      message.success("Source removed");
      onDelete();
    },
    onError: (e: unknown) => message.error(e instanceof Error ? e.message : "Could not remove the source"),
  });
  const hex = sourceHex(colorForSource(source));
  return (
    <List.Item>
      <Card
        size="small"
        hoverable
        onClick={onOpen}
        actions={[
          <span key="view" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
            <EyeOutlined /> View
          </span>,
          <Popconfirm
            key="del"
            title="Remove this source?"
            description="Parameters mapped to it keep their reference until re-mapped."
            onConfirm={() => del.mutate()}
            onCancel={(e) => e?.stopPropagation()}
          >
            <span onClick={(e) => e.stopPropagation()}>
              <DeleteOutlined /> Remove
            </span>
          </Popconfirm>,
        ]}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span
            style={{
              display: "inline-flex",
              width: 40,
              height: 40,
              borderRadius: 10,
              alignItems: "center",
              justifyContent: "center",
              fontSize: 20,
              color: hex,
              background: `color-mix(in srgb, ${hex} 14%, transparent)`,
            }}
          >
            {sourceIcon(iconForSource(source))}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              {source.name}
              {source.secret && <Tag color="gold">secret</Tag>}
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
              {source.pluginName ?? source.kind}
              {source.config?.repoUrl ? ` · ${source.config.repoUrl}` : ""}
              {source.config?.address ? ` · ${source.config.address}` : ""}
            </Typography.Text>
            <div style={{ marginTop: 4 }}>
              <Tag>{source.mappedParams ?? 0} mapped</Tag>
            </div>
          </div>
        </div>
      </Card>
    </List.Item>
  );
}

// changeKey uniquely identifies one incoming change (param + instance).
function changeKey(c: IncomingChange): string {
  return `${c.paramId} ${c.instance ?? ""}`;
}

function fmt(v: unknown): string {
  if (v == null) return "(unset)";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// icon/color hints: the DTO does not carry the plugin's manifest, so fall back
// to the kind when the source-plugin styling is not otherwise available.
function iconForSource(s: Source): string {
  return s.kind;
}
function colorForSource(s: Source): string {
  return s.kind === "git" ? "orange" : s.kind === "vault" ? "gold" : "blue";
}

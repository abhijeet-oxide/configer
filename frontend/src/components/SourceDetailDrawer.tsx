import { Drawer, Tabs, Table, Tag, Button, Typography, Breadcrumb, List, Space, Descriptions, App as AntApp } from "antd";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Source } from "../api";
import { LinkOutlined, FolderOutlined, FileOutlined, CheckOutlined } from "../icons";
import MapSourceModal from "./MapSourceModal";
import { sourceIcon, sourceHex } from "./sourceVisual";

// SourceDetailDrawer is the "view inside a source" page: its connection
// details, the key/value pairs it currently exposes (secrets masked), a folder
// browser to point it at a different file/path, and a shortcut to map any key
// onto a managed parameter.
export default function SourceDetailDrawer({
  source,
  onClose,
  params,
  instances,
  sources,
}: {
  source: Source | null;
  onClose: () => void;
  params: { id: string; name: string }[];
  instances: { name: string }[];
  sources: Source[];
}) {
  const [mapKey, setMapKey] = useState<string | null>(null);
  const hex = sourceHex(source?.kind === "git" ? "orange" : source?.kind === "vault" ? "gold" : "blue");

  return (
    <Drawer
      title={
        source && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: hex }}>{sourceIcon(source.kind)}</span>
            {source.name}
            {source.secret && <Tag color="gold">secret</Tag>}
          </span>
        )
      }
      open={!!source}
      onClose={onClose}
      width={640}
      destroyOnClose
    >
      {source && (
        <>
          <Descriptions size="small" column={1} style={{ marginBottom: 16 }}>
            <Descriptions.Item label="Plugin">{source.pluginName ?? source.kind}</Descriptions.Item>
            {Object.entries(source.config ?? {}).map(([k, v]) => (
              <Descriptions.Item key={k} label={k}>
                <Typography.Text code>{v}</Typography.Text>
              </Descriptions.Item>
            ))}
          </Descriptions>
          <Tabs
            items={[
              { key: "contents", label: "Contents", children: <ContentsTab source={source} onMap={setMapKey} /> },
              { key: "browse", label: "Browse", children: <BrowseTab source={source} /> },
            ]}
          />
          <MapSourceModal
            open={!!mapKey}
            onClose={() => setMapKey(null)}
            sources={sources}
            params={params}
            instances={instances}
            preSourceId={source.id}
            preKey={mapKey ?? undefined}
          />
        </>
      )}
    </Drawer>
  );
}

function ContentsTab({ source, onMap }: { source: Source; onMap: (key: string) => void }) {
  const q = useQuery({
    queryKey: ["sources", source.id, "contents"],
    queryFn: () => api.sourceContents(source.id),
    retry: false,
  });
  if (q.isError) return <Typography.Text type="danger">Could not read the source. Check its configuration.</Typography.Text>;
  return (
    <Table
      size="small"
      rowKey="key"
      loading={q.isFetching}
      pagination={false}
      dataSource={q.data?.values ?? []}
      columns={[
        { title: "Key", dataIndex: "key", render: (k: string) => <Typography.Text code>{k}</Typography.Text> },
        {
          title: "Value",
          dataIndex: "value",
          render: (v: unknown, row) =>
            row.secret ? <Tag color="gold">masked</Tag> : <Typography.Text>{String(v)}</Typography.Text>,
        },
        {
          title: "",
          key: "map",
          width: 90,
          render: (_: unknown, row) => (
            <Button size="small" icon={<LinkOutlined />} onClick={() => onMap(row.key)}>
              Map
            </Button>
          ),
        },
      ]}
    />
  );
}

function BrowseTab({ source }: { source: Source }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [path, setPath] = useState("");
  const q = useQuery({
    queryKey: ["sources", source.id, "browse", path],
    queryFn: () => api.browseSource(source.id, path),
    retry: false,
  });

  const setAsPath = useMutation({
    mutationFn: (p: string) => api.updateSource(source.id, { config: { ...(source.config ?? {}), path: p } }),
    onSuccess: () => {
      message.success("Source path updated");
      qc.invalidateQueries({ queryKey: ["sources"] });
    },
    onError: (e: unknown) => message.error(e instanceof Error ? e.message : "Could not update the source"),
  });

  const crumbs = path ? path.split("/") : [];
  return (
    <div>
      <Space style={{ marginBottom: 8, width: "100%", justifyContent: "space-between" }}>
        <Breadcrumb
          items={[
            { title: <a onClick={() => setPath("")}>root</a> },
            ...crumbs.map((seg, i) => ({
              title: <a onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}>{seg}</a>,
            })),
          ]}
        />
        <Button size="small" icon={<CheckOutlined />} loading={setAsPath.isPending} onClick={() => setAsPath.mutate(path)}>
          Use this path
        </Button>
      </Space>
      {q.isError ? (
        <Typography.Text type="danger">Could not browse the source.</Typography.Text>
      ) : (
        <List
          size="small"
          loading={q.isFetching}
          dataSource={q.data?.entries ?? []}
          locale={{ emptyText: "Nothing here" }}
          renderItem={(e) => (
            <List.Item
              actions={
                e.isDir
                  ? undefined
                  : [
                      <Button key="use" size="small" onClick={() => setAsPath.mutate(e.path)}>
                        Use file
                      </Button>,
                    ]
              }
            >
              <span
                style={{ cursor: e.isDir ? "pointer" : "default", display: "inline-flex", alignItems: "center", gap: 8 }}
                onClick={() => e.isDir && setPath(e.path)}
              >
                {e.isDir ? <FolderOutlined /> : <FileOutlined />}
                {e.name}
              </span>
            </List.Item>
          )}
        />
      )}
    </div>
  );
}

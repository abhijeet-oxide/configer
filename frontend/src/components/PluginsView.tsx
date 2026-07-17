import { useQuery } from "@tanstack/react-query";
import { Card, List, Tag, Typography } from "antd";
import { ApiOutlined } from "../icons";
import { api } from "../api";
import { PluginsSkeleton } from "./Skeletons";

const kindColor: Record<string, string> = {
  "ingest-parser": "blue",
  "schema-importer": "purple",
  transposer: "green",
  validator: "gold",
  "ai-provider": "magenta",
};

// Plugins view: lists the registered extension points (parsers, transposers,
// etc.) to make the plug-and-play architecture visible and configurable.
export default function PluginsView() {
  const q = useQuery({ queryKey: ["plugins"], queryFn: api.plugins });
  if (q.isLoading) return <PluginsSkeleton />;
  return (
    <div style={{ padding: 24, overflow: "auto", height: "100%" }}>
      <Typography.Title level={4}><ApiOutlined /> Plugins</Typography.Title>
      <Typography.Paragraph type="secondary">
        Everything Configer does to a repository is a plugin: ingest parsers, schema importers,
        transposers (generate artifacts like Flux manifests), validators, and AI providers.
      </Typography.Paragraph>
      <List
        grid={{ gutter: 16, column: 2 }}
        dataSource={q.data}
        renderItem={(p) => (
          <List.Item>
            <Card size="small" title={p.name} extra={<Tag color={kindColor[p.kind]}>{p.kind}</Tag>}>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}>
                {p.description}
              </Typography.Paragraph>
              <Typography.Text code>{p.id}</Typography.Text>{" "}
              <Typography.Text type="secondary">v{p.version}</Typography.Text>
            </Card>
          </List.Item>
        )}
      />
    </div>
  );
}

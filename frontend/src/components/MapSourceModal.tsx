import { Modal, Select, Form, Typography, Tag, App as AntApp } from "antd";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Source } from "../api";

// MapSourceModal links a managed parameter to a key in an external source. It
// works from either direction: opened from a parameter (paramId preset, pick a
// source + key) or from a source key (sourceId + key preset, pick a parameter).
// Saving writes the mapping; the source value then surfaces as an incoming
// change, never applied silently.
export default function MapSourceModal({
  open,
  onClose,
  sources,
  params,
  instances,
  preParamId,
  preSourceId,
  preKey,
}: {
  open: boolean;
  onClose: () => void;
  sources: Source[];
  params: { id: string; name: string }[];
  instances: { name: string }[];
  preParamId?: string;
  preSourceId?: string;
  preKey?: string;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [paramId, setParamId] = useState<string | undefined>(preParamId);
  const [sourceId, setSourceId] = useState<string | undefined>(preSourceId);
  const [key, setKey] = useState<string | undefined>(preKey);
  const [instance, setInstance] = useState<string | undefined>();

  useEffect(() => {
    if (open) {
      setParamId(preParamId);
      setSourceId(preSourceId);
      setKey(preKey);
      setInstance(undefined);
    }
  }, [open, preParamId, preSourceId, preKey]);

  // Fetch the chosen source's keys so the mapping targets a real value.
  const contentsQ = useQuery({
    queryKey: ["sources", sourceId, "contents"],
    queryFn: () => api.sourceContents(sourceId as string),
    enabled: open && !!sourceId && !preKey,
    retry: false,
  });

  const save = useMutation({
    mutationFn: () =>
      api.mapParamToSource(paramId as string, { sourceId: sourceId as string, key: key as string, instance: instance || undefined }),
    onSuccess: () => {
      message.success("Parameter mapped to source");
      qc.invalidateQueries();
      onClose();
    },
    onError: (e: unknown) => message.error(e instanceof Error ? e.message : "Could not map the parameter"),
  });

  const ready = !!paramId && !!sourceId && !!key;

  return (
    <Modal
      title="Map parameter to a source"
      open={open}
      onCancel={onClose}
      onOk={() => save.mutate()}
      okText="Map"
      okButtonProps={{ disabled: !ready, loading: save.isPending }}
      destroyOnClose
    >
      <Form layout="vertical">
        <Form.Item label="Parameter">
          <Select
            showSearch
            placeholder="Select a parameter"
            value={paramId}
            disabled={!!preParamId}
            onChange={setParamId}
            optionFilterProp="label"
            options={params.map((p) => ({ value: p.id, label: p.name }))}
          />
        </Form.Item>
        <Form.Item label="Source">
          <Select
            placeholder="Select a source"
            value={sourceId}
            disabled={!!preSourceId}
            onChange={(v) => {
              setSourceId(v);
              if (!preKey) setKey(undefined);
            }}
            options={sources.map((s) => ({ value: s.id, label: s.name }))}
          />
        </Form.Item>
        <Form.Item label="Source key" help={preKey ? undefined : "The value inside the source this parameter follows."}>
          {preKey ? (
            <Typography.Text code>{preKey}</Typography.Text>
          ) : (
            <Select
              showSearch
              placeholder={sourceId ? "Select a key" : "Choose a source first"}
              value={key}
              onChange={setKey}
              loading={contentsQ.isFetching}
              optionFilterProp="label"
              notFoundContent={contentsQ.isError ? "Could not read the source" : undefined}
              options={(contentsQ.data?.values ?? []).map((kv) => ({
                value: kv.key,
                label: kv.key,
              }))}
              optionRender={(opt) => {
                const kv = contentsQ.data?.values.find((v) => v.key === opt.value);
                return (
                  <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span>{opt.label}</span>
                    {kv?.secret ? (
                      <Tag color="gold">secret</Tag>
                    ) : (
                      <Typography.Text type="secondary" ellipsis style={{ maxWidth: 160 }}>
                        {String(kv?.value ?? "")}
                      </Typography.Text>
                    )}
                  </span>
                );
              }}
            />
          )}
        </Form.Item>
        <Form.Item label="Instance (optional)" help="Leave blank to apply at the parameter's own scope.">
          <Select
            allowClear
            placeholder="All / parameter scope"
            value={instance}
            onChange={setInstance}
            options={instances.map((i) => ({ value: i.name, label: i.name }))}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

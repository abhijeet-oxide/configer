import {
  Button,
  Input,
  InputNumber,
  Select,
  Switch,
  Space,
  Typography,
  App as AntApp,
} from "antd";
import { SaveOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Parameter, type Validation } from "../api";

// RuleEditor lets users define a parameter's data type and validation rules:
// either custom (pattern, min/max, character limits, enum) or picked from the
// predefined rule library. Saved rules are written to catalog.yaml and
// immediately enforced by every cell editor and by the server on write.

const typeOptions = ["string", "integer", "number", "boolean", "enum", "ipv4", "cidr", "list"].map(
  (t) => ({ value: t, label: t }),
);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        {label}
      </Typography.Text>
      {children}
    </div>
  );
}

export default function RuleEditor({ param }: { param: Parameter }) {
  // key remount resets local state when the selected parameter changes
  return <Editor key={param.id} param={param} />;
}

function Editor({ param }: { param: Parameter }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const presetsQ = useQuery({ queryKey: ["presets"], queryFn: api.presets });

  const [type, setType] = useState(param.type);
  const [v, setV] = useState<Validation>({ ...(param.validation ?? {}) });

  const save = useMutation({
    mutationFn: () => api.updateParameter(param.id, { type, validation: v }),
    onSuccess: () => {
      message.success("Validation rules saved");
      qc.invalidateQueries({ queryKey: ["grid"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const numeric = type === "integer" || type === "number";
  const stringy = type === "string" || type === "ipv4" || type === "cidr";
  const preset = presetsQ.data?.find((p) => p.id === v.preset);

  const patch = (delta: Partial<Validation>) => setV((old) => ({ ...old, ...delta }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Field label="Data type">
        <Select
          size="small"
          value={type}
          options={typeOptions}
          onChange={(t) => setType(t)}
        />
      </Field>

      <Field label="Predefined rule">
        <Select
          size="small"
          allowClear
            placeholder="None (custom rules only)"
          loading={presetsQ.isLoading}
          value={v.preset}
          options={(presetsQ.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
          onChange={(id) => patch({ preset: id || undefined })}
        />
      </Field>
      {preset && (
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {preset.description}
          {preset.pattern && (
            <>
              {" "}· <span className="mono">{preset.pattern}</span>
            </>
          )}
          {preset.min != null && ` · min ${preset.min}`}
          {preset.max != null && ` · max ${preset.max}`}
        </Typography.Text>
      )}

      <Field label="Required">
        <Switch
          size="small"
          style={{ width: 28 }}
          checked={!!v.required}
          onChange={(b) => patch({ required: b || undefined })}
        />
      </Field>

      {numeric && (
        <Space>
          <Field label="Min">
            <InputNumber
              size="small"
              value={v.min}
              onChange={(n) => patch({ min: n ?? undefined })}
            />
          </Field>
          <Field label="Max">
            <InputNumber
              size="small"
              value={v.max}
              onChange={(n) => patch({ max: n ?? undefined })}
            />
          </Field>
        </Space>
      )}

      {stringy && (
        <>
          <Field label="Pattern (regular expression)">
            <Input
              size="small"
              className="mono"
              placeholder="^[a-z0-9-]+$"
              value={v.pattern}
              onChange={(e) => patch({ pattern: e.target.value || undefined })}
            />
          </Field>
          <Space>
            <Field label="Min length">
              <InputNumber
                size="small"
                min={0}
                value={v.minLength}
                onChange={(n) => patch({ minLength: n ?? undefined })}
              />
            </Field>
            <Field label="Max length">
              <InputNumber
                size="small"
                min={0}
                value={v.maxLength}
                onChange={(n) => patch({ maxLength: n ?? undefined })}
              />
            </Field>
          </Space>
        </>
      )}

      {type === "enum" && (
        <Field label="Allowed values">
          <Select
            size="small"
            mode="tags"
            placeholder="Type a value and press Enter"
            value={v.enum}
            onChange={(arr: string[]) => patch({ enum: arr.length ? arr : undefined })}
          />
        </Field>
      )}

      {type === "list" && (
        <Space>
          <Field label="Min entries">
            <InputNumber
              size="small"
              min={0}
              value={v.minItems}
              onChange={(n) => patch({ minItems: n ?? undefined })}
            />
          </Field>
          <Field label="Max entries">
            <InputNumber
              size="small"
              min={0}
              value={v.maxItems}
              onChange={(n) => patch({ maxItems: n ?? undefined })}
            />
          </Field>
        </Space>
      )}

      <Button
        type="primary"
        size="small"
        icon={<SaveOutlined />}
        loading={save.isPending}
        onClick={() => save.mutate()}
      >
        Save rules
      </Button>
    </div>
  );
}

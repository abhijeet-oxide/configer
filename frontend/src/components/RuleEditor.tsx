import {
  Button,
  Input,
  InputNumber,
  Select,
  Switch,
  Space,
  Tooltip,
  Typography,
  App as AntApp,
} from "antd";
import { CloseOutlined, EditOutlined, RegexOutlined, SaveOutlined } from "../icons";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRepoQuery } from "../repoQuery";
import { api, type Parameter, type Validation } from "../api";
import { describeSpans } from "../rules";
import { useIdentity } from "../identity";

// RuleEditor lets users define a parameter's data type and validation rules:
// either custom (pattern, min/max, character limits, enum) or picked from the
// predefined rule library.
//
// Two things about how it saves, and both were wrong before.
//
// The Save button was always there, and always pressable, whether or not
// anything had been touched - so "did I change something?" was a question the
// screen could not answer and pressing it was how you found out. Now the bar
// appears when a rule really differs from what the catalog says, names what
// moved, and offers Cancel beside Save; putting a field back the way it was
// makes it go away again.
//
// And the save STAGES. A validation rule decides what everybody else may type
// into a cell - it is exactly the sort of change a second person should see -
// and writing it straight to the working branch was also simply impossible
// anywhere the repository protects its default branch: the push was refused,
// and it was refused after this form had said the rules were saved.

const typeOptions = [
  "string",
  "integer",
  "number",
  "boolean",
  "enum",
  "ipv4",
  "ipv6",
  "cidr",
  "hostname",
  "port",
  "email",
  "url",
  "mac",
  "cpu",
  "memory",
  "duration",
  "percentage",
  "list",
].map((t) => ({ value: t, label: t }));

/** What each validation field is called in this form, so the save bar names
 *  what the reader typed into rather than the key behind it. */
const RULE_LABELS: Partial<Record<keyof Validation, string>> = {
  required: "required",
  min: "minimum",
  max: "maximum",
  pattern: "pattern",
  minLength: "minimum length",
  maxLength: "maximum length",
  enum: "allowed values",
  minItems: "minimum entries",
  maxItems: "maximum entries",
};

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

function formatDefault(value: unknown): string {
  if (value === undefined || value === null) return "none";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// What the release's own schema states about this parameter, above the editor
// and separate from it.
//
// The editable fields below carry the rules the product ENFORCES. A schema also
// states things no single value can be checked against - a condition about its
// neighbours, a uniqueness requirement, alternatives of a union, disjoint
// ranges - and those must still be readable: a constraint nobody can see is
// worse than one the product admits it does not police. They are shown as facts
// with their source named, never as controls, because editing them here would
// only put the catalog at odds with the model on disk.
function FromSchema({ v }: { v: Validation }) {
  const extras = v.patterns ?? [];
  const constraints = v.constraints ?? [];
  const document = v.schemaRef?.split("/").pop();
  // The rules the schema states that the editable fields below cannot carry,
  // and that ARE checked: alternatives of a union, named flags, disjoint spans,
  // an inverted pattern, a decimal precision. They read as facts because that
  // is what they are - the vendor's, not the product's - and because editing
  // them here would only put the catalog at odds with the model on disk.
  const enforced: string[] = [];
  if (v.anyOf?.length) {
    enforced.push(`Must be one of: ${v.anyOf.map((a) => a.label || a.type || "a value").join(", ")}`);
  }
  if (v.bits?.length) enforced.push(`Any combination of: ${v.bits.join(", ")}`);
  if (v.ranges && v.ranges.length > 1) enforced.push(`Must be ${describeSpans(v.ranges)}`);
  if (v.lengths && v.lengths.length > 1) {
    enforced.push(`Length must be ${describeSpans(v.lengths)} characters`);
  }
  for (const p of v.notPatterns ?? []) enforced.push(`Must not match ${p}`);
  if (v.maxDecimals != null) {
    enforced.push(
      v.maxDecimals === 0
        ? "Whole numbers only"
        : `At most ${v.maxDecimals} decimal place${v.maxDecimals === 1 ? "" : "s"}`,
    );
  }
  const hasFacts = !!v.units || !!v.errorMessage || extras.length > 0 || enforced.length > 0;
  return (
    <div className="cf-schema-note">
      <div className="cf-schema-note-head">
        <RegexOutlined />
        <span>Rules detected in release schema</span>
        <Tooltip title={v.schemaRef}>
          <span className="cf-schema-note-file mono">{document}</span>
        </Tooltip>
      </div>

      {/* The model says this value is reported by the device rather than set.
          Saying so is the difference between "you may not edit this" and a
          cell that quietly refuses to respond. */}
      {v.readOnly && (
        <div className="cf-schema-note-facts">
          <span>
            <b>Reported by the device.</b> This value is state, not configuration: it is shown here
            and never written back.
          </span>
        </div>
      )}

      {hasFacts && (
        <div className="cf-schema-note-facts">
          {v.units && (
            <span>
              Measured in <b>{v.units}</b>
            </span>
          )}
          {v.errorMessage && <span>{v.errorMessage}</span>}
          {enforced.map((e) => (
            <span key={e}>{e}</span>
          ))}
          {extras.map((p) => (
            <span key={p}>
              Must also match <b className="mono">{p}</b>
            </span>
          ))}
        </div>
      )}

      {constraints.length > 0 && (
        <ul className="cf-schema-note-list">
          {constraints.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function RuleEditor({
  param,
  onEditDefault,
}: {
  param: Parameter;
  /** open the one form that owns the default. Without it the field here is a
   *  dead end: a value the reader can see, cannot change, and is given no way
   *  to find the place that can. */
  onEditDefault?: () => void;
}) {
  // key remount resets local state when the selected parameter changes
  return <Editor key={param.id} param={param} onEditDefault={onEditDefault} />;
}

function Editor({ param, onEditDefault }: { param: Parameter; onEditDefault?: () => void }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const { canEdit } = useIdentity();
  const presetsQ = useRepoQuery({ queryKey: ["presets"], queryFn: api.presets });

  const committed = useMemo<Validation>(() => ({ ...(param.validation ?? {}) }), [param.validation]);
  const [type, setType] = useState(param.type);
  const [v, setV] = useState<Validation>(committed);
  // The parameter changes underneath after a save (the grid comes back carrying
  // the staged rules), and the form has to agree with it then rather than keep
  // offering to save what it already said.
  useEffect(() => {
    setType(param.type);
    setV(committed);
  }, [param.type, committed]);

  // What actually differs, named the way the fields are labelled. "Unsaved
  // changes" is the sentence that makes somebody press Cancel to find out what
  // they were.
  const changed = useMemo(() => {
    const out: string[] = [];
    if (type !== param.type) out.push("data type");
    const keys = new Set([...Object.keys(committed), ...Object.keys(v)]) as Set<keyof Validation>;
    for (const k of keys) {
      if (k === "preset") {
        if (v.preset !== committed.preset) out.push("predefined rule");
        continue;
      }
      if (JSON.stringify(v[k] ?? null) !== JSON.stringify(committed[k] ?? null)) out.push(RULE_LABELS[k] ?? String(k));
    }
    return [...new Set(out)];
  }, [type, param.type, v, committed]);
  const dirty = changed.length > 0;

  const save = useMutation({
    mutationFn: () => api.updateParameter(param.id, { type, validation: v }),
    onSuccess: () => {
      message.success("Staged in your draft: submit it for review to apply these rules");
      qc.invalidateQueries({ queryKey: ["grid"] });
      qc.invalidateQueries({ queryKey: ["draft"] });
      qc.invalidateQueries({ queryKey: ["changes"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const numeric = type === "integer" || type === "number" || type === "port";
  const stringy =
    type === "string" ||
    type === "ipv4" ||
    type === "ipv6" ||
    type === "cidr" ||
    type === "hostname" ||
    type === "email" ||
    type === "url" ||
    type === "mac";
  const preset = presetsQ.data?.find((p) => p.id === v.preset);

  const patch = (delta: Partial<Validation>) => setV((old) => ({ ...old, ...delta }));

  return (
    // A fieldset, because `disabled` on one natively disables every control
    // inside it: a viewer reads the same rules and simply cannot type into
    // them. One form, disabled, rather than a second read-only rendering of the
    // same nine fields - which is how two descriptions of one rule drift apart.
    <fieldset
      className="cf-rules"
      disabled={!canEdit}
      style={{ display: "flex", flexDirection: "column", gap: 10, border: 0, padding: 0, margin: 0, minInlineSize: 0 }}
    >
      {v.schemaRef && <FromSchema v={v} />}

      <Field label="Data type">
        <Select
          size="small"
          value={type}
          options={typeOptions}
          onChange={(t) => setType(t)}
        />
      </Field>

      {/* What the value is when no file carries it - part of the answer to
          "what may this be", so it is read here rather than only on Overview.
          It is not EDITED here: one field edited from two forms is one field
          two forms can disagree about. But a value you can see and cannot
          change, with nothing on screen saying where you could, is worse than
          either - so the field carries the way to the form that owns it. */}
      <Field label="Default value">
        <Space size={6}>
          <Typography.Text
            className="mono"
            type={param.default == null ? "secondary" : undefined}
            style={{ fontSize: 12 }}
          >
            {formatDefault(param.default)}
          </Typography.Text>
          {onEditDefault && (
            <Tooltip title="Change it on the Overview tab, where the parameter's other metadata is edited">
              <Button
                size="small"
                type="link"
                icon={<EditOutlined />}
                style={{ padding: 0, height: "auto" }}
                onClick={onEditDefault}
              />
            </Tooltip>
          )}
        </Space>
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

      {dirty && canEdit && (
        <div className="cf-savebar">
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {changed.length} unsaved: {changed.join(", ")}
          </Typography.Text>
          <Space size={6}>
            <Button
              size="small"
              icon={<CloseOutlined />}
              onClick={() => {
                setType(param.type);
                setV(committed);
              }}
            >
              Cancel
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<SaveOutlined />}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              Save all
            </Button>
          </Space>
        </div>
      )}
    </fieldset>
  );
}

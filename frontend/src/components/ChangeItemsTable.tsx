import { Table, Tag, Tooltip, Button, Typography, Empty } from "antd";
import { ArrowRightOutlined, DeleteOutlined } from "../icons";
import { describeChange, type ChangeDesc, type ChangeTone } from "../changedesc";
import type { ChangeItem } from "../api";

// ChangeItemsTable is the ONE way a draft's individual edits are shown, so the
// review modal, the change-request history and the approvals detail all read
// identically. Each row leads with a plain-language type tag, names its
// subject (a parameter, an instance, or a file) and then says what changed -
// with a before -> after only where a value actually moved. Structural changes
// (adding, retiring or re-settings an instance; a direct file edit) get a
// sentence instead of being forced into before/after columns.

const TONE: Record<ChangeTone, string> = {
  ok: "green",
  review: "blue",
  pending: "orange",
  danger: "red",
  neutral: "default",
};

// The "what changed" cell: a real before -> after for value moves, the
// inherited/removed note for reset+exclude, or a plain sentence for structural
// changes.
function Detail({ d }: { d: ChangeDesc }) {
  if (d.before !== undefined && d.after !== undefined) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span className="mono" style={{ opacity: 0.6 }}>{d.before || "(empty)"}</span>
        <ArrowRightOutlined style={{ fontSize: 10, opacity: 0.45 }} />
        <span className="mono" style={{ color: "var(--c-ok)" }}>{d.after || "(empty)"}</span>
      </span>
    );
  }
  if (d.before !== undefined) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-2)" }}>
        {d.what}
        <span className="mono" style={{ opacity: 0.55, textDecoration: "line-through" }}>{d.before}</span>
      </span>
    );
  }
  return <span style={{ fontSize: 13, color: "var(--text-2)" }}>{d.what}</span>;
}

// The subject cell: a parameter id (optionally a link) with its instance, or
// the instance/file name for a structural change.
function Subject({
  it,
  d,
  onOpenParam,
}: {
  it: ChangeItem;
  d: ChangeDesc;
  onOpenParam?: (paramId: string) => void;
}) {
  if (d.kind === "value") {
    const name =
      onOpenParam ? (
        <Typography.Link className="mono" onClick={() => onOpenParam(it.paramId)}>{d.subject}</Typography.Link>
      ) : (
        <span className="mono">{d.subject}</span>
      );
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {name}
        {it.scope === "global" ? (
          <Tag color="purple" style={{ marginInlineEnd: 0 }}>everyone (global)</Tag>
        ) : (
          <Tag style={{ marginInlineEnd: 0 }}>{it.instance}</Tag>
        )}
      </span>
    );
  }
  return <span className="mono" style={{ fontWeight: 600 }}>{d.subject}</span>;
}

export function ChangeItemsTable({
  items,
  onUndo,
  undoLoading,
  onOpenParam,
}: {
  items: ChangeItem[] | null;
  /** when given, each row shows an undo button */
  onUndo?: (it: ChangeItem) => void;
  undoLoading?: boolean;
  /** when given, parameter subjects become links */
  onOpenParam?: (paramId: string) => void;
}) {
  if (!items?.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No changes" />;
  return (
    <Table<ChangeItem>
      size="small"
      rowKey={(it) => `${it.paramId}|${it.instance}|${it.file ?? ""}`}
      dataSource={items}
      pagination={false}
      scroll={{ x: "max-content" }}
      columns={[
        {
          title: "Change",
          width: 130,
          render: (_v, it) => {
            const d = describeChange(it);
            return <Tag color={TONE[d.tone]} style={{ marginInlineEnd: 0 }}>{d.tag}</Tag>;
          },
        },
        {
          title: "What",
          render: (_v, it) => {
            const d = describeChange(it);
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <Subject it={it} d={d} onOpenParam={onOpenParam} />
                <Detail d={d} />
              </div>
            );
          },
        },
        ...(onUndo
          ? [
              {
                title: "",
                width: 46,
                render: (_v: unknown, it: ChangeItem) => (
                  <Tooltip title="Undo this change">
                    <Button
                      size="small"
                      type="text"
                      danger
                      aria-label={`Undo change to ${it.paramId || it.instance || "item"}`}
                      icon={<DeleteOutlined />}
                      loading={undoLoading}
                      onClick={() => onUndo(it)}
                    />
                  </Tooltip>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

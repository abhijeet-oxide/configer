import { Table, Tag, Tooltip, Button, Typography, Empty } from "antd";
import { DeleteOutlined } from "../icons";
import { describeChange, type ChangeDesc, type ChangeTone } from "../changedesc";
import ValueDiff from "./ui/ValueDiff";
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
  // A structural change that moves several named settings at once: each one
  // gets its own before -> after, because "metadata updated" is not something
  // an approver can say yes or no to.
  if (d.fields?.length) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {d.fields.map((f) => (
          <span key={f.label} style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--text-2)", minWidth: 108 }}>{f.label}</span>
            <ValueDiff before={f.before} after={f.after} label={`${d.subject} · ${f.label}`} />
          </span>
        ))}
      </div>
    );
  }
  if (d.before !== undefined && d.after !== undefined) {
    // A before/after pair is only reviewable if the reader can see which part
    // moved, so the pair is rendered as a highlighted diff rather than as two
    // values printed next to each other.
    return <ValueDiff before={d.before} after={d.after} label={d.subject} />;
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

/** itemKey identifies one draft item across renders. It is the table's row key
 *  AND what an in-flight undo is tracked by, so "which row is busy" can never
 *  disagree with "which row was clicked". */
export function itemKey(it: ChangeItem): string {
  return `${it.paramId}|${it.instance}|${it.file ?? ""}`;
}

export function ChangeItemsTable({
  items,
  onUndo,
  undoingKey,
  maxHeight,
  onOpenParam,
}: {
  items: ChangeItem[] | null;
  /** when given, each row shows an undo button */
  onUndo?: (it: ChangeItem) => void;
  /** itemKey of the row whose undo is in flight - that ONE row spins, and the
   *  others go disabled rather than all pretending to be busy. */
  undoingKey?: string | null;
  /** cap the list's own height (px) so a hundred changes scroll inside the
   *  table instead of pushing whatever follows it off the screen. */
  maxHeight?: number;
  /** when given, parameter subjects become links */
  onOpenParam?: (paramId: string) => void;
}) {
  if (!items?.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No changes" />;
  return (
    <Table<ChangeItem>
      size="small"
      rowKey={itemKey}
      dataSource={items}
      pagination={false}
      scroll={maxHeight ? { x: "max-content", y: maxHeight } : { x: "max-content" }}
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
          // A width, because the column holds a diff: without one the table's
          // max-content sizing lets a long value stretch the row off-screen,
          // which is the very thing the diff exists to prevent.
          width: 520,
          render: (_v, it) => {
            const d = describeChange(it);
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, maxWidth: 500 }}>
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
                render: (_v: unknown, it: ChangeItem) => {
                  // Only the row being undone spins. Every button showing a
                  // spinner said "all of this is being undone", which is both
                  // untrue and alarming when the list is a hundred rows long;
                  // the others go disabled instead, because one undo at a time
                  // is what the draft store can honor.
                  const busy = undoingKey === itemKey(it);
                  return (
                    <Tooltip title={busy ? "Undoing…" : "Undo this change"}>
                      <Button
                        size="small"
                        type="text"
                        danger
                        aria-label={`Undo change to ${it.paramId || it.instance || "item"}`}
                        icon={<DeleteOutlined />}
                        loading={busy}
                        disabled={!!undoingKey && !busy}
                        onClick={() => onUndo(it)}
                      />
                    </Tooltip>
                  );
                },
              },
            ]
          : []),
      ]}
    />
  );
}

import { useMemo, useState } from "react";
import { Table, Tag, Tooltip, Button, Typography, Empty, Input, Popconfirm, Progress, Spin } from "antd";
import { DeleteOutlined, SearchOutlined } from "../icons";
import { describeChange, type ChangeDesc, type ChangeTone } from "../changedesc";
import { reviewItems } from "../api";
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

/** haystack is everything about one item a person might type to find it: the
 *  parameter, the instance, the file, the type of change, and both values. */
function haystack(it: ChangeItem, d: ChangeDesc): string {
  return [
    it.paramId, it.instance, it.file, d.tag, d.subject, d.what, d.before, d.after,
    ...(d.fields?.flatMap((f) => [f.label, f.before, f.after]) ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function ChangeItemsTable({
  items,
  onUndo,
  onUndoMany,
  undoingKey,
  bulkBusy,
  bulkProgress,
  fill,
  onOpenParam,
}: {
  items: ChangeItem[] | null;
  /** when given, each row shows an undo button */
  onUndo?: (it: ChangeItem) => void;
  /** when given, rows can be selected and undone together */
  onUndoMany?: (its: ChangeItem[]) => void;
  /** itemKey of the row whose undo is in flight - that ONE row spins, and the
   *  others go disabled rather than all pretending to be busy. */
  undoingKey?: string | null;
  /** a multi-row undo is in flight */
  bulkBusy?: boolean;
  /** how far that undo has got, so a long one says so rather than freezing */
  bulkProgress?: { done: number; total: number } | null;
  /** fill the height of the container and scroll inside it (the review dialog),
   *  rather than growing with the list (a page that scrolls anyway). */
  fill?: boolean;
  /** when given, parameter subjects become links */
  onOpenParam?: (paramId: string) => void;
}) {
  // Finding one change among a hundred is a real task on this screen, so the
  // list searches, sorts and filters like any other table in the product - and
  // undoing ten of them is one action, not ten.
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<React.Key[]>([]);
  const all = useMemo(() => reviewItems(items ?? []), [items]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((it) => haystack(it, describeChange(it)).includes(q));
  }, [all, query]);
  // A selection only means anything while the rows it names are still here.
  const live = useMemo(() => new Set(all.map(itemKey)), [all]);
  const picked = useMemo(() => selected.filter((k) => live.has(String(k))), [selected, live]);
  const pickedItems = useMemo(
    () => all.filter((it) => picked.includes(itemKey(it))),
    [all, picked],
  );

  // A list with a toolbar keeps its frame even when it empties: the last batch
  // of a bulk undo removes the final rows, and swapping the whole thing for an
  // empty state at that moment takes the progress indicator away with it, right
  // when the user is watching to see it finish.
  if (!items?.length && !onUndoMany) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No changes" />;
  }

  const busy = !!undoingKey || !!bulkBusy;
  const table = (
    <Table<ChangeItem>
      size="small"
      className={"cf-items" + (fill ? " cf-items-fill" : "")}
      rowKey={itemKey}
      dataSource={shown}
      pagination={false}
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={query.trim() ? `Nothing matches "${query}"` : "No changes"}
          />
        ),
      }}
      rowSelection={
        onUndoMany
          ? {
              selectedRowKeys: picked,
              onChange: (keys) => setSelected(keys),
              columnWidth: 38,
              // Selecting while an undo is in flight would name rows that are
              // about to stop existing.
              getCheckboxProps: () => ({ disabled: busy }),
            }
          : undefined
      }
      // No horizontal scrolling, ever: the columns divide the width they are
      // given and the long things inside them wrap. A sideways bar under a list
      // of changes is a second axis to search in for no reason - the values it
      // would reveal are what the diff already picks out.
      tableLayout="fixed"
      // y:1 is a placeholder: it makes antd render the fixed-header/scroll-body
      // structure, and .cf-items-fill's CSS then lets that body take the height
      // of whatever box it is in (see index.css).
      scroll={fill ? { y: 1 } : undefined}
      columns={[
        {
          title: "Change",
          width: 112,
          sorter: (a, b) => describeChange(a).tag.localeCompare(describeChange(b).tag),
          filters: [...new Set(all.map((it) => describeChange(it).tag))]
            .sort()
            .map((t) => ({ text: t, value: t })),
          onFilter: (v, it) => describeChange(it).tag === v,
          render: (_v, it) => {
            const d = describeChange(it);
            return <Tag color={TONE[d.tone]} style={{ marginInlineEnd: 0 }}>{d.tag}</Tag>;
          },
        },
        {
          title: "What",
          // Sorted by what the row is ABOUT (the parameter, the instance, the
          // file), which is the order a reviewer reads a hundred changes in.
          sorter: (a, b) => {
            const da = describeChange(a);
            const db = describeChange(b);
            return (
              da.subject.localeCompare(db.subject) || (a.instance ?? "").localeCompare(b.instance ?? "")
            );
          },
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
                render: (_v: unknown, it: ChangeItem) => {
                  // Only the row being undone spins. Every button showing a
                  // spinner said "all of this is being undone", which is both
                  // untrue and alarming when the list is a hundred rows long;
                  // the others go disabled instead, because one undo at a time
                  // is what the draft store can honor.
                  const mine = undoingKey === itemKey(it);
                  return (
                    <Tooltip title={mine ? "Undoing…" : "Undo this change"}>
                      <Button
                        size="small"
                        type="text"
                        danger
                        aria-label={`Undo change to ${it.paramId || it.instance || "item"}`}
                        icon={<DeleteOutlined />}
                        loading={mine}
                        disabled={busy && !mine}
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

  // No toolbar where the list is a read-only record (the change history, the
  // approvals detail): searching a list you cannot act on is furniture.
  if (!onUndoMany) return table;

  return (
    <div className="cf-items-wrap">
      <div className="cf-items-bar">
        {/* While a bulk undo runs the bar becomes the progress: the count of
            what is done, a bar that moves, and nothing that invites a second
            click. Silence during a long operation is what made the last one
            look broken. */}
        {bulkProgress ? (
          <div className="cf-items-progress" role="status" aria-live="polite">
            <Spin size="small" />
            <span className="cf-items-progress-label">
              Undoing {bulkProgress.done} of {bulkProgress.total}…
            </span>
            <Progress
              percent={Math.round((bulkProgress.done / Math.max(1, bulkProgress.total)) * 100)}
              size="small"
              status="active"
              showInfo={false}
              style={{ flex: 1, minWidth: 120, margin: 0 }}
            />
          </div>
        ) : (
          <>
            <Input
              size="small"
              allowClear
              prefix={<SearchOutlined style={{ color: "var(--text-3)" }} />}
              placeholder="Search these changes"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ maxWidth: 260 }}
            />
            <span className="cf-items-count">
              {query.trim() && shown.length !== all.length
                ? `${shown.length} of ${all.length}`
                : `${all.length} change${all.length === 1 ? "" : "s"}`}
            </span>
            <span style={{ flex: 1 }} />
            {picked.length > 0 && (
              <>
                <Button size="small" type="text" onClick={() => setSelected([])} disabled={busy}>
                  Clear
                </Button>
                <Popconfirm
                  title={`Undo ${picked.length} change${picked.length === 1 ? "" : "s"}?`}
                  description="They go back to the value the files hold now. Nothing has been written to Git."
                  okText="Undo them"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => {
                    onUndoMany(pickedItems);
                    setSelected([]);
                  }}
                >
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    loading={bulkBusy}
                    disabled={!!undoingKey}
                  >
                    Undo {picked.length} selected
                  </Button>
                </Popconfirm>
              </>
            )}
          </>
        )}
      </div>
      {table}
    </div>
  );
}

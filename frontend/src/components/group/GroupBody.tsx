import { Tooltip, Typography, Tag } from "antd";
import { useMemo, useRef } from "react";
import type { Rules } from "../../rules";
import { typeLabel } from "../../rules";
import { SCOPE_META, type ScopeFacet } from "../../scope";
import { InfoCircleOutlined, ScopeGlobalOutlined, ScopeInstanceOutlined, ScopeSiteOutlined } from "../../icons";
import { InlineNotice } from "../ui";
import GroupField, { lockedReason } from "./GroupField";
import { fieldsets, isWide, type Col, type Committed, type Member, type Section } from "./model";
import { useWindow } from "./useWindow";

// The group editor's body: every setting under one branch, as one WINDOWED list.
//
// A branch can hold seven hundred settings. Each is a label and a real form
// control, and mounting seven hundred of those is more than a second of blocked
// main thread - during which the click that asked for the dialog has produced
// nothing at all on screen. So the whole body is one flat list of rows whose
// heights are known in advance, and only the rows the scroller can actually show
// are rendered. Twenty controls instead of seven hundred, and the dialog is on
// screen in the frame after the click.
//
// One list, not one per section, because a section boundary is just another row.
// Three lists in one scroller would each need to know where the others ended,
// which is a coordinate problem nobody needs to have.
//
// The comparison layout is a CSS grid rather than a <table> for the same reason:
// a table's rows cannot be windowed without the browser laying out the whole
// thing anyway. It keeps the table ROLES, so it is still a table to a screen
// reader - it just is not one to the layout engine.

/** Row heights. They are declared rather than measured, and the layout is built
 *  to honour them: a field is a label over one control, and its error message
 *  is positioned so it can never push the row taller (see group.css). Measuring
 *  instead would mean a render, a measure and a re-render per scroll, with rows
 *  jumping as their real heights arrived. */
const H = {
  section: 34,
  setHead: 30,
  field: 64,
  wide: 108,
  tableHead: 40,
  tableRow: 64,
  notice: 44,
} as const;

type BodyRow =
  | { kind: "section"; h: number; sec: Section }
  | { kind: "notice"; h: number; sec: Section }
  | { kind: "setHead"; h: number; label: string }
  | { kind: "fields"; h: number; sec: Section; members: Member[] }
  | { kind: "tableHead"; h: number; sec: Section }
  | { kind: "tableRow"; h: number; sec: Section; member: Member };

const FACET_ICON: Record<ScopeFacet, typeof ScopeGlobalOutlined> = {
  global: ScopeGlobalOutlined,
  site: ScopeSiteOutlined,
  instance: ScopeInstanceOutlined,
};

/** How many columns of fields fit. Mirrors the CSS the form used to do on its
 *  own - it has to be known in JS now, because the row model needs to know how
 *  many fields a row holds before it can say how tall the list is. */
const MIN_COL = 240;
const GAP = 20;
function columnsIn(width: number): number {
  if (!width) return 1;
  return Math.max(1, Math.floor((width + GAP) / (MIN_COL + GAP)));
}

export default function GroupBody({
  sections,
  committed,
  rules,
  edits,
  refused,
  canEdit,
  onChange,
}: {
  sections: Section[];
  committed: Map<string, Committed>;
  rules: Map<string, Rules>;
  edits: Record<string, unknown>;
  refused: Record<string, string>;
  canEdit: boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  // One measurement drives both the row model and the window, so the two can
  // never disagree about how many columns a row holds.
  const probe = useWindow(scroller, [], 0);
  const cols = columnsIn(probe.width);

  const rows = useMemo<BodyRow[]>(() => {
    const out: BodyRow[] = [];
    const shown = (key: string, c: Committed) => (key in edits ? edits[key] : c.mixed ? undefined : c.value);
    for (const sec of sections) {
      out.push({ kind: "section", h: H.section, sec });
      if (sec.cols.length === 0) {
        out.push({ kind: "notice", h: H.notice, sec });
        continue;
      }
      if (sec.cols.length === 1) {
        const col = sec.cols[0];
        for (const fs of fieldsets(sec.members)) {
          if (fs.key) out.push({ kind: "setHead", h: H.setHead, label: fs.key });
          // Fields flow across the row until it is full; a wide one takes the
          // row it starts, alone.
          let run: Member[] = [];
          const flush = () => {
            if (run.length) out.push({ kind: "fields", h: H.field, sec, members: run });
            run = [];
          };
          for (const m of fs.members) {
            const key = `${m.row.param.id}|${col.key}`;
            const c = committed.get(key);
            if (isWide(m.row.param.type, c ? shown(key, c) : undefined)) {
              flush();
              out.push({ kind: "fields", h: H.wide, sec, members: [m] });
              continue;
            }
            run.push(m);
            if (run.length === cols) flush();
          }
          flush();
        }
        continue;
      }
      out.push({ kind: "tableHead", h: H.tableHead, sec });
      for (const m of sec.members) out.push({ kind: "tableRow", h: H.tableRow, sec, member: m });
    }
    return out;
    // `edits` is in here because a value growing past a line turns its field
    // wide, which changes the row model. It is the only reason.
  }, [sections, cols, committed, edits]);

  const heights = useMemo(() => rows.map((r) => r.h), [rows]);
  const win = useWindow(scroller, heights);

  /** One field. In the FORM it carries its own label; in the comparison it does
   *  not - the row already names the setting once, and repeating it in every
   *  column is the same word three times across a row that exists to show what
   *  differs. */
  const field = (m: Member, col: Col, wide: boolean, labelled = true) => {
    const p = m.row.param;
    const key = `${p.id}|${col.key}`;
    const c = committed.get(key) ?? { value: undefined, mixed: false, cell: undefined };
    const shown = key in edits ? edits[key] : c.mixed ? undefined : c.value;
    return (
      <div key={p.id} className={"cf-group-field" + (wide ? " is-wide" : "")}>
        {labelled && (
          <label className="cf-group-label">
            <span className="mono">{m.trail[m.trail.length - 1]}</span>
            {p.validation?.required && (
              <Tooltip title="Required">
                <span className="cf-group-req" aria-label="required">*</span>
              </Tooltip>
            )}
            <FieldInfo name={p.name} type={typeLabel(p.type, p.itemType)} description={p.description} />
          </label>
        )}
        <GroupField
          param={p}
          rules={rules.get(p.id) ?? {}}
          value={shown}
          committed={c.value}
          placeholder={c.mixed ? `${col.instances.length} different values` : undefined}
          locked={lockedReason(p, c.cell, canEdit)}
          status={refused[key] ? "error" : ""}
          fieldKey={key}
          onChange={onChange}
        />
        {refused[key] && (
          <Typography.Text type="danger" className="cf-group-hint cf-group-err">
            {refused[key]}
          </Typography.Text>
        )}
      </div>
    );
  };

  const draw = (r: BodyRow, i: number) => {
    switch (r.kind) {
      case "section": {
        const Icon = FACET_ICON[r.sec.facet];
        return (
          <div key={i} className="cf-group-sec-head" style={{ height: r.h }}>
            <Tooltip title={SCOPE_META[r.sec.facet].explain}>
              <Tag color={SCOPE_META[r.sec.facet].color} style={{ marginInlineEnd: 0 }}>
                <Icon style={{ marginInlineEnd: 4 }} />
                {SCOPE_META[r.sec.facet].label}
              </Tag>
            </Tooltip>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.sec.reach}</Typography.Text>
          </div>
        );
      }
      case "notice":
        return (
          <div key={i} style={{ height: r.h }}>
            <InlineNotice tone="neutral">Nothing selected to edit these on.</InlineNotice>
          </div>
        );
      case "setHead":
        return (
          <div key={i} className="cf-group-set-head mono" style={{ height: r.h }}>
            {r.label}
          </div>
        );
      case "fields": {
        const col = r.sec.cols[0];
        const wide = r.h === H.wide;
        return (
          <div
            key={i}
            className="cf-group-form"
            style={{ height: r.h, gridTemplateColumns: wide ? "1fr" : `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {r.members.map((m) => field(m, col, wide))}
          </div>
        );
      }
      case "tableHead":
        return (
          <div
            key={i}
            className="cf-group-grid cf-group-grid-head"
            role="row"
            style={{ height: r.h, gridTemplateColumns: `minmax(0, 1.2fr) repeat(${r.sec.cols.length}, minmax(0, 1fr))` }}
          >
            <span role="columnheader">Setting</span>
            {r.sec.cols.map((col) => (
              <span key={col.key} role="columnheader">
                <span className="mono">{col.label}</span>
                {col.sub && <span className="cf-group-sub">{col.sub}</span>}
              </span>
            ))}
          </div>
        );
      case "tableRow": {
        const p = r.member.row.param;
        return (
          <div
            key={i}
            className="cf-group-grid"
            role="row"
            style={{ height: r.h, gridTemplateColumns: `minmax(0, 1.2fr) repeat(${r.sec.cols.length}, minmax(0, 1fr))` }}
          >
            <span className="cf-group-name" role="rowheader">
              <span className="cf-group-label">
                <span className="mono">{r.member.label}</span>
                {p.validation?.required && (
                  <Tooltip title="Required">
                    <span className="cf-group-req" aria-label="required">*</span>
                  </Tooltip>
                )}
                <FieldInfo name={p.name} type={typeLabel(p.type, p.itemType)} description={p.description} />
              </span>
            </span>
            {r.sec.cols.map((col) => (
              <span key={col.key} role="cell">
                {field(r.member, col, false, false)}
              </span>
            ))}
          </div>
        );
      }
    }
  };

  return (
    <div className="cf-group-body" ref={scroller} role="table">
      <div style={{ height: win.padTop }} aria-hidden />
      {rows.slice(win.start, win.end).map((r, i) => draw(r, win.start + i))}
      <div style={{ height: win.padBottom }} aria-hidden />
    </div>
  );
}

/** What a field IS, behind one glyph: its full name, what may be typed into it,
 *  and what it does. Spelled out beside every field it was a paragraph per row
 *  and the labels stopped being findable among them.
 *
 *  The glyph is wrapped in a span of its own because the shared icon components
 *  (icons.tsx `make`) render a fixed set of props and drop the rest - and a
 *  tooltip works by cloning its child with mouse handlers, which those icons
 *  would throw away. The span keeps them. */
function FieldInfo({ name, type, description }: { name: string; type: string; description?: string }) {
  return (
    <Tooltip
      placement="topLeft"
      title={
        <span>
          <span className="mono">{name}</span>
          <br />
          {type}
          {description ? ` - ${description}` : ""}
        </span>
      }
    >
      <span className="cf-group-info" tabIndex={0} role="note" aria-label={`About ${name}`}>
        <InfoCircleOutlined />
      </span>
    </Tooltip>
  );
}

import {
  App as AntApp,
  Button,
  Modal,
  Segmented,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  nameSegments,
  type BatchEdit,
  type Cell,
  type Grid,
  type Instance,
  type Parameter,
  type Row,
} from "../api";
import { useRepoQuery } from "../repoQuery";
import { effectiveRules, fmtValue, typeLabel } from "../rules";
import { effectiveScope, groupField, SCOPE_META, type ScopeFacet } from "../scope";
import { groupLeaf, groupTrail, trailLabel } from "../paramtree";
import { useIdentity } from "../identity";
import { useUI } from "../store";
import { InfoCircleOutlined, ScopeGlobalOutlined, ScopeSiteOutlined, ScopeInstanceOutlined, FormOutlined, CodeOutlined } from "../icons";
import EnvTag from "./EnvTag";
import { EmptyState, InlineNotice } from "./ui";
import GroupField, { fieldError, lockedReason } from "./group/GroupField";

const JsonPane = lazy(() => import("./group/JsonPane"));

// The group editor: one branch of the parameter tree, on its own, as a form.
//
// The grid is the right tool for one setting across a fleet. It is the wrong
// tool for a fleet's worth of one THING - an ip-realm, a media profile, a
// capacity block - because the settings that belong together are scattered down
// a column of eight hundred rows, and reading them means scrolling past
// everything they are not. Double-clicking the branch collects them.
//
// Three things make this a form rather than a smaller grid:
//
//  - It says WHAT IT WILL TOUCH, before anything is typed. A global setting
//    changes every system; a site setting changes a site; an instance setting
//    changes the systems named at the top. That sentence is computed from the
//    scope and the selection, never worked out afterwards from what was
//    written, because "what did I just change" is not a question to answer
//    after the fact.
//  - Nothing commits until Save. Every field holds what was typed while its
//    neighbour is being filled in, and the whole form stages in ONE request -
//    one draft entry, not twenty half-applied ones.
//  - The same settings can be read as JSON, which is how somebody who already
//    knows the shape would rather type them, and how a block gets pasted in
//    from somewhere else.

/** One editing target: a column of the form, and the instances a value typed
 *  into it will really be written to. */
interface Col {
  key: string;
  label: string;
  sub?: string;
  /** the instances this column writes to - the whole point of the column */
  instances: string[];
}

interface Member {
  row: Row;
  trail: string[];
  label: string;
  facet: ScopeFacet;
}

/** A section of the form: the settings at one scope, and the columns they are
 *  edited in. */
interface Section {
  facet: ScopeFacet;
  members: Member[];
  cols: Col[];
  /** the sentence above the fields, saying what a change here reaches */
  reach: string;
}

const FACET_ICON: Record<ScopeFacet, typeof ScopeGlobalOutlined> = {
  global: ScopeGlobalOutlined,
  site: ScopeSiteOutlined,
  instance: ScopeInstanceOutlined,
};

/** The value a column currently shows: the one its instances agree on, or a
 *  marker that they do not. A field that silently showed the first instance's
 *  value would make "apply to all" quietly overwrite the others with it. */
function committedFor(row: Row, col: Col): { value: unknown; mixed: boolean } {
  const values = col.instances.map((n) => row.cells[n]?.value);
  if (values.length === 0) return { value: undefined, mixed: false };
  const first = fmtValue(values[0]);
  const mixed = values.some((v) => fmtValue(v) !== first);
  return { value: mixed ? undefined : values[0], mixed };
}

/** What a field IS, behind one glyph: its full name, what may be typed into it,
 *  and what it does. Spelled out beside every field it was a paragraph per row
 *  and the labels stopped being findable among them.
 *
 *  The glyph is wrapped in a span of its own because the shared icon components
 *  (icons.tsx `make`) render a fixed set of props and drop the rest - and a
 *  tooltip works by cloning its child with mouse handlers, which those icons
 *  would throw away. The span keeps them. */
function FieldInfo({ param }: { param: Parameter }) {
  return (
    <Tooltip
      placement="topLeft"
      title={
        <span>
          <span className="mono">{param.name}</span>
          <br />
          {typeLabel(param.type, param.itemType)}
          {param.description ? ` - ${param.description}` : ""}
        </span>
      }
    >
      <span className="cf-group-info" tabIndex={0} role="note" aria-label={`About ${param.name}`}>
        <InfoCircleOutlined />
      </span>
    </Tooltip>
  );
}

/** The form's fieldsets: the members grouped by the route ABOVE their own leaf,
 *  in the order they arrived.
 *
 *  A branch several levels deep otherwise repeats its route in every label -
 *  "capacity-profile-config[1].amr-wb", "capacity-profile-config[1].g711" - each
 *  truncated to make room for the one word that differs, which is the word that
 *  got cut. Said once as a heading, the fields underneath can be called what
 *  they are. A group whose members are all direct children has ONE fieldset with
 *  no heading, because there is no route to say. */
function fieldsets(members: Member[]): { key: string; members: Member[] }[] {
  const out: { key: string; members: Member[] }[] = [];
  const at = new Map<string, number>();
  for (const m of members) {
    const key = m.trail.slice(0, -1).join(".");
    const idx = at.get(key);
    if (idx === undefined) {
      at.set(key, out.length);
      out.push({ key, members: [m] });
    } else {
      out[idx].members.push(m);
    }
  }
  return out;
}

/** How wide a column needs to be for this fieldset's longest label to read in
 *  full. A fixed column width is why four long names got jammed into four
 *  narrow columns and every one of them was cut - the grid never knew the
 *  labels needed more room than a short boolean's did. Sized to the longest
 *  member, a small fieldset of long names naturally settles into fewer, wider
 *  columns (four settings as 2x2 rather than 4x1) while a fieldset of short
 *  ones still fills the row. */
function fieldColWidth(members: Member[]): number {
  const longest = members.reduce((n, m) => Math.max(n, m.trail[m.trail.length - 1].length), 0);
  return Math.min(460, Math.max(220, longest * 8 + 70));
}

/** Whether a field needs the whole row rather than a column of the form: a list
 *  of entries and a paragraph of text are unreadable in a third of a dialog. */
function isWide(param: Parameter, value: unknown): boolean {
  if (param.type === "list") return true;
  const s = value === null || value === undefined ? "" : String(value);
  return s.length > 60;
}

/** The cell a column's lock state is read from: the first instance it writes
 *  to. A setting that is read-only or templated is that way in the files, so
 *  any of the column's instances answers the question. */
function cellFor(row: Row, col: Col): Cell | undefined {
  for (const n of col.instances) {
    const c = row.cells[n];
    if (c) return c;
  }
  return undefined;
}

export default function GroupEditorModal({
  groupKey,
  grid,
  onClose,
}: {
  groupKey: string;
  grid: Grid;
  onClose: () => void;
}) {
  const { message } = AntApp.useApp();
  const { canEdit } = useIdentity();
  const { mode, selectedInstance } = useUI();
  const qc = useQueryClient();
  const presetsQ = useRepoQuery({ queryKey: ["presets"], queryFn: api.presets });

  const instances = grid.instances;
  // The instances the form is aimed at. It opens on ONE - whichever the reader
  // was already looking at - because a dialog that opens aimed at twenty-three
  // production systems is a dialog whose safest first action is to close it.
  const [targets, setTargets] = useState<string[]>(() => {
    const anchor = instances.find((i) => i.name === selectedInstance) ?? instances[0];
    return anchor ? [anchor.name] : [];
  });
  // One value for every selected instance, or a column each. Off by default:
  // most of the time a group is being set the same way everywhere, and N
  // identical columns is N times the reading for one decision.
  const [perInstance, setPerInstance] = useState(false);
  const [view, setView] = useState<"form" | "json">("form");
  // What has been typed, keyed `${paramId}|${colKey}`. Absent means untouched -
  // which is not the same as "equal to what is there", and only the absent ones
  // can be left out of the save.
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  // What the server refused, keyed the same way, so a rejection lands on the
  // field that caused it rather than in a toast above a form of twenty.
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [jsonText, setJsonText] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);

  // grid.rows is already in the catalog's own document order - the same order
  // CategoryTree walks for the name tree - so a member here lands exactly
  // where its leaf sits there. Sorting alphabetically once put "add" ahead of
  // "warning" in the dialog while the tree beside it still read the file's
  // own order, so the same branch told two different stories.
  const members = useMemo<Member[]>(() => {
    const out: Member[] = [];
    for (const row of grid.rows) {
      const trail = groupTrail(row.param, groupKey);
      if (!trail) continue;
      out.push({ row, trail, label: trailLabel(trail), facet: effectiveScope(row.param) });
    }
    return out;
  }, [grid.rows, groupKey]);

  const selected = useMemo(
    () => instances.filter((i) => targets.includes(i.name)),
    [instances, targets],
  );

  // The sections, and with them every sentence this dialog says about reach.
  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    const at = (f: ScopeFacet) => members.filter((m) => m.facet === f);

    const globals = at("global");
    if (globals.length) {
      out.push({
        facet: "global",
        members: globals,
        cols: [{ key: "", label: "Every instance", sub: `${instances.length} in this application`, instances: instances.map((i) => i.name) }],
        reach: `Applies to all ${instances.length} instance${instances.length === 1 ? "" : "s"} - these values live in a shared file`,
      });
    }

    const sited = at("site");
    if (sited.length) {
      // A group-scoped setting is shared by the systems of one group, so its
      // column is the GROUP, not the instance: one field per site among the
      // selected instances, writing to every instance in that site.
      const field = groupField(sited[0].row.param.scope) ?? "site";
      const cols: Col[] = [];
      const seen = new Map<string, Col>();
      for (const i of selected) {
        const key = (i[field] ?? "").trim();
        if (!key) continue;
        let col = seen.get(key);
        if (!col) {
          col = { key: `g:${key}`, label: key, sub: field, instances: [] };
          seen.set(key, col);
          cols.push(col);
        }
      }
      // Every instance of a touched group comes along, selected or not: that is
      // what "shared by the site" means, and picking one machine of four does
      // not make the value stop being the site's.
      for (const col of cols) {
        const key = col.label;
        col.instances = instances.filter((i) => (i[field] ?? "").trim() === key).map((i) => i.name);
        col.sub = `${col.instances.length} instance${col.instances.length === 1 ? "" : "s"}`;
      }
      const reached = cols.reduce((n, c) => n + c.instances.length, 0);
      out.push({
        facet: "site",
        members: sited,
        cols,
        reach: cols.length
          ? `Applies to ${cols.map((c) => c.label).join(", ")} - ${reached} instance${reached === 1 ? "" : "s"} in ${cols.length === 1 ? "that group" : "those groups"}`
          : `None of the selected instances has a ${field}, so there is no group to change`,
      });
    }

    const own = at("instance");
    if (own.length) {
      const cols: Col[] = perInstance || selected.length <= 1
        ? selected.map((i) => ({
            key: `i:${i.name}`,
            label: i.name,
            sub: [i.environment, i.region].filter(Boolean).join(" · "),
            instances: [i.name],
          }))
        : [{ key: "*", label: `All ${selected.length} selected`, sub: selected.map((i) => i.name).join(", "), instances: selected.map((i) => i.name) }];
      out.push({
        facet: "instance",
        members: own,
        cols,
        reach: selected.length === 0
          ? "Pick the instances to edit"
          : selected.length === 1
            ? `Applies to ${selected[0].name} only`
            : perInstance
              ? `A value each for ${selected.length} instances`
              : `Applies to all ${selected.length} selected instances`,
      });
    }
    return out;
  }, [members, instances, selected, perInstance]);

  const rulesFor = useCallback(
    (p: Parameter) => effectiveRules(p, presetsQ.data),
    [presetsQ.data],
  );

  // ------------------------------------------------------------------ JSON
  // The same settings, in the shape the model has: what is shared, what belongs
  // to a group, and what belongs to one system. A flat object keyed by
  // parameter would have to invent a rule for which instance a value meant.
  const asJson = useCallback(() => {
    const doc: Record<string, unknown> = {};
    for (const sec of sections) {
      const block: Record<string, unknown> = {};
      for (const col of sec.cols) {
        const values: Record<string, unknown> = {};
        for (const m of sec.members) {
          const key = `${m.row.param.id}|${col.key}`;
          const { value, mixed } = committedFor(m.row, col);
          const v = key in edits ? edits[key] : mixed ? null : value;
          values[m.label] = v === undefined ? null : v;
        }
        if (sec.facet === "global") Object.assign(block, values);
        else block[col.label] = values;
      }
      doc[sec.facet === "global" ? "shared" : sec.facet === "site" ? "groups" : "instances"] = block;
    }
    return JSON.stringify(doc, null, 2);
  }, [sections, edits]);

  const jsonValue = jsonText ?? asJson();

  /** Read the JSON back into the same edits the form produces. Anything the
   *  form would not have offered is REFUSED by name rather than dropped: a
   *  pasted block with a typo in a key must not look like it applied. */
  const applyJson = useCallback(
    (text: string): boolean => {
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch (e) {
        setJsonError((e as Error).message);
        return false;
      }
      if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
        setJsonError("The document has to be an object with shared / groups / instances in it.");
        return false;
      }
      const next: Record<string, unknown> = {};
      const unknown: string[] = [];
      const blocks = doc as Record<string, unknown>;
      for (const sec of sections) {
        const name = sec.facet === "global" ? "shared" : sec.facet === "site" ? "groups" : "instances";
        const block = blocks[name];
        if (block === undefined) continue;
        if (typeof block !== "object" || block === null) {
          setJsonError(`"${name}" has to be an object.`);
          return false;
        }
        const byLabel = new Map(sec.members.map((m) => [m.label, m.row.param.id]));
        const readInto = (col: Col, values: Record<string, unknown>) => {
          for (const [label, v] of Object.entries(values)) {
            const id = byLabel.get(label);
            if (!id) {
              unknown.push(label);
              continue;
            }
            if (v === null) continue; // "leave it alone", which is what a mixed column reads as
            next[`${id}|${col.key}`] = v;
          }
        };
        if (sec.facet === "global") {
          readInto(sec.cols[0], block as Record<string, unknown>);
        } else {
          for (const [colLabel, values] of Object.entries(block as Record<string, unknown>)) {
            const col = sec.cols.find((c) => c.label === colLabel);
            if (!col) {
              unknown.push(colLabel);
              continue;
            }
            if (typeof values !== "object" || values === null) {
              setJsonError(`"${colLabel}" has to be an object of settings.`);
              return false;
            }
            readInto(col, values as Record<string, unknown>);
          }
        }
      }
      if (unknown.length) {
        setJsonError(`Not in this group: ${[...new Set(unknown)].join(", ")}`);
        return false;
      }
      setJsonError(null);
      setEdits((prev) => ({ ...prev, ...next }));
      return true;
    },
    [sections],
  );

  // ------------------------------------------------------------------ saving
  /** Every field that was touched AND really differs from what is committed. */
  const pending = useMemo(() => {
    const out: { key: string; member: Member; col: Col; value: unknown }[] = [];
    for (const sec of sections) {
      for (const col of sec.cols) {
        for (const m of sec.members) {
          const key = `${m.row.param.id}|${col.key}`;
          if (!(key in edits)) continue;
          const { value, mixed } = committedFor(m.row, col);
          if (!mixed && fmtValue(edits[key]) === fmtValue(value)) continue;
          out.push({ key, member: m, col, value: edits[key] });
        }
      }
    }
    return out;
  }, [sections, edits]);

  const invalid = useMemo(
    () =>
      pending.filter((p) => {
        const { value } = committedFor(p.member.row, p.col);
        return fieldError(p.member.row.param, rulesFor(p.member.row.param), p.value, value) !== null;
      }),
    [pending, rulesFor],
  );

  const save = useMutation({
    mutationFn: () => {
      const batch: BatchEdit[] = [];
      // A key per edit, in the order they were built, so a per-target failure
      // coming back can be matched to the field that produced it.
      const keys: string[] = [];
      for (const p of pending) {
        if (p.member.facet === "global") {
          batch.push({ paramId: p.member.row.param.id, scope: "global", value: p.value });
          keys.push(p.key);
          continue;
        }
        for (const inst of p.col.instances) {
          batch.push({ paramId: p.member.row.param.id, instance: inst, value: p.value });
          keys.push(p.key);
        }
      }
      return api.batchSetValues(batch).then((res) => ({ res, keys }));
    },
    onSuccess: ({ res, keys }) => {
      qc.invalidateQueries({ queryKey: ["grid"] });
      qc.invalidateQueries({ queryKey: ["draft"] });
      qc.invalidateQueries({ queryKey: ["changes"] });
      qc.invalidateQueries({ queryKey: ["render"] });
      const bad: Record<string, string> = {};
      res.results.forEach((r, i) => {
        if (r.error && keys[i]) bad[keys[i]] = r.error;
      });
      if (Object.keys(bad).length) {
        // Some of it staged and some did not. The dialog stays open showing
        // exactly which fields were refused - closing it would leave the reader
        // to find that out from the review screen.
        setRefused(bad);
        message.warning(
          `Staged ${res.staged} change${res.staged === 1 ? "" : "s"}; ${Object.keys(bad).length} field${Object.keys(bad).length === 1 ? " was" : "s were"} refused.`,
          6,
        );
        return;
      }
      message.success(
        res.staged === 0
          ? "Nothing to stage: those values are already what the files say."
          : `Staged ${res.staged} change${res.staged === 1 ? "" : "s"} in your draft.`,
      );
      onClose();
    },
    onError: (e: Error) => message.error(e.message, 8),
  });

  const leaf = groupLeaf(groupKey);
  const route = nameSegments({ name: groupKey } as Parameter).slice(0, -1);
  const hasInstanceTargets = sections.some((s) => s.facet !== "global");

  const setValue = (key: string, v: unknown) => {
    setEdits((prev) => ({ ...prev, [key]: v }));
    setRefused((prev) => (key in prev ? { ...prev, [key]: "" } : prev));
    // The JSON view is a rendering of the edits; once the form moves it has to
    // be re-rendered rather than left showing the state before the keystroke.
    setJsonText(null);
  };

  return (
    <Modal
      open
      width="min(1120px, 96vw)"
      onCancel={() => onClose()}
      title={
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span className="mono" style={{ fontSize: 15 }}>{leaf}</span>
          {route.length > 0 && (
            <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>
              {route.join(" / ")}
            </Typography.Text>
          )}
          <Tag style={{ marginInlineEnd: 0 }}>
            {members.length} setting{members.length === 1 ? "" : "s"}
          </Tag>
        </div>
      }
      okText={pending.length ? `Save ${pending.length} change${pending.length === 1 ? "" : "s"}` : "Save changes"}
      okButtonProps={{
        disabled: !canEdit || pending.length === 0 || invalid.length > 0,
        title: invalid.length ? "Some values are not valid yet" : undefined,
      }}
      confirmLoading={save.isPending}
      onOk={() => {
        if (view === "json" && jsonText !== null && !applyJson(jsonText)) return;
        save.mutate();
      }}
      destroyOnHidden
    >
      {members.length === 0 ? (
        <EmptyState
          icon={<ScopeInstanceOutlined />}
          title="Nothing under this group"
          hint="Every setting that was here has been filtered out or is no longer managed."
        />
      ) : (
        <>
          {/* Who this is for. It is the first row of the dialog because it is
              the first thing to know, and it stays put while the fields
              scroll. */}
          <div className="cf-group-head">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Typography.Text strong style={{ fontSize: 12 }}>Apply to</Typography.Text>
              {hasInstanceTargets ? (
                <Select
                  mode="multiple"
                  size="small"
                  showSearch
                  allowClear
                  maxTagCount="responsive"
                  style={{ flex: "1 1 260px", minWidth: 0 }}
                  placeholder="Pick the instances to edit"
                  value={targets}
                  onChange={(v) => setTargets(v)}
                  filterOption={(q, o) => (o?.searchText ?? "").includes(q.toLowerCase())}
                  // A SELECTED instance is a chip in a one-line box, so it wears
                  // its name and nothing else. The environment and the region
                  // belong in the menu, where there is room to read them and
                  // where they are what the choice is made on; rendering them
                  // inside the chip made a long site name run out of the box and
                  // took the "All 6" beside it off the edge of the dialog.
                  tagRender={({ value, onClose }) => (
                    <Tag closable onClose={onClose} className="mono cf-group-target" style={{ marginInlineEnd: 4 }}>
                      {String(value)}
                    </Tag>
                  )}
                  options={instances.map((i) => ({
                    value: i.name,
                    searchText: `${i.name} ${i.environment ?? ""} ${i.region ?? ""} ${i.site ?? ""}`.toLowerCase(),
                    label: (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <span className="mono">{i.name}</span>
                        {i.environment && <EnvTag env={i.environment} />}
                        {i.region && (
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>{i.region}</Typography.Text>
                        )}
                      </span>
                    ),
                  }))}
                />
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Everything in this group is shared, so there is no instance to choose.
                </Typography.Text>
              )}
              {hasInstanceTargets && (
                <Space size={4}>
                  <Button size="small" type="link" style={{ padding: "0 4px" }} onClick={() => setTargets(instances.map((i) => i.name))}>
                    All {instances.length}
                  </Button>
                  <SiteShortcut instances={instances} targets={targets} onPick={setTargets} />
                </Space>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              {/* A lone section's scope reads on the same line as the view
                  toggle - two facts about the same edit belong on one row.
                  A second section (a different scope reached at once) still
                  gets its own line below, where there is room to tell them
                  apart. */}
              {sections.length === 1 ? (
                <div className="cf-group-sec-head" style={{ marginBottom: 0 }}>
                  <Typography.Text type="secondary" className="cf-group-reach" style={{ fontSize: 12 }}>{sections[0].reach}</Typography.Text>
                  <Tooltip title={SCOPE_META[sections[0].facet].explain}>
                    <Tag color={SCOPE_META[sections[0].facet].color} style={{ marginInlineEnd: 0, flexShrink: 0 }}>
                      {(() => { const Icon = FACET_ICON[sections[0].facet]; return <Icon style={{ marginInlineEnd: 4 }} />; })()}
                      {SCOPE_META[sections[0].facet].label}
                    </Tag>
                  </Tooltip>
                </div>
              ) : <span />}
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {hasInstanceTargets && selected.length > 1 && (
                  <Segmented
                    size="small"
                    value={perInstance ? "each" : "same"}
                    onChange={(v) => setPerInstance(v === "each")}
                    options={[
                      { value: "same", label: "One value for all" },
                      { value: "each", label: "A value per instance" },
                    ]}
                  />
                )}
                <Segmented
                  size="small"
                  value={view}
                  onChange={(v) => {
                    const next = v as "form" | "json";
                    // Leaving JSON carries what was typed there into the form,
                    // so the two views are one document rather than two drafts.
                    if (view === "json" && jsonText !== null && !applyJson(jsonText)) return;
                    if (next === "json") setJsonText(null);
                    setView(next);
                  }}
                  options={[
                    { value: "form", label: (<span className="cf-group-viewopt"><FormOutlined />Form</span>) },
                    { value: "json", label: (<span className="cf-group-viewopt"><CodeOutlined />JSON</span>) },
                  ]}
                />
              </div>
            </div>
          </div>

          {view === "json" ? (
            <>
              {jsonError && (
                <div className="cf-group-notice"><InlineNotice tone="danger">{jsonError}</InlineNotice></div>
              )}
              <div className="cf-group-notice"><InlineNotice tone="neutral">
                <b>shared</b> changes every instance, <b>groups</b> changes a whole site, and{" "}
                <b>instances</b> changes one system. A value of <span className="mono">null</span> is
                left alone.
              </InlineNotice></div>
              <div className="cf-group-json">
                <Suspense fallback={<div style={{ padding: 16, opacity: 0.6 }}>Loading the editor…</div>}>
                  <JsonPane
                    value={jsonValue}
                    onChange={(v) => {
                      setJsonText(v);
                      setJsonError(null);
                    }}
                    readOnly={!canEdit}
                    dark={mode === "dark"}
                  />
                </Suspense>
              </div>
            </>
          ) : (
            <div className="cf-group-body">
              {sections.map((sec) => {
                const Icon = FACET_ICON[sec.facet];
                return (
                  <section key={sec.facet} className="cf-group-sec">
                    {/* Shown up in the header already when this is the only
                        section - see cf-group-head above. */}
                    {sections.length > 1 && (
                      <div className="cf-group-sec-head">
                        <Typography.Text type="secondary" className="cf-group-reach" style={{ fontSize: 12 }}>{sec.reach}</Typography.Text>
                        <Tooltip title={SCOPE_META[sec.facet].explain}>
                          <Tag color={SCOPE_META[sec.facet].color} style={{ marginInlineEnd: 0, flexShrink: 0 }}>
                            <Icon style={{ marginInlineEnd: 4 }} />
                            {SCOPE_META[sec.facet].label}
                          </Tag>
                        </Tooltip>
                      </div>
                    )}
                    {sec.cols.length === 0 ? (
                      <InlineNotice tone="neutral">Nothing selected to edit these on.</InlineNotice>
                    ) : sec.cols.length === 1 ? (
                      // ONE thing being edited, so this is a form and it is laid
                      // out like one: label over field, flowing into as many
                      // columns as the dialog is wide and as many rows as the
                      // branch has settings. A table with a single value column
                      // spends a third of the width on a header that says
                      // "Setting" and gives every field a whole row of its own,
                      // which turns eight settings into eight screens of
                      // scrolling for a form that fits in one.
                      <>
                        {fieldsets(sec.members).map((fs) => (
                          <div key={fs.key} className="cf-group-set">
                            {/* A branch several levels deep repeats its route in
                                every single label - "capacity-profile-config[1]"
                                eight times over, each one truncated to make room
                                for the one word that differs. Said ONCE as a
                                heading, the fields underneath get to be called
                                what they are. */}
                            {fs.key && <div className="cf-group-set-head mono">{fs.key}</div>}
                            <div
                              className="cf-group-form"
                              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${fieldColWidth(fs.members)}px, 1fr))` }}
                            >
                              {fs.members.map((m) => {
                                const p = m.row.param;
                                const rules = rulesFor(p);
                                const col = sec.cols[0];
                                const key = `${p.id}|${col.key}`;
                                const { value, mixed } = committedFor(m.row, col);
                                const cell = cellFor(m.row, col);
                                const shown = key in edits ? edits[key] : mixed ? undefined : value;
                                return (
                                  <div
                                    key={p.id}
                                    // A list of entries and a paragraph of text
                                    // have nowhere to go in a third of the
                                    // dialog, so they take the whole row.
                                    className={"cf-group-field" + (isWide(p, shown) ? " is-wide" : "")}
                                  >
                                    <label className="cf-group-label">
                                      {/* Sized to fit its column, not its name - a
                                          route several levels deep still gets cut,
                                          and the tooltip is the one place the whole
                                          thing is guaranteed to be readable. */}
                                      <Tooltip title={m.trail[m.trail.length - 1]}>
                                        <span className="mono">{m.trail[m.trail.length - 1]}</span>
                                      </Tooltip>
                                      {/* A red star, the way every form has
                                          said "required" for thirty years. The
                                          word spelled out beside a third of the
                                          labels was three times the reading for
                                          the same fact. */}
                                      {p.validation?.required && (
                                        <Tooltip title="Required">
                                          <span className="cf-group-req" aria-label="required">*</span>
                                        </Tooltip>
                                      )}
                                      <FieldInfo param={p} />
                                    </label>
                                    <GroupField
                                      param={p}
                                      rules={rules}
                                      value={shown}
                                      committed={value}
                                      placeholder={mixed ? `${col.instances.length} different values` : undefined}
                                      locked={lockedReason(p, cell, canEdit)}
                                      status={refused[key] ? "error" : ""}
                                      onChange={(v) => setValue(key, v)}
                                    />
                                    {refused[key] && (
                                      <Typography.Text type="danger" className="cf-group-hint">
                                        {refused[key]}
                                      </Typography.Text>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </>
                    ) : (
                      // More than one thing being edited side by side. That is a
                      // comparison, and a comparison is a table: the settings
                      // run down, what they are being set on runs across, and
                      // the odd one out is visible without reading a label on
                      // every field.
                      <table className="cf-group-table">
                        <thead>
                          <tr>
                            <th className="cf-group-name">Setting</th>
                            {sec.cols.map((col) => (
                              <th key={col.key}>
                                <span className="mono">{col.label}</span>
                                {col.sub && <span className="cf-group-sub">{col.sub}</span>}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {sec.members.map((m) => {
                            const p = m.row.param;
                            const rules = rulesFor(p);
                            return (
                              <tr key={p.id}>
                                <th className="cf-group-name" scope="row">
                                  {/* Same label vocabulary as the form: the
                                      name, a star when it is required, and one
                                      glyph carrying the rest. */}
                                  <span className="cf-group-label">
                                    <span className="mono">{m.label}</span>
                                    {p.validation?.required && (
                                      <Tooltip title="Required">
                                        <span className="cf-group-req" aria-label="required">*</span>
                                      </Tooltip>
                                    )}
                                    <FieldInfo param={p} />
                                  </span>
                                </th>
                                {sec.cols.map((col) => {
                                  const key = `${p.id}|${col.key}`;
                                  const { value, mixed } = committedFor(m.row, col);
                                  const cell = cellFor(m.row, col);
                                  return (
                                    <td key={col.key}>
                                      <GroupField
                                        param={p}
                                        rules={rules}
                                        value={key in edits ? edits[key] : mixed ? undefined : value}
                                        committed={value}
                                        placeholder={mixed ? `${col.instances.length} different values` : undefined}
                                        locked={lockedReason(p, cell, canEdit)}
                                        status={refused[key] ? "error" : ""}
                                        onChange={(v) => setValue(key, v)}
                                      />
                                      {refused[key] && (
                                        <Typography.Text type="danger" style={{ fontSize: 11 }}>
                                          {refused[key]}
                                        </Typography.Text>
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </section>
                );
              })}
            </div>
          )}
          {/* Silent until something has actually changed. "Nothing changed
              yet" is a line of text that says only that the reader has not
              done anything, which they know. */}
          {pending.length > 0 && (
            <div className="cf-group-foot">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {pending.length} field{pending.length === 1 ? "" : "s"} changed
                {invalid.length ? `, ${invalid.length} not valid yet` : ""}.
              </Typography.Text>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/** "The rest of this site" as one click. An estate is worked on a site at a
 *  time, and picking four machines out of a list of twenty-three by hand is how
 *  the fifth gets forgotten. */
function SiteShortcut({
  instances,
  targets,
  onPick,
}: {
  instances: Instance[];
  targets: string[];
  onPick: (names: string[]) => void;
}) {
  const anchor = instances.find((i) => i.name === targets[0]);
  const site = (anchor?.site ?? anchor?.region ?? "").trim();
  if (!site) return null;
  const family = instances.filter((i) => ((i.site ?? i.region) ?? "").trim() === site);
  if (family.length < 2) return null;
  return (
    <Button size="small" type="link" style={{ padding: "0 4px" }} onClick={() => onPick(family.map((i) => i.name))}>
      All of {site} ({family.length})
    </Button>
  );
}

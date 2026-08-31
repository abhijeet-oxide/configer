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
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  nameSegments,
  type BatchEdit,
  type Grid,
  type Instance,
  type Parameter,
} from "../api";
import { useRepoQuery } from "../repoQuery";
import { effectiveRules, fmtValue } from "../rules";
import { effectiveScope, groupField, isGroupFacet, SCOPE_ICON, SCOPE_META, GROUP_FACETS, type ScopeFacet } from "../scope";
import { groupLeaf, groupTrail, trailLabel } from "../paramtree";
import { useIdentity } from "../identity";
import { useUI } from "../store";
import {
  CodeOutlined,
  FormOutlined,
  ScopeInstanceOutlined,
} from "../icons";
import EnvTag from "./EnvTag";
import { EmptyState, InlineNotice } from "./ui";
import { fieldError } from "./group/GroupField";
import GroupBody from "./group/GroupBody";
import {
  committedIndex,
  fieldIndex,
  rulesIndex,
  type Col,
  type Member,
  type Section,
} from "./group/model";
import { clearBusy } from "../busy";

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

/** What a section is called in the JSON view. Each group scope gets its own
 *  name: with all three under "groups", a zone value and a site value with the
 *  same key were one entry, and reading the block back put whichever came last
 *  into both. */
function blockName(facet: ScopeFacet): string {
  if (facet === "global") return "shared";
  if (isGroupFacet(facet)) return `${facet}s`;
  return "instances";
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

  // The pointer said "working" from the moment of the double click (see
  // busy.ts). It has arrived - and the effect runs after the first paint, so
  // the cursor changes back exactly when there is something to look at.
  useEffect(() => clearBusy(), []);

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

    // Each group scope gets its OWN section, one per grouping the selected
    // settings actually declare. They used to share one - "site" stood for all
    // three - which meant a zone-scoped setting and a site-scoped one were
    // edited in the same column under a heading naming only one of them, so a
    // value typed for a zone landed on a site and the dialog said it had not.
    for (const facet of GROUP_FACETS) {
      const sited = at(facet);
      if (!sited.length) continue;
      const field = SCOPE_META[facet].field ?? groupField(sited[0].row.param.scope) ?? "site";
      const cols: Col[] = [];
      const seen = new Map<string, Col>();
      for (const i of selected) {
        const key = (i[field] ?? "").trim();
        if (!key) continue;
        let col = seen.get(key);
        if (!col) {
          col = { key: `g:${field}:${key}`, label: key, sub: field, instances: [] };
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
        facet,
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

  // Everything the body asks per field, worked out ONCE. Each of these used to
  // be a function called inside the render of every field - and again by the
  // save, and again by the validity check - which on a branch of seven hundred
  // settings is thousands of scans per keystroke.
  const rules = useMemo(
    () => rulesIndex(members, (p) => effectiveRules(p, presetsQ.data)),
    [members, presetsQ.data],
  );
  const committed = useMemo(() => committedIndex(sections), [sections]);
  const fields = useMemo(() => fieldIndex(sections), [sections]);

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
          const c = committed.get(key);
          const v = key in edits ? edits[key] : c?.mixed ? null : c?.value;
          values[m.label] = v === undefined ? null : v;
        }
        if (sec.facet === "global") Object.assign(block, values);
        else block[col.label] = values;
      }
      doc[blockName(sec.facet)] = block;
    }
    return JSON.stringify(doc, null, 2);
  }, [sections, edits, committed]);

  // Only when it is being looked at. Built on every render it walked every
  // section, every column and every member and stringified the lot - on each
  // keystroke into a form that was not even showing it.
  const jsonValue = view === "json" ? jsonText ?? asJson() : "";

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
        setJsonError(
          `The document has to be an object with ${sections.map((sec) => blockName(sec.facet)).join(" / ")} in it.`,
        );
        return false;
      }
      const next: Record<string, unknown> = {};
      const unknown: string[] = [];
      const blocks = doc as Record<string, unknown>;
      for (const sec of sections) {
        const name = blockName(sec.facet);
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
    // The edits are the short list - typically a handful - and every one of
    // them names the field it belongs to. Walking every field looking for the
    // few that moved is the same answer at a thousand times the cost.
    for (const [key, value] of Object.entries(edits)) {
      const at = fields.get(key);
      if (!at) continue;
      const c = committed.get(key);
      if (c && !c.mixed && fmtValue(value) === fmtValue(c.value)) continue;
      out.push({ key, member: at.member, col: at.col, value });
    }
    return out;
  }, [edits, fields, committed]);

  const invalid = useMemo(
    () =>
      pending.filter((p) => {
        const c = committed.get(p.key);
        const r = rules.get(p.member.row.param.id) ?? {};
        return fieldError(p.member.row.param, r, p.value, c?.value) !== null;
      }),
    [pending, rules, committed],
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

  // ONE handler for every field, whatever the form's size. An arrow created per
  // field per render is a new prop on every field on every keystroke, which
  // defeats the memo on GroupField and re-renders the whole form to change one
  // character.
  const setValue = useCallback((key: string, v: unknown) => {
    setEdits((prev) => ({ ...prev, [key]: v }));
    setRefused((prev) => (key in prev ? { ...prev, [key]: "" } : prev));
    // The JSON view is a rendering of the edits; once the form moves it has to
    // be re-rendered rather than left showing the state before the keystroke.
    setJsonText(null);
  }, []);

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
                      {(() => { const Icon = SCOPE_ICON[sections[0].facet]; return <Icon style={{ marginInlineEnd: 4 }} />; })()}
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
            <GroupBody
              sections={sections}
              committed={committed}
              rules={rules}
              edits={edits}
              refused={refused}
              canEdit={canEdit}
              onChange={setValue}
              // A lone section names its scope in the header instead, where it
              // reads on the same line as the view toggle - two facts about the
              // same edit on one row. Two sections still name themselves, where
              // there is something to tell apart.
              showSectionHeads={sections.length > 1}
            />
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

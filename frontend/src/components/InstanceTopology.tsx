import { useMemo, useState } from "react";
import { Button, Modal } from "antd";
import { FileTextOutlined, TableOutlined } from "../icons";
import { bindingsOf, type Grid, type Instance } from "../api";
import { useUI } from "../store";
import { envHex } from "../theme";
import { StatusPill } from "./ui";

// InstanceTopology answers the question the table cannot: WHY does an instance
// hold the value it does. It lays the real inheritance chain out top to bottom
// - shared base files, then each environment, then the instances inside it
// (with region and how many values they inherit vs. override). Everything is
// derived from the grid's real bindings and cell provenance; nothing is
// invented. Clicking a base file opens it in Files; clicking an instance opens
// a dossier with "Open configuration". Without a shared base layer the base
// node simply says so - the map never goes blank.

interface BaseNode {
  file: string;
  params: number;
}
interface InstNode {
  name: string;
  environment?: string;
  overrides: number;
  inherited: number;
}
interface Edge {
  file: string;
  instance: string;
  count: number;
}

function derive(grid: Grid): { bases: BaseNode[]; insts: InstNode[]; edges: Edge[] } {
  // A binding is base-layer when it says so, or when its file template does
  // not depend on the instance (no {folder}/{instance} token).
  const isBase = (file: string, layer?: string) =>
    layer === "base" || (!file.includes("{folder}") && !file.includes("{instance}"));

  const baseParams = new Map<string, number>();
  const rowBaseFiles = new Map<string, string[]>();
  for (const r of grid.rows) {
    const files: string[] = [];
    for (const b of bindingsOf(r.param)) {
      if (b.file && isBase(b.file, b.layer)) files.push(b.file);
    }
    if (files.length) {
      rowBaseFiles.set(r.param.id, files);
      for (const f of files) baseParams.set(f, (baseParams.get(f) ?? 0) + 1);
    }
  }

  const edgeMap = new Map<string, Edge>();
  const insts: InstNode[] = grid.instances.map((i) => {
    let overrides = 0;
    let inherited = 0;
    for (const r of grid.rows) {
      const c = r.cells[i.name];
      if (!c || !c.set) continue;
      if (c.source === "instance") overrides++;
      if (c.source === "base") {
        inherited++;
        for (const f of rowBaseFiles.get(r.param.id) ?? []) {
          const key = `${f}|${i.name}`;
          const e = edgeMap.get(key) ?? { file: f, instance: i.name, count: 0 };
          e.count++;
          edgeMap.set(key, e);
        }
      }
    }
    return { name: i.name, environment: i.environment, overrides, inherited };
  });

  const bases = [...baseParams.entries()]
    .map(([file, params]) => ({ file, params }))
    .sort((a, b) => b.params - a.params || a.file.localeCompare(b.file));
  insts.sort(
    (a, b) => (a.environment ?? "").localeCompare(b.environment ?? "") || a.name.localeCompare(b.name),
  );
  return { bases, insts, edges: [...edgeMap.values()] };
}

// The dossier behind an instance click: what this instance is, then the
// explicit decision to jump into its filtered configuration sheet.
function InstanceDossier({
  node,
  meta,
  onClose,
}: {
  node: InstNode | null;
  meta?: Instance;
  onClose: () => void;
}) {
  const { setSection, selectInstance, setJump } = useUI();
  const rows: { label: string; value: React.ReactNode }[] = node
    ? [
        {
          label: "Environment",
          value: node.environment ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: envHex(node.environment) }} />
              {node.environment}
            </span>
          ) : (
            <span className="text-ink-3">not set</span>
          ),
        },
        ...(meta?.softwareVersion ? [{ label: "Software version", value: <span className="mono">{meta.softwareVersion}</span> }] : []),
        ...(meta?.region ? [{ label: "Region", value: meta.region }] : []),
        ...(meta?.folder ? [{ label: "Folder", value: <span className="mono text-xs">{meta.folder}</span> }] : []),
        { label: "Inherited from base", value: `${node.inherited} parameter${node.inherited === 1 ? "" : "s"}` },
        { label: "Local overrides", value: `${node.overrides} parameter${node.overrides === 1 ? "" : "s"}` },
      ]
    : [];
  return (
    <Modal
      open={!!node}
      onCancel={onClose}
      title={
        node && (
          <span className="inline-flex items-center gap-2">
            <span className="size-2 rounded-full" style={{ background: envHex(node.environment) }} />
            <span className="mono">{node.name}</span>
          </span>
        )
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Close</Button>
          <Button
            type="primary"
            icon={<TableOutlined />}
            onClick={() => {
              if (!node) return;
              selectInstance(node.name);
              setJump("instance", node.name);
              setSection("config");
              onClose();
            }}
          >
            Open configuration
          </Button>
        </div>
      }
      width={420}
    >
      <div className="flex flex-col gap-2 py-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-4 text-[13px]">
            <span className="text-ink-3">{r.label}</span>
            <span className="text-right text-ink">{r.value}</span>
          </div>
        ))}
        <div className="mt-1 text-xs text-ink-3">
          Opening the configuration filters the editor to this instance only.
        </div>
      </div>
    </Modal>
  );
}

// One instance leaf in the hierarchy: name, region, and the inherited/override
// split that explains where its values come from.
function InstanceRow({
  node,
  region,
  version,
  onClick,
}: {
  node: InstNode;
  region?: string;
  version?: string;
  onClick: () => void;
}) {
  return (
    <div
      className="card-clickable flex cursor-pointer items-center gap-2.5 rounded-card bg-surface px-3 py-2 shadow-neu"
      onClick={onClick}
      title={`${node.name}: instance details`}
    >
      <span className="size-2 shrink-0 rounded-full" style={{ background: envHex(node.environment) }} />
      <span className="mono flex-1 overflow-hidden text-xs text-ellipsis whitespace-nowrap">{node.name}</span>
      {region && <span className="text-[11px] text-ink-3">{region}</span>}
      {version && <span className="mono text-[11px] text-ink-3">{version}</span>}
      <span className="text-[11px] text-ink-3" title="Values inherited from the base layer">
        {node.inherited} inherited
      </span>
      {node.overrides > 0 && (
        <StatusPill tone="review" size="sm" dot={false}>
          {node.overrides} override{node.overrides === 1 ? "" : "s"}
        </StatusPill>
      )}
    </div>
  );
}

export default function InstanceTopology({ grid }: { grid: Grid }) {
  const { setSection, setFileFocus } = useUI();
  const [selInst, setSelInst] = useState<InstNode | null>(null);
  const { bases, insts } = useMemo(() => derive(grid), [grid]);

  const metaOf = (name: string) => grid.instances.find((i) => i.name === name);
  const dossier = (
    <InstanceDossier node={selInst} meta={selInst ? metaOf(selInst.name) : undefined} onClose={() => setSelInst(null)} />
  );

  // Group instances by environment - the middle layer of the inheritance
  // chain. `insts` is already sorted by environment then name.
  const envGroups = useMemo(() => {
    const m = new Map<string, InstNode[]>();
    for (const x of insts) {
      const e = x.environment || "other";
      m.set(e, [...(m.get(e) ?? []), x]);
    }
    return [...m.entries()];
  }, [insts]);

  return (
    <div className="h-full overflow-auto">
      <div className="mb-3 px-1 text-xs text-ink-3">
        How each instance gets its values: the shared base layer flows down into every environment,
        and each instance adds its own overrides on top. Click a file to open it, or an instance for details.
      </div>

      <div className="flex max-w-3xl flex-col gap-2">
        {/* Base layer */}
        {bases.length > 0 ? (
          bases.map((b) => (
            <div
              key={b.file}
              className="card-clickable flex cursor-pointer items-center gap-2 rounded-card bg-surface px-3 py-2 shadow-neu"
              onClick={() => {
                setFileFocus({ path: b.file });
                setSection("files");
              }}
              title={`${b.file}: open in Files`}
            >
              <FileTextOutlined style={{ color: "var(--brand)" }} />
              <span className="mono flex-1 overflow-hidden text-xs text-ellipsis whitespace-nowrap">{b.file}</span>
              <span className="text-[11px] text-ink-3">
                base layer · {b.params} parameter{b.params === 1 ? "" : "s"}
              </span>
            </div>
          ))
        ) : (
          <div className="rounded-card border border-dashed border-line-strong bg-surface/60 px-3 py-2 text-xs text-ink-3">
            No shared base layer: every value lives in each instance's own files.
          </div>
        )}

        {/* Environment groups, indented under the base to show inheritance. */}
        <div className="ml-3 flex flex-col gap-3 border-l border-line pl-4 pt-1">
          {envGroups.map(([env, group]) => (
            <div key={env} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="size-2.5 rounded-full" style={{ background: envHex(env) }} />
                <span className="text-[13px] font-semibold capitalize text-ink">{env}</span>
                <span className="text-[11px] text-ink-3">
                  {group.length} instance{group.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="ml-3 flex flex-col gap-1.5 border-l border-line pl-4">
                {group.map((x) => {
                  const meta = metaOf(x.name);
                  return (
                    <InstanceRow
                      key={x.name}
                      node={x}
                      region={meta?.region}
                      version={meta?.softwareVersion}
                      onClick={() => setSelInst(x)}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      {dossier}
    </div>
  );
}

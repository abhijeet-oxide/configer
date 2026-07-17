import { useMemo, useState } from "react";
import { ApartmentOutlined, FileTextOutlined } from "../icons";
import { bindingsOf, type Grid } from "../api";
import { useUI } from "../store";
import { envHex } from "../theme";
import { EmptyState, StatusPill } from "./ui";

// InstanceTopology answers relationship questions the table cannot: which
// shared base files do instances inherit from, which instances share a
// baseline, and where do local overrides live. Everything is derived from
// the grid's real bindings and cell provenance; nothing is invented. Base
// files sit left, instances right (grouped by environment); an edge's weight
// is how many parameters flow across it. Clicking a file opens it in the
// Files workspace; clicking an instance jumps to its column in the editor.

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

const NODE_W = 250;
const ROW_H = 60;
const PAD = 16;

export default function InstanceTopology({ grid }: { grid: Grid }) {
  const { setSection, setFileFocus, selectInstance, setJump } = useUI();
  const [hover, setHover] = useState<{ kind: "base" | "inst"; key: string } | null>(null);
  const { bases, insts, edges } = useMemo(() => derive(grid), [grid]);

  if (bases.length === 0) {
    return (
      <EmptyState
        icon={<ApartmentOutlined />}
        title="No shared base layer to visualize"
        hint="Every parameter here is instance-scoped, so there are no inheritance relationships between files and instances. The table view carries everything."
      />
    );
  }

  const H = Math.max(bases.length, insts.length) * ROW_H + PAD * 2;
  const W = 860;
  const leftX = PAD;
  const rightX = W - NODE_W - PAD;
  const yFor = (i: number, n: number) => PAD + ((H - PAD * 2) / n) * (i + 0.5);
  const maxCount = Math.max(...edges.map((e) => e.count), 1);

  const baseIdx = new Map(bases.map((b, i) => [b.file, i]));
  const instIdx = new Map(insts.map((x, i) => [x.name, i]));

  const active = (e: Edge) =>
    !hover || (hover.kind === "base" ? hover.key === e.file : hover.key === e.instance);

  return (
    <div className="h-full overflow-auto">
      <div className="mb-1 flex items-center gap-4 px-1 text-xs text-ink-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-6 rounded" style={{ background: "var(--brand)" }} />
          parameters shared from a base file
        </span>
        <span className="inline-flex items-center gap-1.5">
          <StatusPill tone="review" size="sm" dot={false}>n overrides</StatusPill>
          values set locally on the instance
        </span>
      </div>
      <div className="relative" style={{ width: W, height: H }}>
        <svg width={W} height={H} className="absolute inset-0">
          {edges.map((e) => {
            const bi = baseIdx.get(e.file);
            const ii = instIdx.get(e.instance);
            if (bi === undefined || ii === undefined) return null;
            const y1 = yFor(bi, bases.length);
            const y2 = yFor(ii, insts.length);
            const x1 = leftX + NODE_W;
            const x2 = rightX;
            const mid = (x1 + x2) / 2;
            const on = active(e);
            return (
              <path
                key={`${e.file}|${e.instance}`}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke={on ? "var(--brand)" : "var(--brand-border)"}
                strokeOpacity={on ? 0.8 : 0.25}
                strokeWidth={1.5 + (e.count / maxCount) * 3.5}
                style={{ transition: "stroke-opacity var(--dur-hover) var(--ease)" }}
              >
                <title>
                  {e.count} parameter{e.count === 1 ? "" : "s"} inherited from {e.file}
                </title>
              </path>
            );
          })}
        </svg>
        {bases.map((b, i) => (
          <div
            key={b.file}
            className="card-clickable absolute flex cursor-pointer items-center gap-2 rounded-card bg-surface px-3 py-2 shadow-neu"
            style={{ left: leftX, top: yFor(i, bases.length) - 22, width: NODE_W, height: 44 }}
            onMouseEnter={() => setHover({ kind: "base", key: b.file })}
            onMouseLeave={() => setHover(null)}
            onClick={() => {
              setFileFocus({ path: b.file });
              setSection("files");
            }}
            title={`${b.file}: open in Files`}
          >
            <FileTextOutlined style={{ color: "var(--brand)" }} />
            <div className="min-w-0 flex-1">
              <div className="mono overflow-hidden text-xs text-ellipsis whitespace-nowrap">{b.file}</div>
              <div className="text-[11px] text-ink-3">{b.params} parameter{b.params === 1 ? "" : "s"}</div>
            </div>
          </div>
        ))}
        {insts.map((x, i) => (
          <div
            key={x.name}
            className="card-clickable absolute flex cursor-pointer items-center gap-2 rounded-card bg-surface px-3 py-2 shadow-neu"
            style={{ left: rightX, top: yFor(i, insts.length) - 22, width: NODE_W, height: 44 }}
            onMouseEnter={() => setHover({ kind: "inst", key: x.name })}
            onMouseLeave={() => setHover(null)}
            onClick={() => {
              selectInstance(x.name);
              setJump("instance", x.name);
              setSection("config");
            }}
            title={`${x.name}: open its column in the editor`}
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: envHex(x.environment) }}
              title={x.environment}
            />
            <div className="min-w-0 flex-1">
              <div className="mono overflow-hidden text-xs text-ellipsis whitespace-nowrap">{x.name}</div>
              <div className="text-[11px] text-ink-3">{x.inherited} inherited</div>
            </div>
            {x.overrides > 0 && (
              <StatusPill tone="review" size="sm" dot={false}>
                {x.overrides}
              </StatusPill>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

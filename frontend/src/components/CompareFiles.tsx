import { lazy, Suspense, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Segmented } from "antd";
import { api, sameContent, type Grid } from "../api";
import { useUI } from "../store";
import { vsFileIcon } from "./vsIcons";
import { InSyncArt, EmptyArt } from "./illustrations";
import { FilesSkeleton } from "./Skeletons";
import { ChangeChip, EmptyState, LoadingStage, type ChangeKind } from "./ui";

const MonacoFileView = lazy(() => import("./MonacoFileView"));

// CompareFiles answers "what actual repository content is different?"
// between the two compare sides. The backend has no file-diff endpoint, so
// this renders each side's real files (working draft, committed baseline, or
// a git ref) and diffs client-side. Paths are aligned across instances by
// re-keying each side's instance folder to a shared role path, so
// instances/a/values.yaml and instances/b/values.yaml compare as one file.

/** the pseudo-ref for "committed, without the draft applied" */
export const COMMITTED = "@committed";

interface SideSpec {
  instance: string;
  ref: string; // "" = working draft, COMMITTED, or a real git ref
}

function useRendered(side: SideSpec) {
  return useQuery({
    queryKey: ["render-cmp", side.instance, side.ref],
    queryFn: () =>
      side.ref === COMMITTED
        ? api.render(side.instance, { draft: false })
        : side.ref
          ? api.render(side.instance, { ref: side.ref })
          : api.render(side.instance),
    enabled: !!side.instance,
  });
}

interface FileRow {
  role: string;
  leftPath?: string;
  rightPath?: string;
  left?: string;
  right?: string;
  kind: ChangeKind;
}

export default function CompareFiles({
  grid,
  left,
  right,
}: {
  grid: Grid;
  left: SideSpec;
  right: SideSpec;
}) {
  const mode = useUI((s) => s.mode);
  const [pill, setPill] = useState<"changed" | "all" | "added" | "removed" | "modified">("changed");
  const [selected, setSelected] = useState<string | null>(null);

  const leftQ = useRendered(left);
  const rightQ = useRendered(right);

  const folderOf = (name: string) =>
    grid.instances.find((i) => i.name === name)?.folder || `instances/${name}`;

  const rows = useMemo<FileRow[]>(() => {
    const lFolder = folderOf(left.instance);
    const rFolder = folderOf(right.instance);
    const role = (path: string, folder: string) =>
      path.startsWith(folder + "/") ? `{instance}/${path.slice(folder.length + 1)}` : path;
    const map = new Map<string, FileRow>();
    for (const f of leftQ.data?.files ?? []) {
      const r = role(f.path, lFolder);
      map.set(r, { role: r, leftPath: f.path, left: f.content, kind: "removed" });
    }
    for (const f of rightQ.data?.files ?? []) {
      const r = role(f.path, rFolder);
      const e = map.get(r);
      if (e) {
        e.rightPath = f.path;
        e.right = f.content;
        e.kind = sameContent(e.left, f.content) ? "unchanged" : "modified";
      } else {
        map.set(r, { role: r, rightPath: f.path, right: f.content, kind: "added" });
      }
    }
    return [...map.values()].sort((a, b) => a.role.localeCompare(b.role));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftQ.data, rightQ.data, left.instance, right.instance]);

  const counts = useMemo(() => {
    let modified = 0;
    let added = 0;
    let removed = 0;
    for (const r of rows) {
      if (r.kind === "modified") modified++;
      else if (r.kind === "added") added++;
      else if (r.kind === "removed") removed++;
    }
    return { modified, added, removed, changed: modified + added + removed };
  }, [rows]);

  const visible = rows.filter((r) => {
    if (pill === "all") return true;
    if (pill === "changed") return r.kind !== "unchanged";
    return r.kind === pill;
  });
  const current = visible.find((r) => r.role === selected) ?? visible[0];

  if (leftQ.isLoading || rightQ.isLoading) {
    return (
      <LoadingStage
        stage={
          leftQ.isLoading
            ? `Rendering files for ${left.instance}…`
            : `Rendering files for ${right.instance}…`
        }
        skeleton={<FilesSkeleton />}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Segmented
          size="small"
          value={pill}
          onChange={(v) => setPill(v as typeof pill)}
          options={[
            { value: "changed", label: `Changed${counts.changed ? ` (${counts.changed})` : ""}` },
            { value: "all", label: "All" },
            { value: "modified", label: `Modified${counts.modified ? ` (${counts.modified})` : ""}` },
            { value: "added", label: `Added${counts.added ? ` (${counts.added})` : ""}` },
            { value: "removed", label: `Removed${counts.removed ? ` (${counts.removed})` : ""}` },
          ]}
        />
        <span className="text-xs text-ink-3">
          {"{instance}"} stands for each side's own folder
        </span>
      </div>
      {visible.length === 0 ? (
        <EmptyState
          art={pill === "changed" ? <InSyncArt size={112} /> : <EmptyArt size={96} />}
          title={pill === "changed" ? "No file differences between these sides." : "No files to show."}
          hint={pill === "changed" ? "The rendered repository content is identical." : undefined}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-[290px] shrink-0 overflow-auto border-r border-line py-1">
            {visible.map((r) => (
              <div
                key={r.role}
                onClick={() => setSelected(r.role)}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs ${
                  current?.role === r.role ? "bg-brand-soft" : "hover:bg-surface-2"
                }`}
              >
                {vsFileIcon(r.role.split("/").pop() ?? r.role)}
                <span className="mono min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap" title={r.role}>
                  {r.role}
                </span>
                <ChangeChip kind={r.kind} />
              </div>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            {current && (
              <Suspense fallback={<FilesSkeleton />}>
                <MonacoFileView
                  key={current.role}
                  path={current.rightPath ?? current.leftPath ?? current.role}
                  content={current.right ?? ""}
                  original={current.left ?? ""}
                  dark={mode === "dark"}
                />
              </Suspense>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

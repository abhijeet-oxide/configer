import { Button, Input, Modal, Select, Table } from "antd";
import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { SearchOutlined, TableOutlined, ClusterOutlined } from "../icons";
import { api, type Instance } from "../api";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";
import { envHex } from "../theme";
import { TableSkeleton } from "./Skeletons";
import { SectionCard, EmptyState } from "./ui";
import { EmptyArt } from "./illustrations";

// InstancesOverview is the WORKSPACE-WIDE estate behind the rail's Instances
// entry: every deployment target of every application in one filterable
// table (application, environment, free-text search). Clicking a row opens a
// small dossier; from there one click lands on the owning application's
// editor, filtered to that instance, or on its Instances tab.

interface EstateRow {
  key: string;
  repoId: string;
  repoName: string;
  inst: Instance;
}

function EnvDot({ env }: { env?: string }) {
  return <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: envHex(env) }} />;
}

export default function InstancesOverview() {
  const { repoId, setSection, selectInstance, setJump } = useUI();
  const switchRepo = useSwitchRepo();
  const [app, setApp] = useState("");
  const [env, setEnv] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<EstateRow | null>(null);

  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });
  const repos = wsQ.data?.repos ?? [];
  const instQs = useQueries({
    queries: repos.map((r) => ({
      queryKey: ["estate-instances", r.id],
      queryFn: () => api.instancesOf(r.id),
      staleTime: 30_000,
    })),
  });

  const all: EstateRow[] = [];
  repos.forEach((r, i) => {
    for (const inst of instQs[i]?.data?.instances ?? [])
      all.push({ key: `${r.id}:${inst.name}`, repoId: r.id, repoName: r.name, inst });
  });
  const environments = [...new Set(all.map((r) => r.inst.environment).filter(Boolean))].sort() as string[];
  const needle = q.trim().toLowerCase();
  const shown = all
    .filter((r) => !app || r.repoId === app)
    .filter((r) => !env || r.inst.environment === env)
    .filter(
      (r) =>
        !needle ||
        r.inst.name.toLowerCase().includes(needle) ||
        (r.inst.region ?? "").toLowerCase().includes(needle) ||
        (r.inst.folder ?? "").toLowerCase().includes(needle) ||
        r.repoName.toLowerCase().includes(needle),
    )
    .sort(
      (a, b) =>
        a.repoName.localeCompare(b.repoName) ||
        (a.inst.environment ?? "").localeCompare(b.inst.environment ?? "") ||
        a.inst.name.localeCompare(b.inst.name),
    );

  const loading = wsQ.isLoading || (repos.length > 0 && instQs.some((x) => x.isLoading));

  // Both actions land inside the owning application; switching the active
  // repository clears per-app state, so the instance selection comes after.
  const openConfig = (row: EstateRow) => {
    if (row.repoId !== repoId) switchRepo(row.repoId);
    selectInstance(row.inst.name);
    setJump("instance", row.inst.name);
    setSection("config");
    setSel(null);
  };
  const openInstancesTab = (row: EstateRow) => {
    if (row.repoId !== repoId) switchRepo(row.repoId);
    setSection("instances");
    setSel(null);
  };

  const dossierRows = sel
    ? ([
        { label: "Application", value: sel.repoName },
        {
          label: "Environment",
          value: sel.inst.environment ? (
            <span className="inline-flex items-center gap-1.5">
              <EnvDot env={sel.inst.environment} />
              {sel.inst.environment}
            </span>
          ) : (
            <span className="text-ink-3">not set</span>
          ),
        },
        ...(sel.inst.softwareVersion
          ? [{
              label: "Version",
              value: (
                <span>
                  {sel.inst.versionName || sel.inst.softwareVersion}
                  {sel.inst.versionName && sel.inst.versionName !== sel.inst.softwareVersion && (
                    <span className="mono text-ink-3" style={{ marginLeft: 6, fontSize: 11 }}>{sel.inst.softwareVersion}</span>
                  )}
                </span>
              ),
            }]
          : []),
        ...(sel.inst.region ? [{ label: "Region", value: sel.inst.region }] : []),
        ...(sel.inst.site ? [{ label: "Site", value: sel.inst.site }] : []),
        ...(sel.inst.folder
          ? [{ label: "Folder", value: <span className="mono text-xs">{sel.inst.folder}</span> }]
          : []),
        ...(sel.inst.status ? [{ label: "Status", value: sel.inst.status }] : []),
      ] as { label: string; value: React.ReactNode }[])
    : [];

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto bg-canvas px-6 py-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xl font-semibold text-ink">Instances</div>
          <div className="text-[13px] text-ink-2">
            All deployment targets across your applications
            {all.length > 0 && `: ${all.length} instance${all.length === 1 ? "" : "s"} across ${repos.length} application${repos.length === 1 ? "" : "s"}`}
            .
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            size="small"
            value={app}
            onChange={setApp}
            style={{ width: 180 }}
            options={[
              { value: "", label: "All applications" },
              ...repos.map((r) => ({ value: r.id, label: r.name })),
            ]}
          />
          <Select
            size="small"
            value={env}
            onChange={setEnv}
            style={{ width: 150 }}
            options={[
              { value: "", label: "All environments" },
              ...environments.map((e) => ({ value: e, label: e })),
            ]}
          />
          <Input
            size="small"
            allowClear
            prefix={<SearchOutlined style={{ opacity: 0.5 }} />}
            placeholder="Search instances"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 200 }}
          />
        </div>
      </div>

      {loading ? (
        <TableSkeleton />
      ) : shown.length === 0 ? (
        <SectionCard>
          <EmptyState
            art={<EmptyArt size={104} />}
            title={all.length === 0 ? "No instances" : "No matching instances"}
            hint={
              all.length === 0
                ? "Connect an application to manage its deployment targets."
                : "Adjust the application, environment or search filter to see more."
            }
          />
        </SectionCard>
      ) : (
        <SectionCard padded={false}>
          <Table<EstateRow>
            className="cr-table"
            rowKey="key"
            size="small"
            dataSource={shown}
            pagination={false}
            onRow={(row) => ({ onClick: () => setSel(row), style: { cursor: "pointer" } })}
            columns={[
              {
                title: "Instance",
                render: (_v, r) => (
                  <span className="inline-flex items-center gap-2">
                    <EnvDot env={r.inst.environment} />
                    <span className="mono">{r.inst.name}</span>
                  </span>
                ),
              },
              {
                title: "Application",
                width: 180,
                ellipsis: true,
                render: (_v, r) => <span className="text-ink-2">{r.repoName}</span>,
              },
              {
                title: "Environment",
                width: 140,
                render: (_v, r) => r.inst.environment ?? <span className="text-ink-3">-</span>,
              },
              {
                title: "Version",
                width: 130,
                render: (_v, r) => {
                  const id = r.inst.softwareVersion;
                  if (!id) return <span className="text-ink-3">-</span>;
                  const name = r.inst.versionName || id;
                  return (
                    <span className="inline-flex flex-col leading-tight">
                      <span className="text-xs">{name}</span>
                      {r.inst.versionName && r.inst.versionName !== id && (
                        <span className="mono text-ink-3" style={{ fontSize: 10 }}>{id}</span>
                      )}
                    </span>
                  );
                },
              },
              {
                title: "Folder",
                ellipsis: true,
                render: (_v, r) =>
                  r.inst.folder ? (
                    <span className="mono text-xs text-ink-3">{r.inst.folder}</span>
                  ) : null,
              },
            ]}
          />
        </SectionCard>
      )}

      <Modal
        open={!!sel}
        onCancel={() => setSel(null)}
        title={
          sel && (
            <span className="inline-flex items-center gap-2">
              <EnvDot env={sel.inst.environment} />
              <span className="mono">{sel.inst.name}</span>
            </span>
          )
        }
        footer={
          sel && (
            <div className="flex justify-end gap-2">
              <Button icon={<ClusterOutlined />} onClick={() => openInstancesTab(sel)}>
                Instances tab
              </Button>
              <Button type="primary" icon={<TableOutlined />} onClick={() => openConfig(sel)}>
                Open configuration
              </Button>
            </div>
          )
        }
        width={430}
      >
        <div className="flex flex-col gap-2 py-1">
          {dossierRows.map((r) => (
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
    </div>
  );
}

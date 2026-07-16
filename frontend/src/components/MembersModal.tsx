import { App as AntApp, Avatar, Button, Modal, Select, Space, Table, Tag, Typography } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AuthUser, type RoleName } from "../api";

// MembersModal is where deployment admins assign per-application roles:
// viewer (read only), editor (stage and submit changes), approver (may also
// publish/merge). Everyone signed in sees every application; the registry
// is shared; roles only decide what they can DO there. Users without an
// explicit assignment get the deployment default.

const roleOptions: { value: RoleName; label: string }[] = [
  { value: "viewer", label: "viewer; read only" },
  { value: "editor", label: "editor; stage & submit changes" },
  { value: "approver", label: "approver; also publish (merge)" },
];

const roleColor: Record<string, string> = { viewer: "default", editor: "blue", approver: "green" };

export default function MembersModal({
  open,
  onClose,
  repoId,
}: {
  open: boolean;
  onClose: () => void;
  repoId: string;
}) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["members", repoId],
    queryFn: () => api.members(repoId),
    enabled: open,
  });
  const done = () => qc.invalidateQueries({ queryKey: ["members", repoId] });

  const set = useMutation({
    mutationFn: (p: { login: string; role: RoleName }) => api.setMember(repoId, p.login, p.role),
    onSuccess: done,
    onError: (e: Error) => message.error(e.message),
  });
  const clear = useMutation({
    mutationFn: (login: string) => api.removeMember(repoId, login),
    onSuccess: done,
    onError: (e: Error) => message.error(e.message),
  });

  const assigned = new Map((q.data?.members ?? []).map((m) => [m.login, m.role]));

  return (
    <Modal title="People & roles" open={open} onCancel={onClose} footer={null} width={640}>
      <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>
        Everyone who signs in sees this application (it is initialized once, in Git, for all).
        Roles decide what they can do. Users without an explicit role act as{" "}
        <Tag color={roleColor[q.data?.defaultRole ?? "editor"]} style={{ marginInlineEnd: 0 }}>
          {q.data?.defaultRole ?? "editor"}
        </Tag>
        .
      </Typography.Paragraph>
      <Table<AuthUser>
        size="small"
        rowKey="login"
        loading={q.isLoading}
        dataSource={q.data?.users ?? []}
        pagination={false}
        locale={{ emptyText: "Nobody has signed in yet. Users appear here after their first login." }}
        columns={[
          {
            title: "User",
            render: (_v, u) => (
              <Space>
                <Avatar size={22} src={u.avatarUrl || undefined}>
                  {(u.name || u.login).slice(0, 2).toUpperCase()}
                </Avatar>
                <span>
                  <b>{u.name || u.login}</b>{" "}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {u.login}
                  </Typography.Text>
                </span>
                {u.admin && <Tag color="purple">admin</Tag>}
              </Space>
            ),
          },
          {
            title: "Role on this application",
            width: 280,
            render: (_v, u) => {
              const explicit = assigned.get(u.login);
              return (
                <Space size={6}>
                  <Select
                    size="small"
                    style={{ width: 200 }}
                    placeholder={`default (${q.data?.defaultRole ?? "editor"})`}
                    value={explicit}
                    options={roleOptions}
                    onChange={(role) => set.mutate({ login: u.login, role })}
                    disabled={u.admin}
                  />
                  {explicit && !u.admin && (
                    <Button size="small" type="text" onClick={() => clear.mutate(u.login)}>
                      reset
                    </Button>
                  )}
                </Space>
              );
            },
          },
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10 }}>
        Deployment admins (CONFIGER_ADMINS) always act as approvers everywhere.
      </Typography.Paragraph>
    </Modal>
  );
}

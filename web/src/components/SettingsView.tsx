import { useState } from "react";
import { Button, Space, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import {
  AccessibilityOutlined,
  ApiOutlined,
  ExportOutlined,
  LogoutOutlined,
  PaletteOutlined,
  SparkleOutlined,
  SwaggerOutlined,
  UserOutlined,
} from "../icons";
import { api } from "../api";
import { useUI } from "../store";
import { useIdentity } from "../identity";
import { useSignOut } from "../useSignOut";
import { useDeployment } from "../deployment";
import { envHex } from "../theme";
import { appUrl } from "../authkit/base";
import { Field, Muted, ProfilePage, ProfileSection, profileTab, type ProfileTab } from "../accountkit";
import { AccessPill } from "./AppCard";

// The platform's Profile page (accountkit), the same one Software Gateway
// shows, with ArtiAuto's own sections under it.
export default function SettingsView() {
  const identity = useIdentity();
  const { setSection, setWelcomeOpen } = useUI();
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });
  const logout = useSignOut();
  const deployment = useDeployment();
  const meta = deployment.reachable ? deployment : null;
  const apps = (wsQ.data?.repos ?? []).filter((r) => !r.status);
  const [tab, setTab] = useState<ProfileTab>(() => profileTab(new URLSearchParams(window.location.search).get("tab")));

  return (
    <div style={{ height: "100%", overflow: "auto", background: "var(--canvas)", padding: "28px 32px 48px" }}>
      <ProfilePage
        name={identity.user?.name}
        email={identity.user?.email}
        subject={identity.user?.login}
        loading={identity.loading}
        anonymous={!identity.authEnabled && !identity.loading}
        tab={tab}
        onTab={setTab}
        onSignOut={() => logout.mutate()}
        signOutButton={(onClick) => (
          <Button danger icon={<LogoutOutlined />} onClick={onClick} loading={logout.isPending}>
            Sign out
          </Button>
        )}
        tabIcons={{ profile: <UserOutlined />, accessibility: <AccessibilityOutlined />, appearance: <PaletteOutlined /> }}
        badges={
          identity.admin && (
            <Space size={[7, 6]} wrap>
              <Tag color="processing" style={{ marginInlineEnd: 0, fontWeight: 600 }}>
                Admin
              </Tag>
            </Space>
          )
        }
        signInFields={<Field label="Method">Single sign-on</Field>}
      >
        <ProfileSection label={`Applications${apps.length ? ` (${apps.length})` : ""}`}>
          {apps.length === 0 ? (
            <Muted>No applications you can see yet. Access is granted per product by an administrator.</Muted>
          ) : (
            apps.map((r) => (
              <Field key={r.id} label={r.name}>
                <AccessPill r={r} />
              </Field>
            ))
          )}
        </ProfileSection>

        <ProfileSection label="This deployment">
          <Field label={meta ? `${meta.name} ${meta.version}` : "ArtiAuto"}>
            {meta ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: 4, background: envHex(meta.environment) }} />
                {meta.environment} environment
              </span>
            ) : (
              <Muted>Deployment details are unavailable right now.</Muted>
            )}
          </Field>
          <Field label="Tools">
            <Space size={8} wrap>
              <Button
                icon={<SwaggerOutlined />}
                onClick={() => window.open(appUrl("/api/docs"), "_blank", "noopener,noreferrer")}
              >
                API documentation <ExportOutlined style={{ fontSize: "var(--text-caption)", opacity: 0.6 }} />
              </Button>
              <Button icon={<SparkleOutlined />} onClick={() => setWelcomeOpen(true)}>
                Replay tour
              </Button>
              {identity.admin && (
                <Button icon={<ApiOutlined />} onClick={() => setSection("plugins")}>
                  View plugins
                </Button>
              )}
            </Space>
          </Field>
        </ProfileSection>
      </ProfilePage>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Button, Divider, Typography } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExportOutlined,
  LogoutOutlined,
  SparkleOutlined,
  SwaggerOutlined,
  TeamOutlined,
  ApiOutlined,
} from "../icons";
import { api } from "../api";
import { useUI } from "../store";
import { useIdentity } from "../identity";
import { useTimeSettings } from "../timefmt";
import { envHex } from "../theme";
import { zoneOffsetLabel } from "../settings";
import { StatusPill, SectionCard } from "./ui";
import MembersModal from "./MembersModal";
import {
  DensityControl,
  FontScaleControl,
  HourCycleControl,
  ThemeControl,
  TimeZoneControl,
} from "./PreferenceControls";

// The Settings page: everything personal in one calm place - who you are,
// how Configer looks, and how it tells time. Reached from the rail's profile
// card and the top-bar avatar menu. Every control applies instantly (there is
// no Save button to forget) and persists on this device.
//
// Structure is one Row per setting inside one SectionCard per topic; adding a
// future setting is one row here plus its control in PreferenceControls.

// Row is the settings primitive: name + plain-words description on the left,
// the control on the right; wide controls (the theme tiles) stack below.
function Row({
  title,
  description,
  control,
  stacked = false,
}: {
  title: string;
  description?: React.ReactNode;
  control: React.ReactNode;
  stacked?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: stacked ? "column" : "row",
        alignItems: stacked ? "stretch" : "center",
        justifyContent: "space-between",
        gap: stacked ? 12 : 24,
        flexWrap: "wrap",
        padding: "10px 0",
      }}
    >
      <div style={{ minWidth: 220, flex: stacked ? undefined : "1 1 220px" }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        {description && (
          <div style={{ fontSize: "var(--fs-12)", color: "var(--text-2)", marginTop: 2, maxWidth: 480 }}>
            {description}
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0, minWidth: 0 }}>{control}</div>
    </div>
  );
}

const ROLE_EXPLANATION: Record<string, string> = {
  Viewer: "You can browse every configuration but not change it.",
  Editor: "You can edit values and submit changes for review.",
  Approver: "You can review, approve and publish changes.",
  Administrator: "You manage people, roles and every application on this deployment.",
  "Full access": "This deployment runs in single-user mode, so every capability is yours.",
};

// LiveClock proves the time-zone choice instantly: the current time, in the
// chosen zone, ticking. Subscribes to the time settings so it re-renders the
// moment either control changes.
function LiveClock() {
  const { timeZone, hourCycle } = useTimeSettings();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const text = new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "medium",
    timeZone,
    hour12: hourCycle === "h12" ? true : hourCycle === "h23" ? false : undefined,
  }).format(now);
  return (
    <div style={{ fontSize: "var(--fs-12)", color: "var(--text-2)", display: "flex", alignItems: "center", gap: 8 }}>
      <span className="settings-clock-dot" />
      {text} · {zoneOffsetLabel(timeZone)}
    </div>
  );
}

export default function SettingsView() {
  const identity = useIdentity();
  const { repoId, setSection, setWelcomeOpen } = useUI();
  const qc = useQueryClient();
  const metaQ = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: 300_000 });
  const wsQ = useQuery({ queryKey: ["workspace"], queryFn: api.workspace, staleTime: 30_000 });
  const [membersOpen, setMembersOpen] = useState(false);
  const logout = useMutation({ mutationFn: api.logout, onSuccess: () => qc.invalidateQueries() });

  const meta = metaQ.data;
  const activeApp = wsQ.data?.repos.find((r) => r.id === repoId);
  const roleExplains = ROLE_EXPLANATION[identity.roleLabel] ?? "";

  const avatar = identity.user?.avatarUrl ? (
    <img className="settings-avatar" src={identity.user.avatarUrl} alt="" />
  ) : (
    <span className="settings-avatar settings-avatar-initials">
      {(identity.displayName || "?").slice(0, 2).toUpperCase()}
    </span>
  );

  return (
    <div style={{ height: "100%", overflow: "auto", background: "var(--canvas)" }}>
      {/* Wide screens get the width back: the hero spans the page and the
          section cards flow into as many columns as fit (aligned to their own
          tops), collapsing to one column on narrow windows. No width cap -
          every monitor is used edge to edge; readability comes from the
          per-card column width, not from a centered well. */}
      <div style={{ padding: "28px 32px 48px" }}>
        {/* ---- profile hero: the person this page belongs to. Reserves its
             height while identity loads so the page never jumps. ---- */}
        <div
          style={{
            display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
            marginBottom: 24, minHeight: 56,
            visibility: identity.loading ? "hidden" : "visible",
          }}
        >
          {avatar}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <Typography.Title level={4} style={{ margin: 0 }}>
                {identity.displayName}
              </Typography.Title>
              {identity.roleLabel && (
                <StatusPill tone={identity.admin ? "review" : "neutral"} dot={false}>
                  {identity.roleLabel}
                </StatusPill>
              )}
            </div>
            <div style={{ color: "var(--text-2)", fontSize: "var(--fs-12)", marginTop: 2 }}>
              {identity.user
                ? [identity.user.login, identity.user.email].filter(Boolean).join(" · ")
                : "Working directly on this machine - sign-in is not configured."}
            </div>
          </div>
          {identity.authEnabled && identity.signedIn && (
            <Button icon={<LogoutOutlined />} onClick={() => logout.mutate()} loading={logout.isPending}>
              Sign out
            </Button>
          )}
        </div>

        <div
          style={{
            display: "grid",
            // auto-fit collapses unused tracks, so on very wide monitors the
            // cards stretch to share the whole row instead of leaving a gap.
            gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
            gap: 16,
            alignItems: "start",
          }}
        >
        {/* ---- appearance ---- */}
        <SectionCard title="Appearance">
          <Row
            stacked
            title="Theme"
            description="System follows your device and switches automatically. The toggle in the top bar keeps working for quick switches."
            control={<ThemeControl />}
          />
          <Divider style={{ margin: "4px 0" }} />
          <Row
            title="Text size"
            description="Applies everywhere, from the grid to dialogs."
            control={<FontScaleControl />}
          />
          <Divider style={{ margin: "4px 0" }} />
          <Row
            title="Density"
            description="Compact tightens controls and tables to fit more on screen."
            control={<DensityControl />}
          />
        </SectionCard>

        {/* ---- region & time ---- */}
        <SectionCard title="Region &amp; time">
          <Row
            stacked
            title="Time zone"
            description="Every date and time on the page is shown in this zone. Detected from this device by default; pick another to follow a team or site."
            control={
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <TimeZoneControl />
                <LiveClock />
              </div>
            }
          />
          <Divider style={{ margin: "4px 0" }} />
          <Row
            title="Clock format"
            description="Automatic follows your device's language setting."
            control={<HourCycleControl />}
          />
        </SectionCard>

        {/* ---- access ---- */}
        <SectionCard title="Access">
          <Row
            title={activeApp ? `Your role on ${activeApp.name}` : "Your role"}
            description={roleExplains}
            control={
              identity.roleLabel ? (
                <StatusPill tone={identity.admin ? "review" : "neutral"} dot={false}>
                  {identity.roleLabel}
                </StatusPill>
              ) : (
                <span style={{ color: "var(--text-3)" }}>Select an application</span>
              )
            }
          />
          {identity.admin && (
            <>
              <Divider style={{ margin: "4px 0" }} />
              <Row
                title="People & roles"
                description="Who can view, edit and approve on the active application."
                control={
                  <Button
                    icon={<TeamOutlined />}
                    disabled={!repoId || !identity.authEnabled}
                    onClick={() => setMembersOpen(true)}
                  >
                    Manage
                  </Button>
                }
              />
              <Divider style={{ margin: "4px 0" }} />
              <Row
                title="Plugins"
                description="Format parsers and integrations available on this deployment."
                control={
                  <Button icon={<ApiOutlined />} onClick={() => setSection("plugins")}>
                    View plugins
                  </Button>
                }
              />
            </>
          )}
          {!identity.authEnabled && (
            <div style={{ fontSize: "var(--fs-12)", color: "var(--text-3)", marginTop: 8 }}>
              To add teammates with separate roles, configure GitHub sign-in on the deployment.
            </div>
          )}
        </SectionCard>

        {/* ---- this deployment ---- */}
        <SectionCard title="This deployment">
          <Row
            title={meta ? `${meta.name} ${meta.version}` : "Configer"}
            description={
              meta ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      width: 7, height: 7, borderRadius: 4, flexShrink: 0,
                      background: envHex(meta.environment), display: "inline-block",
                    }}
                  />
                  {meta.environment} environment
                </span>
              ) : (
                "Deployment details are unavailable right now."
              )
            }
            control={
              <Button
                icon={<SwaggerOutlined />}
                onClick={() => window.open("/api/docs", "_blank", "noopener,noreferrer")}
              >
                API documentation <ExportOutlined style={{ fontSize: 11, opacity: 0.6 }} />
              </Button>
            }
          />
          <Divider style={{ margin: "4px 0" }} />
          <Row
            title="Welcome tour"
            description="Replay the short introduction and set-up choices from your first visit."
            control={
              <Button icon={<SparkleOutlined />} onClick={() => setWelcomeOpen(true)}>
                Replay tour
              </Button>
            }
          />
        </SectionCard>
        </div>

        <div style={{ marginTop: 16, fontSize: "var(--fs-11)", color: "var(--text-3)" }}>
          Preferences apply immediately and are stored in this browser, per device.
        </div>
      </div>
      {repoId && <MembersModal open={membersOpen} onClose={() => setMembersOpen(false)} repoId={repoId} />}
    </div>
  );
}

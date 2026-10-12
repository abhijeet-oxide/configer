import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Tabs, Typography } from "antd";
import { identityClaims, identityProviderName, isSignedIn } from "../authkit/session";
import { AccessibilitySettings, AppearanceSettings, c, DateTimeSettings, formatDateTime, mono, ResetPreferences, SectionCard } from "../uikit";

export type ProfileTab = "profile" | "accessibility" | "appearance";

export const PROFILE_TAB_TITLE: Record<ProfileTab, string> = {
  profile: "Profile",
  accessibility: "Accessibility",
  appearance: "Appearance",
};

export function profileTab(raw: string | null | undefined): ProfileTab {
  return raw === "appearance" || raw === "accessibility" ? raw : "profile";
}

export interface ProfilePageProps {
  /** What the application verified about this person; the ID token fills the rest. */
  name?: string;
  email?: string;
  subject?: string;
  loading?: boolean;
  anonymous?: boolean;
  /** Chips under the name: the standing first, then where. */
  badges?: ReactNode;
  /** False when the account was not signed in through the directory. */
  directory?: boolean;
  /** Sign-in fields beyond the account id, one <Field> each. */
  signInFields?: ReactNode;
  /** The application's own sections, below the directory. */
  children?: ReactNode;
  tab: ProfileTab;
  onTab: (tab: ProfileTab) => void;
  onSignOut: () => void;
  signOutButton: (onClick: () => void) => ReactNode;
  tabIcons?: Partial<Record<ProfileTab, ReactNode>>;
  /** Above the identity band: each application titles its own pages. */
  title?: ReactNode;
}

/** The one Profile page of the platform. Every application on it renders this,
 *  so the same person sees the same page, and the same preferences, in each. */
export function ProfilePage(props: ProfilePageProps) {
  const claims = identityClaims();
  const provider = useIdentityProviderName();
  const name = props.name || claims.name;
  const email = props.email || claims.email;
  const username = claims.preferredUsername;
  const { anonymous, loading } = props;
  const subtitle = [email, extraIdentifier(username, name, email)].filter(Boolean).join("  ·  ");
  const icons = props.tabIcons ?? {};

  return (
    <SectionCard padded={false} style={{ width: "100%" }}>
      {props.title}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-5)",
          padding: "var(--sp-5) var(--sp-7)",
          background: c.surface2,
          borderBottom: `1px solid ${c.border}`,
          flexWrap: "wrap",
        }}
      >
        <Initials of={anonymous ? props.subject : name || email || username} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: "var(--fs-20)", fontWeight: 600, lineHeight: 1.25, color: c.text }}>
            {loading ? " " : anonymous ? "Anonymous access" : name || username || "Unnamed account"}
          </div>
          <div style={{ fontSize: "var(--fs-13)", color: c.text2, marginTop: 3 }}>
            {anonymous
              ? "You are using anonymous access. Authentication is disabled in this environment."
              : subtitle || "No address on record"}
          </div>
          {!anonymous && props.badges && <div style={{ marginTop: "var(--sp-3)" }}>{props.badges}</div>}
        </div>
        {isSignedIn() && props.signOutButton(props.onSignOut)}
      </div>

      <div style={{ padding: "0 var(--sp-7) var(--sp-6)" }}>
        <Tabs
          data-tour="profile.tabs"
          activeKey={props.tab}
          onChange={(key) => props.onTab(profileTab(key))}
          items={[
            {
              key: "profile",
              label: PROFILE_TAB_TITLE.profile,
              icon: icons.profile,
              children: anonymous ? null : (
                <>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
                      gap: "0 var(--sp-8)",
                      alignItems: "start",
                    }}
                  >
                    <ProfileSection label="Sign-in" first>
                      {props.signInFields}
                      <Field label="Account id">
                        <Typography.Text
                          type="secondary"
                          copyable={Boolean(props.subject)}
                          style={{ fontFamily: mono, fontSize: "var(--fs-12)" }}
                        >
                          {props.subject}
                        </Typography.Text>
                      </Field>
                    </ProfileSection>
                    {props.directory !== false && <Directory provider={provider} />}
                  </div>
                  {props.children}
                </>
              ),
            },
            {
              key: "accessibility",
              label: PROFILE_TAB_TITLE.accessibility,
              icon: icons.accessibility,
              children: (
                <div style={{ maxWidth: 960, paddingTop: "var(--sp-1)" }}>
                  <AccessibilitySettings />
                </div>
              ),
            },
            {
              key: "appearance",
              label: PROFILE_TAB_TITLE.appearance,
              icon: icons.appearance,
              children: (
                <div style={{ maxWidth: 960, paddingTop: "var(--sp-1)" }}>
                  <AppearanceSettings />
                  <ProfileSection label="Date and time">
                    <DateTimeSettings />
                  </ProfileSection>
                  <ProfileSection label="Saved preferences">
                    <ResetPreferences />
                  </ProfileSection>
                </div>
              ),
            },
          ]}
        />
      </div>
    </SectionCard>
  );
}

function Directory({ provider }: { provider: string }) {
  const claims = identityClaims();
  return (
    <ProfileSection label="Directory" first>
      <Field label="Source">{provider || "This system"}</Field>
      <Field label="Full name">
        <Asserted value={claims.name} provider={provider} />
      </Field>
      {claims.givenName !== claims.familyName && (
        <>
          <Field label="Given name">
            <Asserted value={claims.givenName} provider={provider} />
          </Field>
          <Field label="Family name">
            <Asserted value={claims.familyName} provider={provider} />
          </Field>
        </>
      )}
      <Field label="Language">
        <Asserted value={claims.locale} provider={provider} />
      </Field>
      <Field label="Details updated">
        <Asserted
          value={claims.updatedAt ? formatDateTime(claims.updatedAt * 1000) ?? undefined : undefined}
          provider={provider}
        />
      </Field>
      <Note>
        {provider
          ? `Details fetched from ${provider}`
          : "These details are held on the account in this system, and are changed where accounts are provisioned."}
      </Note>
    </ProfileSection>
  );
}

/** A titled run of fields. The first draws no rule: the band above ends in one. */
export function ProfileSection({ label, first, children }: { label: string; first?: boolean; children: ReactNode }) {
  return (
    <div
      style={
        first
          ? { marginTop: "var(--sp-5)" }
          : { marginTop: "var(--sp-5)", paddingTop: "var(--sp-5)", borderTop: `1px solid ${c.border}` }
      }
    >
      <div
        style={{
          fontSize: "var(--fs-11)",
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: c.text3,
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(120px, 156px) 1fr",
        gap: "var(--sp-3)",
        alignItems: "baseline",
        padding: "var(--sp-2) 0",
        fontSize: "var(--fs-13)",
      }}
    >
      <div style={{ color: c.text2 }}>{label}</div>
      <div style={{ color: c.text, minWidth: 0 }}>{children}</div>
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <div style={{ marginTop: "var(--sp-3)", fontSize: "var(--fs-12)", lineHeight: 1.55, color: c.text3 }}>
      {children}
    </div>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <span style={{ color: c.text3 }}>{children}</span>;
}

/** Absent names the directory: "not provided by Microsoft" is an answer, "None" is not. */
function Asserted({ value, provider }: { value?: string; provider: string }) {
  if (value) return <>{value}</>;
  return <Muted>{provider ? `Not provided by ${provider}` : "Not set"}</Muted>;
}

/** Microsoft makes the login name the address; showing both reads as a fault. */
function extraIdentifier(username?: string, name?: string, email?: string): string | null {
  if (!username) return null;
  const same = (other?: string) => Boolean(other) && other!.toLowerCase() === username.toLowerCase();
  return same(name) || same(email) ? null : username;
}

export function initialsOf(of: string | undefined): string {
  const letters = (of ?? "")
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return letters || "?";
}

function Initials({ of }: { of: string | undefined }) {
  return (
    <div
      aria-hidden
      style={{
        width: 56,
        height: 56,
        flex: "0 0 56px",
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        background: c.brandSoft,
        color: c.brandStrong,
        border: `1px solid ${c.brandBorder}`,
        fontSize: "var(--fs-18)",
        fontWeight: 600,
        letterSpacing: "0.02em",
      }}
    >
      {initialsOf(of)}
    </div>
  );
}

function useIdentityProviderName(): string {
  const [name, setName] = useState("");
  useEffect(() => {
    let live = true;
    void identityProviderName().then((n) => {
      if (live) setName(n);
    });
    return () => {
      live = false;
    };
  }, []);
  return name;
}

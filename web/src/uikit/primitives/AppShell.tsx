import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Badge, Dropdown, Tooltip } from "antd";
import type { MenuProps } from "antd";
import type { BrandIdentity } from "../brand";
import { stepCritical } from "../spring";
import { BrandLockup, BrandMark } from "./BrandLockup";
import { ChevronLeftIcon, ChevronRightIcon } from "../icons";

// THE APPLICATION CHROME, shared whole.
//
// The navigation and the bar above the page are the two surfaces a person sees
// on every screen of every tool, so they are the two that must not be written
// twice. Two products that share a palette but each draw their own sidebar do
// not look like one product; they look like two products with the same colours,
// which is worse than not trying, because the difference reads as carelessness
// rather than as intent.
//
// So the STRUCTURE lives here - the widths, the paddings, the item heights, the
// hover and active language, the collapse behaviour, the profile card at the
// foot, the bar's height and how its two ends are arranged - and each app hands
// in only what is genuinely its own: which entries there are, what they do, and
// what belongs in its bar. Nothing here names a product.

export interface NavItem {
  key: string;
  label: string;
  icon: ReactNode;
  /** a count worth interrupting for; 0 or undefined draws nothing */
  badge?: number;
  /** danger for failures, ok for work in flight; the nav accent otherwise */
  badgeTone?: "danger" | "ok";
  disabled?: boolean;
  /** why it is disabled, said in the tooltip rather than left to guesswork */
  disabledHint?: string;
  /**
   * The group this entry opens. When it differs from the previous entry's, a
   * quiet section label is drawn above it (expanded rail only). Leave it
   * undefined for a flat rail.
   */
  section?: string;
  /**
   * In-app destination. Prefer this over `onClick` for pages: a real link
   * updates history immediately and survives a heavy page still mounting,
   * which is how a click on Releases used to swallow the next nav click.
   */
  to?: string;
  onClick?: () => void;
}

/** One choice in the top-bar account menu. The app names the items; this kit
 *  only draws them. */
export interface NavProfileMenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** why it is disabled, shown on hover rather than left to guesswork */
  disabledHint?: string;
  onClick?: () => void;
}

export interface NavProfile {
  name: string;
  /** the second line: a login, a role, an account */
  sub?: string;
  avatarUrl?: string;
  /** shown when there is no avatar image; the initials are derived if omitted */
  initials?: string;
  /**
   * WHAT KIND of account this is, as a glyph on the corner of the avatar.
   *
   * The second line already names it in words, and words in 10.5px grey type
   * are the least glanceable thing in a rail: "Admin", "Operator", "Security",
   * "Reader" and "User" occupy the same position and differ by a few letters,
   * for the one fact that decides whether every control on screen is available
   * to you.
   *
   * A badge rather than a replacement for the initials, which are who you are
   * rather than what you are - and it survives the collapsed rail, where the
   * words do not. The app supplies the glyph because the KINDS are the app's
   * (this kit knows nothing about tenant roles); `badgeLabel` is what the
   * badge means, for the tooltip and for a screen reader.
   */
  badge?: ReactNode;
  badgeLabel?: string;
  active?: boolean;
  /**
   * Single-click destination when there is no `menu`. Prefer `menu` for the
   * top-bar control: a chevron that opens nothing is a broken affordance.
   */
  onClick?: () => void;
  /**
   * The account menu. When present, the top-bar control opens these choices
   * instead of navigating on the click itself. The app owns which items exist
   * (profile, appearance, sign out, …); this kit only hosts them.
   */
  menu?: NavProfileMenuItem[];
  tooltip?: string;
}

/** One entry in the navigation. Exported because a sign-in entry and the
 *  collapse control are the same shape as a destination. */
export function NavEntry({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const disabled = !!item.disabled;
  const className = `ui-nav-item${active ? " is-active" : ""}${disabled ? " is-disabled" : ""}${
    collapsed ? " is-collapsed" : ""
  }`;
  const body = (
    <>
      {/*
        A count goes where there is room for it, which depends on the width.

        Expanded, it is a chip at the END of the row - the way every mail and
        message list on the platform states an unread count. Pinned to the icon
        it sat on top of the first letters of the label: "Downloads" read as
        "3ownloads", and the wider the count the more of the word it ate.

        Collapsed there is no label to collide with and no room for a chip, so
        it goes back onto the icon as a dot-sized badge.
      */}
      {collapsed ? (
        <Badge
          count={item.badge ?? 0}
          size="small"
          offset={[2, 0]}
          color={item.badgeTone ? `var(--c-${item.badgeTone})` : "var(--nav-bg-active)"}
        >
          <span className="ui-nav-item-icon">{item.icon}</span>
        </Badge>
      ) : (
        <span className="ui-nav-item-icon">{item.icon}</span>
      )}
      {!collapsed && <span className="ui-nav-item-label">{item.label}</span>}
      {!collapsed && !!item.badge && (
        <span className={`ui-nav-count ui-num${item.badgeTone ? ` tone-${item.badgeTone}` : ""}`}>
          {item.badge > 99 ? "99+" : item.badge}
        </span>
      )}
    </>
  );
  const inner = item.to && !disabled ? (
    <Link
      to={item.to}
      className={className}
      aria-current={active ? "page" : undefined}
      onClick={item.onClick}
    >
      {body}
    </Link>
  ) : (
    <div
      className={className}
      onClick={disabled ? undefined : item.onClick}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          item.onClick?.();
        }
      }}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-current={active ? "page" : undefined}
    >
      {body}
    </div>
  );
  const tip = disabled ? (item.disabledHint ?? item.label) : collapsed ? item.label : "";
  return tip ? (
    <Tooltip title={tip} placement="right">
      {inner}
    </Tooltip>
  ) : (
    inner
  );
}

/**
 * The navigation: the product's one piece of dark chrome.
 *
 * Items are quiet by default, lighten on hover, and the active one becomes a
 * brand-filled pill. Collapsed, it keeps the icons and moves every label into a
 * tooltip, so the same component serves both widths rather than a second
 * narrow one drifting away from the wide one.
 */

function reducedNow(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

function useReducedMotion(): boolean {
  const [on, setOn] = useState(reducedNow);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setOn(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return on;
}

function navWidthPx(collapsed: boolean): number {
  const name = collapsed ? "--shell-nav-collapsed-width" : "--shell-nav-width";
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return collapsed ? 64 : 236;
}

function nearWidth(value: number, velocity: number, target: number): boolean {
  return Math.abs(value - target) < 0.5 && Math.abs(velocity) < 8;
}

export function SideNav({
  brand,
  onBrandClick,
  brandHref,
  brandLabel,
  items,
  activeKey,
  collapsed = false,
  onToggleCollapse,
  profile,
  profileSlot,
  footer,
  collapseLabel = "Collapse",
}: {
  brand: BrandIdentity;
  /** opens the application's root when the product mark or name is selected */
  onBrandClick?: () => void;
  /** a page OUTSIDE this app the mark opens instead, as a full page load in
   *  the same tab: a platform page listing every application. Wins over
   *  onBrandClick. */
  brandHref?: string;
  /** what the mark says it opens, as its accessible name and hover hint;
   *  defaults to this app's home */
  brandLabel?: string;
  items: NavItem[];
  activeKey?: string;
  collapsed?: boolean;
  /** omit to make the navigation a fixed width with no collapse control */
  onToggleCollapse?: () => void;
  /** the person, at the foot; omit on a tool with no identity to show */
  profile?: NavProfile | null;
  /** what stands in the profile's place when there is no person to show - a
   *  sign-in entry, most usefully. Identity is where a session starts, so the
   *  foot must not simply go blank when nobody is signed in. */
  profileSlot?: ReactNode;
  /** anything below the profile: a deployment chip, a version */
  footer?: ReactNode;
  collapseLabel?: string;
}) {
  const navRef = useRef<HTMLElement>(null);
  const width = useRef({ value: 0, velocity: 0, ready: false });
  const frame = useRef(0);
  const reduced = useReducedMotion();

  // Width follows the pixels on screen, not a fixed 260ms curve. The collapsed
  // class still selects the resting width; inline width only exists while the
  // spring is moving, so a second click retargets from the current width and
  // keeps its velocity. Reduced motion snaps.
  useLayoutEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const target = navWidthPx(collapsed);
    cancelAnimationFrame(frame.current);

    if (!width.current.ready) {
      const presented = el.getBoundingClientRect().width;
      width.current = {
        value: presented > 0 ? presented : target,
        velocity: 0,
        ready: true,
      };
      return;
    }

    if (reduced) {
      width.current = { value: target, velocity: 0, ready: true };
      el.style.width = "";
      return;
    }

    // Hold the presented width for this frame. The class already names the
    // destination, and without this the rail would jump before the first tick.
    el.style.width = `${width.current.value}px`;

    if (nearWidth(width.current.value, width.current.velocity, target)) {
      width.current = { value: target, velocity: 0, ready: true };
      el.style.width = "";
      return;
    }

    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const next = stepCritical(width.current.value, width.current.velocity, target, dt);
      width.current = { ...next, ready: true };
      if (nearWidth(next.value, next.velocity, target)) {
        width.current = { value: target, velocity: 0, ready: true };
        el.style.width = "";
        return;
      }
      el.style.width = `${next.value}px`;
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [collapsed, reduced]);

  return (
    <nav
      ref={navRef}
      className={`ui-nav${collapsed ? " is-collapsed" : ""}`}
      aria-label="Main"
    >
      {brandHref ? (
        <Tooltip title={brandLabel} placement="right" mouseEnterDelay={0.4}>
          <a
            className="ui-nav-brand is-clickable"
            href={brandHref}
            aria-label={brandLabel ?? `Go to ${brand.appName} home`}
          >
            {collapsed ? <BrandMark brand={brand} /> : <BrandLockup brand={brand} onDark />}
          </a>
        </Tooltip>
      ) : onBrandClick ? (
        <button
          type="button"
          className="ui-nav-brand is-clickable"
          onClick={onBrandClick}
          aria-label={`Go to ${brand.appName} home`}
        >
          {collapsed ? <BrandMark brand={brand} /> : <BrandLockup brand={brand} onDark />}
        </button>
      ) : (
        <div className="ui-nav-brand">
          {collapsed ? <BrandMark brand={brand} /> : <BrandLockup brand={brand} onDark />}
        </div>
      )}

      <div className="ui-nav-items">
        {items.map((it, i) => (
          <Fragment key={it.key}>
            {!collapsed && it.section && it.section !== items[i - 1]?.section && (
              <div className="ui-nav-section">{it.section}</div>
            )}
            <NavEntry item={it} active={activeKey === it.key} collapsed={collapsed} />
          </Fragment>
        ))}
      </div>

      <div className="ui-nav-foot">
        {profile ? <ProfileCard profile={profile} collapsed={collapsed} /> : profileSlot}
        {onToggleCollapse && (
          <NavEntry
            item={{
              key: "collapse",
              label: collapseLabel,
              icon: collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />,
              onClick: onToggleCollapse,
            }}
            active={false}
            collapsed={collapsed}
          />
        )}
        {!collapsed && footer}
      </div>
    </nav>
  );
}

/** The person, at the navigation's foot: who you are, and one click to every
 *  personal preference. Same quiet/hover/active language as an entry, so the
 *  foot reads as part of the navigation rather than as a separate widget. */
function ProfileCard({ profile, collapsed }: { profile: NavProfile; collapsed: boolean }) {
  const initials =
    profile.initials ?? (profile.name || "?").slice(0, 2).toUpperCase();
  const inner = (
    <div
      className={`ui-nav-profile${profile.active ? " is-active" : ""}${
        collapsed ? " is-collapsed" : ""
      }`}
      role="button"
      tabIndex={0}
      aria-label={`Open settings for ${profile.name}`}
      onClick={profile.onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          profile.onClick?.();
        }
      }}
    >
      <span className="ui-nav-avatar-slot">
        {profile.avatarUrl ? (
          <img className="ui-nav-avatar" src={profile.avatarUrl} alt="" />
        ) : (
          <span className="ui-nav-avatar is-initials">{initials}</span>
        )}
        {profile.badge && (
          <span
            className="ui-nav-avatar-badge"
            role={profile.badgeLabel ? "img" : undefined}
            aria-label={profile.badgeLabel}
            aria-hidden={profile.badgeLabel ? undefined : true}
          >
            {profile.badge}
          </span>
        )}
      </span>
      {!collapsed && (
        <div className="ui-nav-profile-text">
          <div className="ui-nav-profile-name">{profile.name}</div>
          {profile.sub && <div className="ui-nav-profile-sub">{profile.sub}</div>}
        </div>
      )}
    </div>
  );
  return (
    <Tooltip
      title={
        collapsed
          ? // COLLAPSED, the two lines of text are gone and the badge is the
            // only thing left saying what this account is - so the hover has to
            // carry both facts rather than only the name.
            profile.badgeLabel
            ? `${profile.name} - ${profile.badgeLabel}`
            : profile.name
          : (profile.tooltip ?? "Profile and settings")
      }
      placement="right"
    >
      {inner}
    </Tooltip>
  );
}

/** The person, at the right end of the bar: avatar, name and a chevron that
 *  opens their account menu. The same data as the navigation's profile card, for a
 *  tool that keeps its navigation to places only. */
export function TopBarProfile({ profile }: { profile: NavProfile }) {
  const initials =
    profile.initials ?? (profile.name || "?").slice(0, 2).toUpperCase();
  const trigger = (
    <button
      type="button"
      className={`ui-topbar-profile${profile.active ? " is-active" : ""}`}
      onClick={profile.menu?.length ? undefined : profile.onClick}
      aria-haspopup={profile.menu?.length ? "menu" : undefined}
      aria-label={
        profile.menu?.length
          ? `Account menu for ${profile.name}`
          : `Open profile for ${profile.name}`
      }
    >
      <span className="ui-nav-avatar-slot">
        {profile.avatarUrl ? (
          <img className="ui-topbar-avatar" src={profile.avatarUrl} alt="" />
        ) : (
          <span className="ui-topbar-avatar">{initials}</span>
        )}
        {profile.badge && (
          <span className="ui-nav-avatar-badge" aria-hidden>
            {profile.badge}
          </span>
        )}
      </span>
    </button>
  );

  if (profile.menu?.length) {
    const items: MenuProps["items"] = profile.menu.map((item) => ({
      key: item.key,
      icon: item.icon,
      danger: item.danger,
      disabled: item.disabled,
      // Disabled items swallow pointer events, so the hint has to sit on an
      // inner span the tooltip can still hear.
      label:
        item.disabled && item.disabledHint ? (
          <Tooltip title={item.disabledHint} placement="left">
            <span>{item.label}</span>
          </Tooltip>
        ) : (
          item.label
        ),
      onClick: item.disabled ? undefined : item.onClick,
    }));
    return (
      <Dropdown menu={{ items }} trigger={["click"]} placement="bottomRight">
        <Tooltip title={profile.name} placement="bottomRight">
          {trigger}
        </Tooltip>
      </Dropdown>
    );
  }

  return (
    <Tooltip title={profile.badgeLabel ?? profile.tooltip ?? "Profile and settings"}>
      {trigger}
    </Tooltip>
  );
}

/**
 * The bar above the page.
 *
 * It carries WHERE YOU ARE on the left and the standing controls on the right,
 * in that order, at the same height, in both tools. What goes in each end is
 * the app's business - a breadcrumb here, a section name there - but the shape
 * is not, which is why they are slots rather than two separate bars.
 *
 * `line-height: normal` is set in the stylesheet rather than left to the
 * component library, whose header sets a 64px line box that anything inline
 * inherits: a 26px pill became a 72px ellipse hanging out of the bar.
 */
export function TopBar({
  title,
  left,
  right,
  children,
}: {
  /** where you are, in one strong phrase - the common case, styled once so
   *  every tool says it at the same size and weight */
  title?: ReactNode;
  /** where you are, when it needs more than a phrase (a breadcrumb, a
   *  switcher). Layout only: it carries no type of its own, so what goes in
   *  keeps its own. */
  left?: ReactNode;
  /** the standing controls: search, theme, notifications, the account */
  right?: ReactNode;
  /** anything that should sit between the two and take the slack */
  children?: ReactNode;
}) {
  return (
    <header className="ui-topbar">
      {title && <div className="ui-topbar-title">{title}</div>}
      {left && <div className="ui-topbar-left">{left}</div>}
      {children}
      <div className="ui-topbar-spacer" />
      {right && <div className="ui-topbar-right">{right}</div>}
    </header>
  );
}

/**
 * The whole frame: navigation beside a column of bar-then-page.
 *
 * The page area is the only thing that scrolls. The application is exactly the
 * size of the window and every scrollable region inside it manages its own bar,
 * so the navigation and the top bar cannot slide away from a reader who is
 * halfway down a long table.
 */
export function AppShell({
  nav,
  header,
  children,
  /** the page manages its own edges AND its own scrolling: for a workspace
   *  built of panes that each scroll independently, which must not also sit
   *  inside a scroller or the whole frame slides and the navigation with it */
  flush = false,
  /** state the frame itself answers to - the phone drawer's is-nav-open */
  className,
}: {
  /** omit (or pass null) for a full-bleed view: a focus mode, a wizard */
  nav?: ReactNode;
  header?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <div className={`ui-shell${className ? ` ${className}` : ""}`}>
      {nav}
      <div className="ui-shell-main">
        {header}
        <main className={`ui-shell-page${flush ? " is-flush" : ""}`}>{children}</main>
      </div>
    </div>
  );
}

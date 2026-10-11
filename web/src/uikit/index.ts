// The shared design system, in one import.
//
//   import { ThemeProvider, SectionCard, StatusPill, c } from "./uikit";
//
// Everything below is IDENTICAL in every tool that uses this folder. See
// README.md for what may and may not be changed here.

// --- the theme -------------------------------------------------------------
export { ThemeProvider, useTheme } from "./ThemeProvider";
export type { ThemeContextValue } from "./ThemeProvider";
export { buildTheme } from "./antd";
export { revealThemeChange, pointOf } from "./themeTransition";
export type { RevealPoint } from "./themeTransition";
export {
  tokens,
  defaultTokens,
  presets,
  ACTIVE_PRESET,
  tokenOverrides,
  VAR_MAP,
  renderRootCss,
  deepMerge,
} from "./tokens";
export type { Palette, ThemeTokens, DeepPartial } from "./tokens";
export { faviconHref, documentTitle } from "./brand";
export type { BrandIdentity, BrandLogo } from "./brand";
export {
  APPEARANCE_KEY,
  clearAppearance,
  deviceTimeZone,
  defaultAppearance,
  loadAppearance,
  saveAppearance,
  readThemeCookie,
  writeThemeCookie,
  THEME_COOKIE,
  resolveMode,
  watchSystemMode,
} from "./prefs";
export type {
  Appearance,
  ColorVision,
  Contrast,
  DateFormat,
  Density,
  FontScale,
  HourCycle,
  Mode,
  Motion,
  ThemePref,
} from "./prefs";
export {
  formatDate,
  formatDateTime,
  formatTime,
  formatTimeSeconds,
  formatDayMonth,
  dayKey,
  hourOf,
  zoneLabel,
  timeZones,
  previewDateTime,
} from "./dates";
export { typography, typographyVariableNames, typographyVariables } from "./typography";
export type { TypographyScale } from "./typography";

// --- reading a colour ------------------------------------------------------
export {
  c,
  cssVar,
  withAlpha,
  mono,
  fontUI,
  severity,
  severitySurface,
  verdict,
  envColors,
  envHex,
  envTone,
  envTones,
  isProductionEnv,
} from "./color";
export type { Severity, Verdict, EnvTone } from "./color";

// --- glyphs ----------------------------------------------------------------
export {
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ErrorCircleIcon,
  EyeIcon,
  InfoIcon,
  LockIcon,
  MoonIcon,
  PulseIcon,
  RefreshIcon,
  ShieldCheckIcon,
  ShieldIcon,
  SignalIcon,
  SignalOffIcon,
  SpinnerIcon,
  SunIcon,
  SystemIcon,
  UserIcon,
  WarningIcon,
  WrenchIcon,
} from "./icons";
export type { IconProps } from "./icons";

// --- primitives ------------------------------------------------------------
export { StatusPill, ChangeChip } from "./primitives/StatusPill";
export type { PillTone, ChangeKind } from "./primitives/StatusPill";
export { SeverityTag, SeverityDot, VerdictTag } from "./primitives/SeverityTag";
export { default as StatTile } from "./primitives/StatTile";
export { default as PageHeader } from "./primitives/PageHeader";
export { default as FieldLabel } from "./primitives/FieldLabel";
export { default as PageTransition } from "./primitives/PageTransition";
export { default as SectionCard } from "./primitives/SectionCard";
export { default as CardHead, Figure } from "./primitives/CardHead";
export type { CardIconTone } from "./primitives/CardHead";
export { default as AttentionCard } from "./primitives/AttentionCard";
export type { AttentionSeverity } from "./primitives/AttentionCard";
export { default as Toolbar } from "./primitives/Toolbar";
export { default as EmptyState } from "./primitives/EmptyState";
export { default as InlineNotice } from "./primitives/InlineNotice";
export type { NoticeTone } from "./primitives/InlineNotice";
export { default as LoadingStage } from "./primitives/LoadingStage";
export { default as Stepper } from "./primitives/Stepper";
export type { StepDef } from "./primitives/Stepper";
export { default as Kbd } from "./primitives/Kbd";
export { default as Mono } from "./primitives/Mono";
export { FadeIn, Stagger, StaggerItem } from "./primitives/motion";
export { BrandMark, BrandLockup, Wordmark } from "./primitives/BrandLockup";
export { default as Onboarding } from "./primitives/Onboarding";

// --- is the service there? -------------------------------------------------
// One monitor, one answer, and three surfaces that never take the screen away
// from the person using it. Every tool has an outage; every tool that handles
// one by improvising a toast per failed request handles it the same wrong way.
export {
  connection,
  createConnectionMonitor,
  useConnection,
  useOnRestore,
  useHeldWork,
  useCountdown,
  RESTORED_MS,
} from "./connection";
export type {
  ConnectionMonitor,
  ConnectionOptions,
  ConnectionPhase,
  ConnectionReport,
  ConnectionSnapshot,
  Probe,
  ProbeResult,
  ProbeVerdict,
} from "./connection";
export {
  ConnectionPill,
  ConnectionAlert,
  ConnectionNotice,
  ConnectionDetail,
  describeConnection,
} from "./primitives/ConnectionStatus";
export type { ConnectionCopy, ConnectionFact } from "./primitives/ConnectionStatus";

// --- the application chrome, shared whole --------------------------------
export { AppShell, SideNav, TopBar, TopBarProfile, NavEntry } from "./primitives/AppShell";
export type { NavItem, NavProfile, NavProfileMenuItem } from "./primitives/AppShell";
export { StatusScreen, BootSplash } from "./primitives/StatusScreen";

// --- the four pages a tool shows instead of itself -------------------------
// Planned work, a wrong address, an unplanned failure, and the wait before a
// screen can be drawn. Every tool has all four, and they are the four most
// likely to be improvised one at a time - which is how two products that share
// a palette stop looking like one.
export {
  StatePage,
  MaintenancePage,
  NotFoundPage,
  ErrorPage,
  LoadingPage,
} from "./primitives/StatePages";
export type { StatePageProps } from "./primitives/StatePages";

// --- the state illustrations ----------------------------------------------
// A state screen is the same state screen in every tool: one tool having a
// drawing where the other has a bare sentence is exactly the kind of
// difference that stops two products looking like one.
export {
  SuccessArt,
  ScanArt,
  EmptyArt,
  AllClearArt,
  InboxZeroArt,
  InSyncArt,
  RadarIdleArt,
  DownloadsDoneArt,
  EmptyTrendArt,
  OfflineArt,
  WorkspaceArt,
  SignedOutArt,
  SessionExpiredArt,
  ServiceDownArt,
  AccessDeniedArt,
  NotFoundArt,
  MaintenanceArt,
  ErrorArt,
  CheckFailedArt,
  LoadingArt,
  SearchArt,
  StatePanel,
} from "./primitives/illustrations";
export type { StatusAction } from "./primitives/StatusScreen";
export {
  default as AppearanceSettings,
  SettingRow,
  ThemeControl,
  ThemeSwitch,
  ThemeToggleButton,
  DensityControl,
  FontScaleControl,
  ContrastControl,
  ColorVisionControl,
  MotionControl,
  UnderlineLinksControl,
  TimeZoneControl,
  DateFormatControl,
  HourCycleControl,
  AccessibilitySettings,
  DateTimeSettings,
  ResetPreferences,
} from "./primitives/AppearanceControls";

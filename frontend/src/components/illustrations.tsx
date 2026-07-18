import { useId } from "react";
import { Typography } from "antd";
import { FadeIn } from "./ui/motion";

// A small kit of modern, dependency-free SVG illustrations with gentle,
// reduced-motion-aware animations (keyframes live in index.css). They replace
// the flat antd Result/Empty glyphs on the app's "state" pages - processing,
// success, empty, offline - so those pages read as considered and professional.
// Each illustration is theme-aware: the "paper" shapes fill with --ill-surface
// (white in light, a lifted dark tone in dark) instead of a hard-coded white,
// so nothing reads as a bright blob on a dark card.

const OK = "#16a34a";
const OK2 = "#4ade80";
const BLUE = "#2f6bff";
const BLUE2 = "#7aa7ff";
const AMBER = "#f59e0b";

// The theme-tracking fill for the solid "paper" shapes (trays, shields, cards).
const PAPER = "var(--ill-surface)";

// SuccessArt: a soft ring that pops in and a checkmark that draws itself, with
// two sparks - a warmer "done" than a static tick.
export function SuccessArt({ size = 132 }: { size?: number }) {
  const uid = useId();
  const ring = `ok-ring-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 132 132" role="img" aria-label="Success" className="ill">
      <defs>
        <linearGradient id={ring} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={OK2} />
          <stop offset="1" stopColor={OK} />
        </linearGradient>
      </defs>
      <circle cx="66" cy="66" r="52" fill={OK} opacity="0.10" className="ill-ripple" />
      <circle cx="66" cy="66" r="40" fill="none" stroke={`url(#${ring})`} strokeWidth="6" className="ill-pop" style={{ transformOrigin: "66px 66px" }} />
      <path
        d="M46 67 L61 81 L88 51"
        fill="none"
        stroke={`url(#${ring})`}
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="ill-draw"
        pathLength={1}
      />
      <circle cx="98" cy="40" r="3" fill={OK2} className="ill-spark" style={{ animationDelay: "0.5s" }} />
      <circle cx="34" cy="52" r="2.5" fill={OK} className="ill-spark" style={{ animationDelay: "0.7s" }} />
    </svg>
  );
}

// ScanArt: a document with a scan beam sweeping over it and settings "found"
// as it passes - for the reading/processing state.
export function ScanArt({ size = 132 }: { size?: number }) {
  const uid = useId();
  const beam = `scan-beam-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 132 132" role="img" aria-label="Scanning" className="ill">
      <defs>
        <linearGradient id={beam} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={BLUE} stopOpacity="0" />
          <stop offset="0.5" stopColor={BLUE} stopOpacity="0.55" />
          <stop offset="1" stopColor={BLUE} stopOpacity="0" />
        </linearGradient>
      </defs>
      <g className="ill-floaty" style={{ transformOrigin: "66px 66px" }}>
        <rect x="40" y="30" width="52" height="68" rx="8" fill={PAPER} stroke={BLUE2} strokeWidth="2" />
        <rect x="40" y="30" width="52" height="68" rx="8" fill={BLUE} opacity="0.05" />
        {[44, 54, 64, 74, 84].map((y, i) => (
          <rect key={y} x="49" y={y} width={i % 2 ? 22 : 34} height="4" rx="2" fill={BLUE} opacity="0.28" />
        ))}
        {/* the sweeping beam */}
        <g className="ill-sweep">
          <rect x="40" y="30" width="52" height="10" fill={`url(#${beam})`} />
          <rect x="40" y="39" width="52" height="1.5" fill={BLUE} opacity="0.7" />
        </g>
      </g>
      <circle cx="98" cy="44" r="3.5" fill={BLUE} className="ill-spark" style={{ animationDelay: "0.2s" }} />
      <circle cx="34" cy="80" r="3" fill={BLUE2} className="ill-spark" style={{ animationDelay: "0.9s" }} />
    </svg>
  );
}

// EmptyArt: a friendly open tray with a document lifting out - nothing here
// yet, in a calm way. Drawn with a legible stroked body (not a washed-out
// fill) so it reads clearly on any surface, light or dark.
export function EmptyArt({ size = 120 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" role="img" aria-label="Nothing here" className="ill">
      {/* soft ground shadow */}
      <ellipse cx="60" cy="99" rx="32" ry="5.5" fill={BLUE} opacity="0.12" className="ill-ripple" style={{ transformOrigin: "60px 99px" }} />
      <g className="ill-floaty" style={{ transformOrigin: "60px 62px" }}>
        {/* the tray body: paper fill + a clear brand outline so it is always visible */}
        <path
          d="M28 60 h18 l6 9 h16 l6 -9 h18 l-7 28 a7 7 0 0 1 -7 5 H42 a7 7 0 0 1 -7 -5 Z"
          fill={PAPER}
          stroke={BLUE}
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <path
          d="M28 60 h18 l6 9 h16 l6 -9 h18 l-7 28 a7 7 0 0 1 -7 5 H42 a7 7 0 0 1 -7 -5 Z"
          fill={BLUE}
          opacity="0.06"
        />
        {/* a single document lifting out of the tray */}
        <g className="ill-lift" style={{ transformOrigin: "60px 44px" }}>
          <rect x="44" y="26" width="32" height="26" rx="4" fill={PAPER} stroke={BLUE2} strokeWidth="2" />
          <rect x="50" y="33" width="20" height="3" rx="1.5" fill={BLUE} opacity="0.35" />
          <rect x="50" y="40" width="14" height="3" rx="1.5" fill={BLUE} opacity="0.28" />
        </g>
      </g>
      <circle cx="88" cy="34" r="3" fill={BLUE2} className="ill-spark" style={{ animationDelay: "0.4s" }} />
      <circle cx="30" cy="46" r="2.5" fill={BLUE} className="ill-spark" style={{ animationDelay: "0.9s" }} />
    </svg>
  );
}

// AllClearArt: a shield with a drawn check and calm ripple - everything is in
// order (no drift, nothing failing, nothing waiting).
export function AllClearArt({ size = 132 }: { size?: number }) {
  const uid = useId();
  const grad = `clear-shield-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 132 132" role="img" aria-label="All clear" className="ill">
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={OK2} />
          <stop offset="1" stopColor={OK} />
        </linearGradient>
      </defs>
      <circle cx="66" cy="66" r="52" fill={OK} opacity="0.08" className="ill-ripple" />
      <g className="ill-floaty" style={{ transformOrigin: "66px 66px" }}>
        <path
          d="M66 30 l28 10 v22 c0 18 -12 30 -28 38 c-16 -8 -28 -20 -28 -38 v-22 Z"
          fill={PAPER}
          stroke={`url(#${grad})`}
          strokeWidth="3.5"
          strokeLinejoin="round"
        />
        <path
          d="M66 30 l28 10 v22 c0 18 -12 30 -28 38 c-16 -8 -28 -20 -28 -38 v-22 Z"
          fill={OK}
          opacity="0.07"
        />
        <path
          d="M54 66 L63 75 L80 55"
          fill="none"
          stroke={`url(#${grad})`}
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="ill-draw"
          pathLength={1}
        />
      </g>
      <circle cx="102" cy="42" r="3" fill={OK2} className="ill-spark" style={{ animationDelay: "0.5s" }} />
      <circle cx="30" cy="58" r="2.5" fill={OK} className="ill-spark" style={{ animationDelay: "0.8s" }} />
    </svg>
  );
}

// InboxZeroArt: an open tray with a small check floating in - the queue is
// empty in a good way (nothing waiting for you).
export function InboxZeroArt({ size = 132 }: { size?: number }) {
  const uid = useId();
  const grad = `zero-ok-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 132 132" role="img" aria-label="Nothing waiting" className="ill">
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={OK2} />
          <stop offset="1" stopColor={OK} />
        </linearGradient>
      </defs>
      <circle cx="66" cy="70" r="44" fill={BLUE} opacity="0.05" className="ill-ripple" />
      <g className="ill-floaty" style={{ transformOrigin: "66px 72px" }}>
        <ellipse cx="66" cy="106" rx="36" ry="6" fill={BLUE} opacity="0.08" />
        <path
          d="M34 66 h20 l6 9 h12 l6 -9 h20 l-7 30 a6 6 0 0 1 -6 5 H47 a6 6 0 0 1 -6 -5 Z"
          fill={PAPER}
          stroke={BLUE}
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <path
          d="M34 66 h20 l6 9 h12 l6 -9 h20 l-7 30 a6 6 0 0 1 -6 5 H47 a6 6 0 0 1 -6 -5 Z"
          fill={BLUE}
          opacity="0.08"
        />
        <path d="M44 66 v-14 a5 5 0 0 1 5 -5 h34 a5 5 0 0 1 5 5 v14" fill="none" stroke={BLUE} strokeWidth="2.5" opacity="0.55" />
        <circle cx="66" cy="38" r="14" fill={PAPER} stroke={`url(#${grad})`} strokeWidth="3" className="ill-pop" style={{ transformOrigin: "66px 38px" }} />
        <path
          d="M59 38.5 L64 43.5 L73.5 32.5"
          fill="none"
          stroke={`url(#${grad})`}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="ill-draw"
          pathLength={1}
        />
      </g>
      <circle cx="100" cy="52" r="3" fill={BLUE2} className="ill-spark" style={{ animationDelay: "0.4s" }} />
      <circle cx="32" cy="84" r="2.5" fill={OK2} className="ill-spark" style={{ animationDelay: "0.9s" }} />
    </svg>
  );
}

// InSyncArt: a git graph whose two branches have converged, with a soft check
// where they meet - Configer and the repository are in step, nothing has
// drifted. A friendlier "all caught up" than a security shield.
export function InSyncArt({ size = 132 }: { size?: number }) {
  const uid = useId();
  const grad = `sync-ok-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 132 132" role="img" aria-label="In sync" className="ill">
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={OK2} />
          <stop offset="1" stopColor={OK} />
        </linearGradient>
      </defs>
      <circle cx="66" cy="66" r="50" fill={OK} opacity="0.07" className="ill-ripple" />
      <g className="ill-floaty" style={{ transformOrigin: "66px 66px" }}>
        {/* the trunk */}
        <line x1="42" y1="34" x2="42" y2="98" stroke={BLUE2} strokeWidth="3" strokeLinecap="round" opacity="0.55" />
        {/* a branch that leaves and merges back */}
        <path d="M42 52 C42 44, 84 44, 84 62 C84 80, 42 80, 42 88" fill="none" stroke={BLUE} strokeWidth="3" strokeLinecap="round" opacity="0.5" />
        {[34, 70, 98].map((cy) => (
          <circle key={cy} cx="42" cy={cy} r="5.5" fill={PAPER} stroke={BLUE} strokeWidth="2.5" />
        ))}
        <circle cx="84" cy="62" r="5.5" fill={PAPER} stroke={BLUE} strokeWidth="2.5" />
        {/* the convergence check */}
        <circle cx="84" cy="62" r="15" fill={PAPER} stroke={`url(#${grad})`} strokeWidth="3" className="ill-pop" style={{ transformOrigin: "84px 62px" }} />
        <path
          d="M77 62.5 L82 67.5 L91.5 56.5"
          fill="none"
          stroke={`url(#${grad})`}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="ill-draw"
          pathLength={1}
        />
      </g>
      <circle cx="104" cy="40" r="3" fill={OK2} className="ill-spark" style={{ animationDelay: "0.5s" }} />
      <circle cx="28" cy="76" r="2.5" fill={BLUE2} className="ill-spark" style={{ animationDelay: "0.9s" }} />
    </svg>
  );
}

// OfflineArt: a cloud with a gently pulsing dashed link - the service is
// briefly unreachable, not broken.
export function OfflineArt({ size = 132 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 132 132" role="img" aria-label="Reconnecting" className="ill">
      <circle cx="66" cy="66" r="46" fill={AMBER} opacity="0.08" className="ill-ripple" />
      <g className="ill-floaty" style={{ transformOrigin: "66px 60px" }}>
        <path
          d="M48 74 a15 15 0 0 1 1 -30 a20 20 0 0 1 38 6 a13 13 0 0 1 -3 24 Z"
          fill={PAPER}
          stroke={AMBER}
          strokeWidth="2.5"
        />
        <path d="M52 84 h28" stroke={AMBER} strokeWidth="3" strokeLinecap="round" strokeDasharray="2 6" className="ill-dash" />
      </g>
    </svg>
  );
}

// StatePanel is the standard layout for these pages: a centered illustration,
// a title, an optional subtitle, optional extra content, and a row of actions.
export function StatePanel({
  art,
  title,
  subtitle,
  actions,
  children,
  style,
}: {
  art: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <FadeIn
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        gap: 10,
        padding: "28px 20px",
        maxWidth: 560,
        margin: "0 auto",
        ...style,
      }}
    >
      {art}
      <Typography.Title level={4} style={{ margin: "6px 0 0" }}>
        {title}
      </Typography.Title>
      {subtitle && (
        <Typography.Text type="secondary" style={{ fontSize: 13.5, maxWidth: 480 }}>
          {subtitle}
        </Typography.Text>
      )}
      {children}
      {actions && <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", marginTop: 8 }}>{actions}</div>}
    </FadeIn>
  );
}

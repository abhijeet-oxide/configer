import { Typography } from "antd";

// A small kit of modern, dependency-free SVG illustrations with gentle,
// reduced-motion-aware animations (keyframes live in index.css). They replace
// the flat antd Result/Empty glyphs on the app's "state" pages - processing,
// success, empty, offline - so those pages read as considered and professional.
// Each illustration is theme-neutral: soft gradients that sit well on a card in
// light or dark, no hard-coded page backgrounds.

const OK = "#16a34a";
const OK2 = "#4ade80";
const BLUE = "#2f6bff";
const BLUE2 = "#7aa7ff";
const AMBER = "#f59e0b";

// SuccessArt: a soft ring that pops in and a checkmark that draws itself, with
// two sparks - a warmer "done" than a static tick.
export function SuccessArt({ size = 132 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 132 132" role="img" aria-label="Success" className="ill">
      <defs>
        <linearGradient id="ok-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={OK2} />
          <stop offset="1" stopColor={OK} />
        </linearGradient>
      </defs>
      <circle cx="66" cy="66" r="52" fill={OK} opacity="0.10" className="ill-ripple" />
      <circle cx="66" cy="66" r="40" fill="none" stroke="url(#ok-ring)" strokeWidth="6" className="ill-pop" style={{ transformOrigin: "66px 66px" }} />
      <path
        d="M46 67 L61 81 L88 51"
        fill="none"
        stroke="url(#ok-ring)"
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
  return (
    <svg width={size} height={size} viewBox="0 0 132 132" role="img" aria-label="Scanning" className="ill">
      <defs>
        <linearGradient id="scan-beam" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={BLUE} stopOpacity="0" />
          <stop offset="0.5" stopColor={BLUE} stopOpacity="0.55" />
          <stop offset="1" stopColor={BLUE} stopOpacity="0" />
        </linearGradient>
      </defs>
      <g className="ill-floaty" style={{ transformOrigin: "66px 66px" }}>
        <rect x="40" y="30" width="52" height="68" rx="8" fill="#fff" stroke={BLUE2} strokeWidth="2" />
        <rect x="40" y="30" width="52" height="68" rx="8" fill={BLUE} opacity="0.05" />
        {[44, 54, 64, 74, 84].map((y, i) => (
          <rect key={y} x="49" y={y} width={i % 2 ? 22 : 34} height="4" rx="2" fill={BLUE} opacity="0.28" />
        ))}
        {/* the sweeping beam */}
        <g className="ill-sweep">
          <rect x="40" y="30" width="52" height="10" fill="url(#scan-beam)" />
          <rect x="40" y="39" width="52" height="1.5" fill={BLUE} opacity="0.7" />
        </g>
      </g>
      <circle cx="98" cy="44" r="3.5" fill={BLUE} className="ill-spark" style={{ animationDelay: "0.2s" }} />
      <circle cx="34" cy="80" r="3" fill={BLUE2} className="ill-spark" style={{ animationDelay: "0.9s" }} />
    </svg>
  );
}

// EmptyArt: a friendly open tray - nothing here yet, in a calm way.
export function EmptyArt({ size = 120 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" role="img" aria-label="Nothing here" className="ill">
      <g className="ill-floaty" style={{ transformOrigin: "60px 62px" }}>
        <ellipse cx="60" cy="98" rx="34" ry="6" fill={BLUE} opacity="0.08" />
        <path d="M30 58 h60 l-8 30 a6 6 0 0 1 -6 5 H44 a6 6 0 0 1 -6 -5 Z" fill={BLUE} opacity="0.10" stroke={BLUE2} strokeWidth="2" />
        <path d="M40 58 v-16 a4 4 0 0 1 4 -4 h32 a4 4 0 0 1 4 4 v16" fill="none" stroke={BLUE2} strokeWidth="2" />
        <circle cx="60" cy="40" r="3" fill={BLUE2} className="ill-spark" style={{ animationDelay: "0.4s" }} />
      </g>
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
          fill="#fff"
          stroke={AMBER}
          strokeWidth="2.5"
          opacity="0.95"
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
    <div
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
    </div>
  );
}

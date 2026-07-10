// Small dependency-free SVG charts following the dataviz method:
// - categorical palette in FIXED slot order (validated: light worst adjacent
//   CVD dE 24.2, dark 10.3 with mandatory legend relief; every categorical
//   chart here renders a visible legend with labels, never color alone);
// - status colors are reserved for state and always paired with icon + label;
// - thin marks, 2px gaps between fills, one axis, no dual scales.
import { Tooltip, Typography } from "antd";
import { CheckCircleFilled, WarningFilled, CloseCircleFilled } from "@ant-design/icons";
import { useUI } from "../store";

const CAT_LIGHT = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"];
const CAT_DARK = ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767", "#d55181", "#d95926"];

export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  critical: "#d03b3b",
};

export function useCatPalette(): string[] {
  const mode = useUI((s) => s.mode);
  return mode === "dark" ? CAT_DARK : CAT_LIGHT;
}

// --- CategoryDonut ----------------------------------------------------------
// Identity chart: parameters per top-level category. Fixed slot order; more
// than 8 folds into "Other"; the side legend (label + count) carries identity.

export interface Slice {
  label: string;
  value: number;
}

export function CategoryDonut({ data, size = 132 }: { data: Slice[]; size?: number }) {
  const palette = useCatPalette();
  const slices = [...data].sort((a, b) => b.value - a.value);
  const shown = slices.slice(0, 7);
  const rest = slices.slice(7).reduce((s, x) => s + x.value, 0);
  if (rest > 0) shown.push({ label: "Other", value: rest });
  const total = shown.reduce((s, x) => s + x.value, 0) || 1;

  const R = size / 2;
  const r = R - 12; // ring thickness 12
  let angle = -Math.PI / 2;
  const arcs = shown.map((s, i) => {
    const sweep = (s.value / total) * Math.PI * 2;
    const pad = shown.length > 1 ? 0.03 : 0; // ~2px gap between segments
    const a0 = angle + pad / 2;
    const a1 = angle + sweep - pad / 2;
    angle += sweep;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const mid = r - 6;
    const p = (a: number, rad: number) => `${R + rad * Math.cos(a)},${R + rad * Math.sin(a)}`;
    return {
      d: `M ${p(a0, r)} A ${r} ${r} 0 ${large} 1 ${p(a1, r)} L ${p(a1, mid - 6)} A ${mid - 6} ${mid - 6} 0 ${large} 0 ${p(a0, mid - 6)} Z`,
      color: palette[i % palette.length],
      ...s,
    };
  });

  return (
    <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
      <svg width={size} height={size} role="img" aria-label="Parameters by category">
        {arcs.map((a) => (
          <Tooltip key={a.label} title={`${a.label}: ${a.value}`}>
            <path d={a.d} fill={a.color} />
          </Tooltip>
        ))}
        <text
          x={R}
          y={R + 1}
          textAnchor="middle"
          dominantBaseline="middle"
          style={{ fontSize: 20, fontWeight: 600, fill: "currentColor" }}
        >
          {total}
        </text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        {arcs.map((a) => (
          <span key={a.label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: a.color, flexShrink: 0 }} />
            <Typography.Text ellipsis style={{ fontSize: 12, maxWidth: 130 }}>{a.label}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{a.value}</Typography.Text>
          </span>
        ))}
      </div>
    </div>
  );
}

// --- HealthTiles -------------------------------------------------------------
// Status map: one tile per instance. Status is never color alone; each tile
// carries an icon and the counts as text.

export interface TileDatum {
  name: string;
  environment?: string;
  version?: string;
  invalid: number;
  pending: number;
}

export function HealthTiles({ data, onClick }: { data: TileDatum[]; onClick?: (name: string) => void }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))", gap: 8 }}>
      {data.map((t) => {
        const status = t.invalid > 0 ? "critical" : t.pending > 0 ? "warning" : "good";
        const color = STATUS[status];
        const Icon = status === "good" ? CheckCircleFilled : status === "warning" ? WarningFilled : CloseCircleFilled;
        const note =
          status === "good" ? "all valid" : status === "warning" ? `${t.pending} pending` : `${t.invalid} invalid`;
        return (
          <div
            key={t.name}
            className="card-clickable"
            onClick={() => onClick?.(t.name)}
            style={{
              border: `1px solid ${color}33`,
              background: `${color}14`,
              borderRadius: 8,
              padding: "8px 10px",
              cursor: onClick ? "pointer" : undefined,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13 }}>
              <Icon style={{ color }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
            </div>
            <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
              {t.environment ?? "-"} · {t.version ?? "-"}
            </div>
            <div style={{ fontSize: 11, marginTop: 2, color }}>{note}</div>
          </div>
        );
      })}
    </div>
  );
}

// --- ActivitySparkline --------------------------------------------------------
// Single series (change events per day): 2px line + soft area, no legend
// (the card title names the series), hover shows day + count per point.

export function ActivitySparkline({
  days,
  width = 260,
  height = 56,
}: {
  days: { label: string; count: number }[];
  width?: number;
  height?: number;
}) {
  const palette = useCatPalette();
  const max = Math.max(...days.map((d) => d.count), 1);
  const stepX = width / Math.max(days.length - 1, 1);
  const y = (c: number) => height - 6 - (c / max) * (height - 14);
  const pts = days.map((d, i) => `${i * stepX},${y(d.count)}`).join(" ");
  const area = `0,${height} ${pts} ${width},${height}`;
  return (
    <svg width={width} height={height} role="img" aria-label="Change activity per day" style={{ maxWidth: "100%" }}>
      <polygon points={area} fill={palette[0]} opacity={0.12} />
      <polyline points={pts} fill="none" stroke={palette[0]} strokeWidth={2} strokeLinejoin="round" />
      {days.map((d, i) => (
        <Tooltip key={d.label} title={`${d.label}: ${d.count} change${d.count === 1 ? "" : "s"}`}>
          <circle cx={i * stepX} cy={y(d.count)} r={d.count > 0 ? 3.5 : 2} fill={palette[0]} />
        </Tooltip>
      ))}
    </svg>
  );
}

// --- DiffMiniBar --------------------------------------------------------------
// Proportional composition of a compare result. Counts are always shown as
// text beside it (the existing tags), so the bar is a summary, not the only
// carrier of the numbers. 2px white gaps separate the segments.

export function DiffMiniBar({
  modified,
  added,
  removed,
  unchanged,
  width = 180,
}: {
  modified: number;
  added: number;
  removed: number;
  unchanged: number;
  width?: number;
}) {
  const total = modified + added + removed + unchanged || 1;
  const seg = (v: number) => Math.max((v / total) * width, v > 0 ? 6 : 0);
  const parts = [
    { v: modified, color: STATUS.warning, label: "modified" },
    { v: added, color: STATUS.good, label: "added" },
    { v: removed, color: STATUS.critical, label: "removed" },
    { v: unchanged, color: "#98989888", label: "unchanged" },
  ].filter((p) => p.v > 0);
  let x = 0;
  return (
    <svg width={width} height={10} role="img" aria-label="Change composition">
      {parts.map((p) => {
        const w = seg(p.v);
        const el = (
          <Tooltip key={p.label} title={`${p.v} ${p.label}`}>
            <rect x={x} y={0} width={Math.max(w - 2, 2)} height={10} rx={3} fill={p.color} />
          </Tooltip>
        );
        x += w;
        return el;
      })}
    </svg>
  );
}

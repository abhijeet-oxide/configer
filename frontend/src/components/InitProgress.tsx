import { CheckCircleFilled, LoadingOutlined } from "../icons";
import { Typography, theme as antdTheme } from "antd";
import { useEffect, useRef, useState } from "react";

// InitProgress is the mature "Initialize" experience: an animated progress ring
// with a live parameter counter and a stage checklist, so committing an
// application to Git reads as real, contextual progress rather than a spinner.
// Initialization is a single fast commit now, so the ring eases toward the end
// while the request is in flight and snaps to complete on success - the stage
// labels and counts reflect the actual work (instances + parameters written).

interface Stage {
  from: number;
  label: (p: { instances: number; params: number }) => string;
}

const STAGES: Stage[] = [
  { from: 0, label: () => "Preparing application metadata" },
  { from: 15, label: ({ instances }) => `Registering ${instances} instance${instances === 1 ? "" : "s"}` },
  { from: 35, label: ({ params }) => `Registering ${params} parameter${params === 1 ? "" : "s"}` },
  { from: 85, label: () => "Committing to Git" },
];

export default function InitProgress({
  instances,
  params,
  running,
  done,
}: {
  instances: number;
  params: number;
  running: boolean;
  done: boolean;
}) {
  const { token } = antdTheme.useToken();
  const [pct, setPct] = useState(0);
  const raf = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (done) {
      setPct(100);
      return;
    }
    if (!running) {
      setPct(0);
      return;
    }
    // Ease toward ~92% while the commit is in flight; success snaps to 100.
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / 2600, 1); // ~2.6s to approach the ceiling
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setPct(Math.min(92, eased * 92));
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [running, done]);

  const R = 54;
  const C = 2 * Math.PI * R;
  const shownParams = Math.round(params * Math.max(0, Math.min(1, (pct - 35) / 50)));
  const activeStage = STAGES.reduce((acc, s, i) => (pct >= s.from ? i : acc), 0);
  const accent = done ? token.colorSuccess : token.colorPrimary;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18, padding: "8px 0 4px" }}>
      <div style={{ position: "relative", width: 140, height: 140 }}>
        <svg width={140} height={140} viewBox="0 0 140 140" role="img" aria-label="Initializing">
          <circle cx={70} cy={70} r={R} fill="none" stroke={token.colorBorderSecondary} strokeWidth={9} />
          <circle
            cx={70}
            cy={70}
            r={R}
            fill="none"
            stroke={accent}
            strokeWidth={9}
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - pct / 100)}
            transform="rotate(-90 70 70)"
            style={{ transition: "stroke-dashoffset 0.25s linear, stroke 0.4s ease" }}
          />
          {/* Orbiting activity dot while running */}
          {!done && (
            <circle cx={70} cy={70 - R} r={4} fill={accent} className="init-orbit" />
          )}
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          {done ? (
            <CheckCircleFilled style={{ fontSize: 34, color: token.colorSuccess }} />
          ) : (
            <>
              <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1 }}>{Math.round(pct)}%</div>
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>working…</div>
            </>
          )}
        </div>
      </div>

      <div style={{ width: 300, display: "flex", flexDirection: "column", gap: 8 }}>
        {STAGES.map((s, i) => {
          const state = done || i < activeStage ? "done" : i === activeStage ? "active" : "idle";
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, opacity: state === "idle" ? 0.4 : 1 }}>
              <span style={{ width: 18, display: "inline-flex", justifyContent: "center" }}>
                {state === "done" ? (
                  <CheckCircleFilled style={{ color: token.colorSuccess, fontSize: 15 }} />
                ) : state === "active" ? (
                  <LoadingOutlined style={{ color: token.colorPrimary }} />
                ) : (
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: token.colorBorderSecondary }} />
                )}
              </span>
              <Typography.Text style={{ fontSize: 13, fontWeight: state === "active" ? 600 : 400 }}>
                {s.label({ instances, params })}
                {i === 2 && state === "active" && (
                  <Typography.Text type="secondary" style={{ fontSize: 12, marginInlineStart: 6 }}>
                    {shownParams} / {params}
                  </Typography.Text>
                )}
              </Typography.Text>
            </div>
          );
        })}
      </div>
    </div>
  );
}

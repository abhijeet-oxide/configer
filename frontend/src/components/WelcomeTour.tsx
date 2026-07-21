import { useEffect, useState } from "react";
import { Button, Modal } from "antd";
import { ArrowLeftOutlined } from "../icons";
import { theme as brand } from "../theme.config";
import { markWelcomeSeen, welcomeSeen } from "../settings";
import { useUI } from "../store";
import { useTimeSettings } from "../timefmt";
import { zoneOffsetLabel } from "../settings";
import {
  DensityControl,
  FontScaleControl,
  HourCycleControl,
  ThemeControl,
  TimeZoneControl,
} from "./PreferenceControls";

// WelcomeTour greets a first visit (and replays from Settings): a short,
// skippable set-up - make it yours (theme, text, density), set your clock
// (time zone, format) - with every choice applying LIVE, so the product
// restyles itself under the dialog as you pick. Everything here is the same
// control the Settings page renders; the tour is an invitation, not a fork.

interface StepDef {
  key: string;
  title: string;
  lead: string;
  body: React.ReactNode;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: "var(--fs-12)", fontWeight: 600, color: "var(--text-2)" }}>{label}</div>
      {children}
    </div>
  );
}

// The clock preview inside the tour: proves the zone choice with the actual
// current time.
function ClockPreview() {
  const { timeZone, hourCycle } = useTimeSettings();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const text = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone,
    hour12: hourCycle === "h12" ? true : hourCycle === "h23" ? false : undefined,
  }).format(now);
  return (
    <div style={{ fontSize: "var(--fs-12)", color: "var(--text-2)" }}>
      Right now for you: <b style={{ color: "var(--text)" }}>{text}</b> · {zoneOffsetLabel(timeZone)}
    </div>
  );
}

export default function WelcomeTour() {
  const welcomeOpen = useUI((s) => s.welcomeOpen);
  const setWelcomeOpen = useUI((s) => s.setWelcomeOpen);
  const [firstRun, setFirstRun] = useState(false);
  const [step, setStep] = useState(0);

  // First visit on this device: open once, after the app has painted.
  useEffect(() => {
    if (!welcomeSeen()) setFirstRun(true);
  }, []);
  const open = firstRun || welcomeOpen;

  const close = () => {
    markWelcomeSeen();
    setFirstRun(false);
    setWelcomeOpen(false);
    setStep(0);
  };

  const steps: StepDef[] = [
    {
      key: "welcome",
      title: `Welcome to ${brand.appName}`,
      lead: "Configuration straight from your Git repository - browsed as a grid, edited safely, reviewed and published as ordinary commits.",
      body: (
        <div className="tour-hero">
          {brand.logo.svg ? (
            <span className="tour-hero-mark" dangerouslySetInnerHTML={{ __html: brand.logo.svg }} />
          ) : (
            <span className="tour-hero-mark">{brand.logo.text ?? brand.appName.charAt(0)}</span>
          )}
          <div style={{ fontSize: "var(--fs-12)", color: "var(--text-2)", maxWidth: 380, textAlign: "center" }}>
            Two quick steps make it feel like yours. Every choice applies instantly,
            and you can change it anytime from your profile at the bottom of the sidebar.
          </div>
        </div>
      ),
    },
    {
      key: "appearance",
      title: "Make it yours",
      lead: "Watch the page behind this window follow along as you pick.",
      body: (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <Field label="Theme">
            <ThemeControl />
          </Field>
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
            <Field label="Text size">
              <FontScaleControl />
            </Field>
            <Field label="Density">
              <DensityControl />
            </Field>
          </div>
        </div>
      ),
    },
    {
      key: "time",
      title: "Set your clock",
      lead: "Every date and time in Configer is shown in your zone. We detected this device's - keep it, or follow a team elsewhere.",
      body: (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <Field label="Time zone">
            <TimeZoneControl />
          </Field>
          <Field label="Clock format">
            <HourCycleControl />
          </Field>
          <ClockPreview />
        </div>
      ),
    },
  ];

  const s = steps[step];
  const last = step === steps.length - 1;

  return (
    <Modal
      open={open}
      onCancel={close}
      footer={null}
      width={560}
      centered
      destroyOnClose
      maskClosable={false}
    >
      <div style={{ padding: "8px 4px 0" }}>
        <div style={{ fontSize: "var(--fs-20)", fontWeight: 600, marginBottom: 4 }}>{s.title}</div>
        <div style={{ fontSize: "var(--fs-13)", color: "var(--text-2)", marginBottom: 20, maxWidth: 460 }}>
          {s.lead}
        </div>
        <div style={{ minHeight: 180 }}>{s.body}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 24 }}>
          <div className="tour-dots" role="tablist" aria-label="Tour progress">
            {steps.map((d, i) => (
              <button
                key={d.key}
                type="button"
                role="tab"
                aria-selected={i === step}
                aria-label={d.title}
                className={`tour-dot${i === step ? " tour-dot-active" : ""}`}
                onClick={() => setStep(i)}
              />
            ))}
          </div>
          <div style={{ flex: 1 }} />
          {step === 0 ? (
            <Button type="text" onClick={close}>
              Skip for now
            </Button>
          ) : (
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          {last ? (
            <Button type="primary" onClick={close}>
              Start working
            </Button>
          ) : (
            <Button type="primary" onClick={() => setStep(step + 1)}>
              {step === 0 ? "Set it up" : "Continue"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

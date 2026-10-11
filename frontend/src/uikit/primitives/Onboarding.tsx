import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "antd";
import type { BrandIdentity } from "../brand";
import { useTheme } from "../ThemeProvider";
import { deviceTimeZone } from "../prefs";
import { BrandMark, Wordmark } from "./BrandLockup";
import Stepper from "./Stepper";
import {
  ColorVisionControl,
  ContrastControl,
  DateFormatControl,
  DateTimePreview,
  DensityControl,
  FontScaleControl,
  HourCycleControl,
  MotionControl,
  SettingRow,
  ThemeControl,
  TimeZoneControl,
  UnderlineLinksControl,
} from "./AppearanceControls";

// First-run setup. Shown once per browser, on whichever module a person opens
// first: the preferences live under one key on the origin (prefs.ts), so
// finishing here settles every other module too. Each control applies as it
// is changed, so the page under the panel is the preview.

interface Step {
  label: string;
  title: string;
  body: ReactNode;
}

const STEPS: Step[] = [
  {
    label: "Accessibility",
    title: "Accessibility",
    body: (
      <div className="ui-settings-group">
        <SettingRow
          title="Contrast"
          description="High darkens secondary text, borders and the brand blue."
          control={<ContrastControl />}
        />
        <SettingRow
          stacked
          title="Color vision"
          description="Status, severity and comparison colors move onto hues that remain distinct."
          control={<ColorVisionControl />}
        />
        <SettingRow title="Reduce motion" description="Stops animations and transitions." control={<MotionControl />} />
        <SettingRow title="Underline links" description="Marks links with an underline as well as color." control={<UnderlineLinksControl />} />
      </div>
    ),
  },
  {
    label: "Theme",
    title: "Theme",
    body: (
      <div className="ui-settings-group">
        <SettingRow stacked title="Theme" description="System follows the device setting." control={<ThemeControl />} />
      </div>
    ),
  },
  {
    label: "Text and density",
    title: "Text size and density",
    body: (
      <div className="ui-settings-group">
        <SettingRow stacked title="Text size" description="Applies to every page, table and dialog." control={<FontScaleControl />} />
        <SettingRow stacked title="Density" description="Compact fits more rows on a smaller screen." control={<DensityControl />} />
      </div>
    ),
  },
  {
    label: "Date and time",
    title: "Date and time",
    body: (
      <div className="ui-settings-group">
        <SettingRow
          stacked
          title="Time zone"
          description="Detected from this device. Every absolute date and time is shown in this zone."
          control={<TimeZoneControl />}
        />
        <SettingRow stacked title="Date format" description={<DateTimePreview />} control={<DateFormatControl />} />
        <SettingRow title="Clock" control={<HourCycleControl />} />
      </div>
    ),
  },
];

export default function Onboarding({ brand, name }: { brand: BrandIdentity; name: string }) {
  const { needsOnboarding, timeZone, setAppearance } = useTheme();
  const [step, setStep] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  // The detected zone is written down at once, so the Date and time step
  // shows it selected rather than "follow the device".
  useEffect(() => {
    if (needsOnboarding && !timeZone) setAppearance({ timeZone: deviceTimeZone() });
  }, [needsOnboarding, timeZone, setAppearance]);

  useEffect(() => {
    if (needsOnboarding) heading.current?.focus();
  }, [needsOnboarding, step]);

  if (!needsOnboarding) return null;

  const finish = () => {
    setStep(0);
    setAppearance({ timeZone: timeZone || deviceTimeZone(), onboardedAt: new Date().toISOString() });
  };
  const last = step === STEPS.length - 1;
  const current = STEPS[step] ?? STEPS[0]!;

  return (
    <div className="ui-onboarding" role="dialog" aria-modal="true" aria-labelledby="ui-onboarding-title">
      <div className="ui-onboarding-panel">
        <header className="ui-onboarding-head">
          <BrandMark brand={brand} size={40} />
          <h1 id="ui-onboarding-title" className="ui-onboarding-welcome">
            Welcome to the <Wordmark name={name} />
          </h1>
          <p className="ui-onboarding-sub">Customize your experience</p>
        </header>

        <Stepper steps={STEPS.map((s) => ({ label: s.label }))} current={step} ariaLabel="Setup steps" />

        <section className="ui-onboarding-body">
          <h2 ref={heading} tabIndex={-1} className="ui-onboarding-step">
            {current.title}
          </h2>
          {current.body}
        </section>

        <footer className="ui-onboarding-foot">
          <Button type="text" onClick={finish}>Skip setup</Button>
          <span className="ui-onboarding-note">Saved in this browser for every module. Changed later under Profile.</span>
          <div className="ui-onboarding-actions">
            {step > 0 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
            <Button type="primary" onClick={last ? finish : () => setStep(step + 1)}>
              {last ? "Finish" : "Continue"}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

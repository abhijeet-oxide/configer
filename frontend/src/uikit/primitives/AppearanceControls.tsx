import { useMemo, type ReactNode } from "react";
import { Button, Popconfirm, Segmented, Select, Switch, Tooltip } from "antd";
import { MoonIcon, SunIcon } from "../icons";
import { useTheme } from "../ThemeProvider";
import { deviceTimeZone, type ColorVision, type Contrast, type DateFormat, type Density, type FontScale, type HourCycle, type ThemePref } from "../prefs";
import { accessiblePalette } from "../access";
import { tokens } from "../tokens";
import { previewDateTime, timeZones, zoneLabel } from "../dates";
import { pointOf } from "../themeTransition";

// The appearance controls, shared so both tools offer the same three choices,
// in the same order, with the same words. A person who learned one already
// knows the other, and neither can quietly grow a fourth option the other
// lacks.
//
// They read the ThemeProvider rather than any app's own store, which is what
// lets one implementation serve an app that owns its settings model and one
// that does not: the provider is controlled in the first case and
// self-persisting in the second, and the control cannot tell the difference.

/**
 * ThemeTile is a MINIATURE OF THE APPLICATION ITSELF: navy navigation, canvas,
 * two content lines, drawn in the palette it would apply. The "system" tile is
 * split diagonally between both.
 *
 * A picture answers "what will this look like?" faster than any label, which
 * is why this is three tiles rather than three words. The miniature reads its
 * colours from the tokens, so it keeps telling the truth after a reskin - a
 * hardcoded navy would go on advertising a palette nobody ships any more.
 */
function ThemeTile({
  value,
  label,
  selected,
  onSelect,
}: {
  value: ThemePref;
  label: string;
  selected: boolean;
  onSelect: (from?: { x: number; y: number }) => void;
}) {
  const mini = (dark: boolean) => (
    <span
      className={`ui-theme-mini${dark ? " is-dark" : ""}`}
      style={
        // The system tile layers this twice with a diagonal clip.
        value === "system" && dark
          ? { clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }
          : undefined
      }
    >
      <span className="ui-theme-mini-nav" />
      <span className="ui-theme-mini-page">
        <span className="ui-theme-mini-line is-long" />
        <span className="ui-theme-mini-line is-short" />
        <span className="ui-theme-mini-accent" />
      </span>
    </span>
  );
  return (
    <button
      type="button"
      className={`ui-theme-tile${selected ? " is-selected" : ""}`}
      // The reveal grows from the tile that was clicked, so the change starts
      // where the reader's attention already is.
      onClick={(e) => onSelect(pointOf(e))}
      aria-pressed={selected}
      aria-label={`${label} theme`}
    >
      <span className="ui-theme-tile-art">
        {mini(value === "dark")}
        {value === "system" && mini(true)}
      </span>
      <span className="ui-theme-tile-label">{label}</span>
    </button>
  );
}

const THEME_OPTIONS: Array<{ value: ThemePref; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export function ThemeControl() {
  const { theme, setTheme } = useTheme();
  const current = THEME_OPTIONS.find((o) => o.value === theme)?.label ?? theme;
  return (
    <div>
      <div className="ui-theme-tiles">
        {THEME_OPTIONS.map((o) => (
          <ThemeTile
            key={o.value}
            value={o.value}
            label={o.label}
            selected={theme === o.value}
            onSelect={(from) => setTheme(o.value, from)}
          />
        ))}
      </div>
      <div className="ui-setting-row-desc" style={{ marginTop: 8 }}>Current: {current}</div>
    </div>
  );
}

/** The compact form, for a toolbar with no room for three tiles. */
export function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  return (
    <Segmented
      size="small"
      value={theme}
      onChange={(v) => setTheme(v as ThemePref)}
      options={THEME_OPTIONS}
    />
  );
}

/** A single button that flips light and dark, for a top bar with no room for
 *  three. It settles the PREFERENCE on the result rather than leaving it on
 *  "system", because a toggle that the OS overrides an hour later is a toggle
 *  that appears not to work. */
export function ThemeToggleButton() {
  const { mode, toggleMode } = useTheme();
  return (
    <Tooltip title={mode === "dark" ? "Switch to light" : "Switch to dark"}>
      <Button
        type="text"
        // The point is what turns a theme switch into a reveal: the new theme
        // grows out of the button the reader just pressed. A keyboard
        // activation has no coordinates and correctly gets an instant switch.
        onClick={(e) => toggleMode(pointOf(e))}
        aria-label={mode === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        icon={mode === "dark" ? <SunIcon /> : <MoonIcon />}
      />
    </Tooltip>
  );
}

export function FontScaleControl() {
  const { fontScale, setFontScale } = useTheme();
  // The label is set in the size it selects, so the control demonstrates its
  // own effect rather than describing it.
  const opt = (value: FontScale, label: string, px: number) => ({
    value,
    label: (
      <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontSize: px, fontWeight: 600, lineHeight: 1 }}>Aa</span>
        {label}
      </span>
    ),
  });
  const current = { small: "Small", normal: "Default", large: "Large", xlarge: "Extra large" }[fontScale];
  return (
    <div>
      <Segmented
        value={fontScale}
        onChange={(v) => setFontScale(v as FontScale)}
        options={[
          opt("small", "Small", 12),
          opt("normal", "Default", 14),
          opt("large", "Large", 16),
          opt("xlarge", "Extra large", 18),
        ]}
      />
      <div className="ui-setting-row-desc" style={{ marginTop: 8 }}>Current: {current}</div>
    </div>
  );
}

export function DensityControl() {
  const { density, setDensity } = useTheme();
  const current = density === "compact" ? "Compact" : "Comfortable";
  return (
    <div>
      <Segmented
        value={density}
        onChange={(v) => setDensity(v as Density)}
        options={[
          { value: "compact", label: "Compact" },
          { value: "comfortable", label: "Comfortable" },
        ]}
      />
      <div className="ui-setting-row-desc" style={{ marginTop: 8 }}>Current: {current}</div>
    </div>
  );
}

export function ContrastControl() {
  const { contrast, setContrast } = useTheme();
  return (
    <Segmented
      value={contrast}
      onChange={(v) => setContrast(v as Contrast)}
      options={[
        { value: "standard", label: "Standard" },
        { value: "high", label: "High" },
      ]}
    />
  );
}

const VISION_OPTIONS: Array<{ value: ColorVision; label: string; detail: string }> = [
  { value: "typical", label: "Default colors", detail: "Green for success, red for failure" },
  { value: "red-green", label: "Red-green safe", detail: "Protanopia and deuteranopia: blue, yellow, vermilion" },
  { value: "blue-yellow", label: "Blue-yellow safe", detail: "Tritanopia: teal, amber, crimson" },
];

function swatches(colorVision: ColorVision, mode: "light" | "dark"): string[] {
  const p = accessiblePalette(mode === "dark" ? tokens.dark : tokens.light, mode, { contrast: "standard", colorVision });
  return [p.ok, p.pending, p.danger];
}

/** Three cards, each showing the success, warning and failure colours it
 *  paints, so the choice is made by looking rather than by name. */
export function ColorVisionControl() {
  const { colorVision, setColorVision, mode } = useTheme();
  return (
    <div className="ui-vision-tiles" role="radiogroup" aria-label="Color vision">
      {VISION_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={colorVision === o.value}
          className={`ui-vision-tile${colorVision === o.value ? " is-selected" : ""}`}
          onClick={() => setColorVision(o.value)}
        >
          <span className="ui-vision-swatches" aria-hidden="true">
            {swatches(o.value, mode).map((color) => (
              <span key={color} style={{ background: color }} />
            ))}
          </span>
          <span className="ui-vision-label">{o.label}</span>
          <span className="ui-vision-detail">{o.detail}</span>
        </button>
      ))}
    </div>
  );
}

export function MotionControl() {
  const { motion, setMotion } = useTheme();
  return (
    <Switch
      checked={motion === "reduce"}
      onChange={(on) => setMotion(on ? "reduce" : "system")}
      aria-label="Reduce motion"
    />
  );
}

export function UnderlineLinksControl() {
  const { underlineLinks, setUnderlineLinks } = useTheme();
  return <Switch checked={underlineLinks} onChange={setUnderlineLinks} aria-label="Underline links" />;
}

export function TimeZoneControl() {
  const { timeZone, setTimeZone } = useTheme();
  const device = deviceTimeZone();
  const options = useMemo(() => {
    const now = Date.now();
    return [
      { value: "", label: `Device time zone - ${device} (${zoneLabel(device, now)})` },
      ...timeZones().map((zone) => ({ value: zone, label: `${zone.replace(/_/g, " ")} (${zoneLabel(zone, now)})` })),
    ];
  }, [device]);
  return (
    <Select
      showSearch
      value={timeZone}
      onChange={setTimeZone}
      options={options}
      optionFilterProp="label"
      style={{ width: "min(100%, 380px)" }}
      aria-label="Time zone"
    />
  );
}

const DATE_FORMATS: Array<{ value: DateFormat; label: string }> = [
  { value: "us", label: "US" },
  { value: "us-numeric", label: "US numeric" },
  { value: "gb", label: "UK and Europe" },
  { value: "gb-numeric", label: "UK and Europe numeric" },
  { value: "iso", label: "ISO 8601" },
];

export function DateFormatControl() {
  const { dateFormat, hourCycle, timeZone, setDateFormat } = useTheme();
  return (
    <Select
      value={dateFormat}
      onChange={(v) => setDateFormat(v as DateFormat)}
      options={DATE_FORMATS.map((o) => ({
        value: o.value,
        label: `${o.label} - ${previewDateTime({ dateFormat: o.value, hourCycle, timeZone })}`,
      }))}
      style={{ width: "min(100%, 380px)" }}
      aria-label="Date format"
    />
  );
}

export function HourCycleControl() {
  const { hourCycle, setHourCycle } = useTheme();
  return (
    <Segmented
      value={hourCycle}
      onChange={(v) => setHourCycle(v as HourCycle)}
      options={[
        { value: "12", label: "12-hour" },
        { value: "24", label: "24-hour" },
      ]}
    />
  );
}

/** Today, written the way every absolute date in the tool will be. */
export function DateTimePreview() {
  const { dateFormat, hourCycle, timeZone, effectiveTimeZone } = useTheme();
  return (
    <div className="ui-setting-row-desc">
      Shown as {previewDateTime({ dateFormat, hourCycle, timeZone })} ({zoneLabel(effectiveTimeZone)}). Relative times
      such as 5 minutes ago are unchanged.
    </div>
  );
}

/** One labelled row of a settings surface. */
export function SettingRow({
  title,
  description,
  control,
  stacked,
}: {
  title: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  /** put the control under the text rather than beside it, for a wide one */
  stacked?: boolean;
}) {
  return (
    <div className={`ui-setting-row${stacked ? " is-stacked" : ""}`}>
      <div className="ui-setting-row-text">
        <div className="ui-setting-row-title">{title}</div>
        {description && <div className="ui-setting-row-desc">{description}</div>}
      </div>
      <div className="ui-setting-row-control">{control}</div>
    </div>
  );
}

/**
 * The whole Appearance section, copy included.
 *
 * The words are here rather than at each call site on purpose: "System follows
 * your device" is the same sentence in every tool, and two products that
 * explain the same control differently are two products.
 */
export default function AppearanceSettings() {
  return (
    <div className="ui-settings-group">
      <SettingRow
        stacked
        title="Theme"
        description="Match device theme. Top-bar toggle still works."
        control={<ThemeControl />}
      />
      <SettingRow
        title="Text size"
        description="Applies everywhere, from tables to dialogs."
        control={<FontScaleControl />}
      />
      <SettingRow
        title="Density"
        description="Compact tightens controls and tables to fit more on screen."
        control={<DensityControl />}
      />
    </div>
  );
}

/** Contrast, colour vision, motion and links. */
export function AccessibilitySettings() {
  return (
    <div className="ui-settings-group">
      <SettingRow
        title="Contrast"
        description="High darkens secondary text, borders and the brand blue, and thickens the keyboard focus ring."
        control={<ContrastControl />}
      />
      <SettingRow
        stacked
        title="Color vision"
        description="Moves every status, severity and comparison color onto hues that remain distinct. Labels and icons still carry the meaning."
        control={<ColorVisionControl />}
      />
      <SettingRow
        title="Reduce motion"
        description="Stops animations and transitions. Off follows the device setting."
        control={<MotionControl />}
      />
      <SettingRow
        title="Underline links"
        description="Marks every link with an underline as well as color."
        control={<UnderlineLinksControl />}
      />
    </div>
  );
}

/** Time zone, date format and clock. */
export function DateTimeSettings() {
  return (
    <div className="ui-settings-group">
      <SettingRow
        stacked
        title="Time zone"
        description="Every absolute date and time is shown in this zone."
        control={<TimeZoneControl />}
      />
      <SettingRow stacked title="Date format" description={<DateTimePreview />} control={<DateFormatControl />} />
      <SettingRow title="Clock" control={<HourCycleControl />} />
    </div>
  );
}

/** Forgets every preference on this browser, and shows first-run setup again. */
export function ResetPreferences() {
  const { resetAppearance } = useTheme();
  return (
    <SettingRow
      title="Reset preferences"
      description="Deletes the saved accessibility, appearance and date settings from this browser for every module, and opens first-run setup."
      control={
        <Popconfirm
          title="Reset all preferences?"
          description="Every module returns to the default settings."
          okText="Reset"
          okButtonProps={{ danger: true }}
          onConfirm={resetAppearance}
        >
          <Button danger>Reset preferences</Button>
        </Popconfirm>
      }
    />
  );
}

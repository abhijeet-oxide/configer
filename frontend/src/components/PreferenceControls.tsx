import { useMemo } from "react";
import { Segmented, Select } from "antd";
import { useUI } from "../store";
import {
  allTimeZones,
  deviceTimeZone,
  zoneAliasTerms,
  zoneOffsetLabel,
  type Density,
  type FontScale,
  type HourCycle,
  type ThemePref,
} from "../settings";

// The personal-preference controls, defined ONCE and rendered by both the
// Settings page and the welcome tour. Adding a preference means adding a
// control here and a row on the Settings page - the tour and the page can
// never drift apart.

// ThemeTile is a miniature of the app itself: navy rail, canvas, two content
// lines - drawn in the palette it would apply. The "system" tile is split
// diagonally between both. A picture answers "what will this look like?"
// faster than any label.
function ThemeTile({
  value,
  label,
  selected,
  onSelect,
}: {
  value: ThemePref;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const mini = (dark: boolean) => (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: dark ? "#101318" : "#eef1f6",
        display: "flex",
        // The system tile layers this twice with a diagonal clip.
        clipPath: value === "system" && dark ? "polygon(100% 0, 100% 100%, 0 100%)" : undefined,
      }}
    >
      <div style={{ width: "26%", background: dark ? "#081830" : "#0a1f3c" }} />
      <div style={{ flex: 1, padding: "7px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ height: 5, width: "62%", borderRadius: 3, background: dark ? "#353b45" : "#d5dbe4" }} />
        <div style={{ height: 5, width: "40%", borderRadius: 3, background: dark ? "#262b33" : "#e7ebf1" }} />
        <div style={{ marginTop: "auto", height: 8, width: "30%", borderRadius: 3, background: "var(--brand)" }} />
      </div>
    </div>
  );
  return (
    <button
      type="button"
      className={`pref-theme-tile${selected ? " pref-theme-tile-selected" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${label} theme`}
    >
      <span className="pref-theme-tile-art">
        {mini(value === "dark")}
        {value === "system" && mini(true)}
      </span>
      <span className="pref-theme-tile-label">{label}</span>
    </button>
  );
}

export function ThemeControl() {
  const themePref = useUI((s) => s.themePref);
  const setThemePref = useUI((s) => s.setThemePref);
  const options: Array<{ value: ThemePref; label: string }> = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "System" },
  ];
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      {options.map((o) => (
        <ThemeTile
          key={o.value}
          value={o.value}
          label={o.label}
          selected={themePref === o.value}
          onSelect={() => setThemePref(o.value)}
        />
      ))}
    </div>
  );
}

export function FontScaleControl() {
  const fontScale = useUI((s) => s.fontScale);
  const setFontScale = useUI((s) => s.setFontScale);
  const opt = (value: FontScale, label: string, px: number) => ({
    value,
    label: (
      <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontSize: px, fontWeight: 600, lineHeight: 1 }}>Aa</span>
        {label}
      </span>
    ),
  });
  return (
    <Segmented
      value={fontScale}
      onChange={(v) => setFontScale(v as FontScale)}
      options={[opt("small", "Small", 12), opt("normal", "Default", 14), opt("large", "Large", 16)]}
    />
  );
}

export function DensityControl() {
  const density = useUI((s) => s.density);
  const setDensity = useUI((s) => s.setDensity);
  return (
    <Segmented
      value={density}
      onChange={(v) => setDensity(v as Density)}
      options={[
        { value: "comfortable", label: "Comfortable" },
        { value: "compact", label: "Compact" },
      ]}
    />
  );
}

export function TimeZoneControl({ width }: { width?: number | string }) {
  const timeZone = useUI((s) => s.timeZone);
  const setTimeZone = useUI((s) => s.setTimeZone);
  const detected = deviceTimeZone();
  // ~430 zones with a current-offset label each; computed once per mount.
  const options = useMemo(() => {
    const auto = {
      value: "__auto",
      label: `Same as this device · ${detected.replace(/_/g, " ")} (${zoneOffsetLabel(detected)})`,
      search: `auto device ${detected}`,
    };
    const zones = allTimeZones().map((z) => ({
      value: z,
      label: `${z.replace(/_/g, " ")} (${zoneOffsetLabel(z)})`,
      search: `${z.replace(/_/g, " ")} ${zoneAliasTerms(z)} ${zoneOffsetLabel(z)}`,
    }));
    return [auto, ...zones];
  }, [detected]);
  return (
    <Select
      showSearch
      value={timeZone ?? "__auto"}
      onChange={(v) => setTimeZone(v === "__auto" ? null : v)}
      options={options}
      style={{ width: width ?? "100%", maxWidth: 420 }}
      optionFilterProp="search"
      filterOption={(input, option) =>
        (option?.search ?? "").toLowerCase().includes(input.toLowerCase().trim())
      }
    />
  );
}

export function HourCycleControl() {
  const hourCycle = useUI((s) => s.hourCycle);
  const setHourCycle = useUI((s) => s.setHourCycle);
  return (
    <Segmented
      value={hourCycle}
      onChange={(v) => setHourCycle(v as HourCycle)}
      options={[
        { value: "auto", label: "Automatic" },
        { value: "h12", label: "12-hour" },
        { value: "h23", label: "24-hour" },
      ]}
    />
  );
}

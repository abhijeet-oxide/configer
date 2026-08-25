import { useMemo } from "react";
import { Segmented, Select } from "antd";
import { useUI } from "../store";
import {
  allTimeZones,
  deviceTimeZone,
  zoneAliasTerms,
  zoneOffsetLabel,
  type HourCycle,
} from "../settings";

// The personal-preference controls, defined ONCE and rendered by both the
// Settings page and the welcome tour. Adding a preference means adding a
// control here and a row on the Settings page - the tour and the page can
// never drift apart.

// Theme, text size and density are the SHARED design system's controls now,
// re-exported here so the Settings page and the welcome tour keep one import
// and the two tools cannot explain the same control in different words. Only
// the region controls below are Configer's own: they read a time zone and a
// clock format that live in this app's settings document.
export { ThemeControl, FontScaleControl, DensityControl } from "../uikit";

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

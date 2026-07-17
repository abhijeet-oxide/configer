import { Tooltip } from "antd";

// UserAvatar is the one avatar used everywhere a person or the Configer Bot is
// shown. It is deterministic and offline: a person's initials sit on a gradient
// derived from a hash of their identity, so the same user always reads the same
// (and different users are easy to tell apart at a glance). The Configer Bot
// gets its own distinct robot mark on the brand color, so machine-made commits
// are never mistaken for a human's.

// A stable 32-bit hash of a string (FNV-1a), for picking colors deterministically.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// isBot recognizes the machine identity by name so it gets the robot avatar
// wherever it appears (commits, audit, activity).
export function isBot(name?: string): boolean {
  const n = (name ?? "").toLowerCase();
  return n.includes("configer bot") || n.includes("configer-bot") || n === "bot";
}

// A person's display initials: first letters of the first two words, or the
// first two characters of a single token (email/login), uppercased.
function initials(name: string): string {
  const clean = name.replace(/<[^>]*>/g, "").replace(/\([^)]*\)/g, "").trim();
  const words = clean.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const one = words[0] ?? name;
  return one.slice(0, 2).toUpperCase();
}

export default function UserAvatar({
  name,
  size = 22,
  tooltip = true,
}: {
  name?: string;
  size?: number;
  /** show the full name on hover */
  tooltip?: boolean;
}) {
  const label = (name ?? "").replace(/<[^>]*>/g, "").trim() || "Unknown";
  const bot = isBot(name);

  const el = bot ? (
    <span
      aria-label="Configer Bot"
      style={{
        width: size,
        height: size,
        borderRadius: size,
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--brand)",
        color: "#fff",
      }}
    >
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none">
        <rect x="4" y="8" width="16" height="12" rx="3" fill="currentColor" opacity="0.95" />
        <circle cx="9.5" cy="14" r="1.6" fill="var(--brand)" />
        <circle cx="14.5" cy="14" r="1.6" fill="var(--brand)" />
        <path d="M12 3.5V6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="12" cy="3" r="1.5" fill="currentColor" />
      </svg>
    </span>
  ) : (
    (() => {
      const h = hash(label);
      const hue = h % 360;
      const hue2 = (hue + 40) % 360;
      return (
        <span
          aria-label={label}
          style={{
            width: size,
            height: size,
            borderRadius: size,
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: `linear-gradient(135deg, hsl(${hue} 62% 52%), hsl(${hue2} 58% 44%))`,
            color: "#fff",
            fontSize: size * 0.42,
            fontWeight: 600,
            letterSpacing: 0.2,
            lineHeight: 1,
            userSelect: "none",
          }}
        >
          {initials(label)}
        </span>
      );
    })()
  );

  if (!tooltip) return el;
  return (
    <Tooltip title={bot ? "Configer Bot (automation)" : label}>
      {el}
    </Tooltip>
  );
}

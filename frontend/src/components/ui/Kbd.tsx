// Kbd is the small keycap used for keyboard-shortcut hints, styled once so every
// shortcut reads the same across the app (the palette, the top bar, grid hints).
export default function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      style={{
        fontFamily: "inherit",
        fontSize: 11,
        lineHeight: "16px",
        minWidth: 18,
        display: "inline-block",
        textAlign: "center",
        color: "var(--text-3)",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "0 5px",
      }}
    >
      {children}
    </kbd>
  );
}

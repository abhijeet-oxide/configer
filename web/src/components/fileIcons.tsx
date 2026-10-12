// Lightweight, dependency-free file/folder icons in the spirit of a VS Code
// icon theme: a glyph tinted by file type, so the trees read at a glance
// without pulling in a heavy icon-theme package.
import {
  FileTextOutlined,
  FileMarkdownOutlined,
  Html5Outlined,
  CodeOutlined,
  FileOutlined,
  FolderFilled,
  FolderOpenFilled,
  SettingOutlined,
  LockOutlined,
} from "../icons";

interface IconSpec {
  icon: React.ReactNode;
  color: string;
}

// Extension → glyph + color. Colors are chosen to be distinct in both themes.
const BY_EXT: Record<string, IconSpec> = {
  yaml: { icon: <FileTextOutlined />, color: "#cb4b16" }, // yaml/helm/flux; warm
  yml: { icon: <FileTextOutlined />, color: "#cb4b16" },
  json: { icon: <CodeOutlined />, color: "#d9a400" }, // amber
  xml: { icon: <CodeOutlined />, color: "#7c3aed" }, // violet
  toml: { icon: <SettingOutlined />, color: "#9c6b30" },
  ini: { icon: <SettingOutlined />, color: "#9c6b30" },
  conf: { icon: <SettingOutlined />, color: "#9c6b30" },
  properties: { icon: <SettingOutlined />, color: "#9c6b30" },
  env: { icon: <SettingOutlined />, color: "#0ca30c" },
  md: { icon: <FileMarkdownOutlined />, color: "#2a78d6" },
  html: { icon: <Html5Outlined />, color: "#e34c26" },
  sh: { icon: <CodeOutlined />, color: "#4eaa25" },
  crt: { icon: <LockOutlined />, color: "#c0392b" },
  key: { icon: <LockOutlined />, color: "#c0392b" },
  pem: { icon: <LockOutlined />, color: "#c0392b" },
};

// Some well-known filenames get their own treatment (kustomize/kpt/helm).
const BY_NAME: Record<string, IconSpec> = {
  "kustomization.yaml": { icon: <SettingOutlined />, color: "#326ce5" }, // k8s blue
  "kustomization.yml": { icon: <SettingOutlined />, color: "#326ce5" },
  "kptfile": { icon: <SettingOutlined />, color: "#326ce5" },
  "chart.yaml": { icon: <SettingOutlined />, color: "#0f1689" }, // helm navy
  "values.yaml": { icon: <FileTextOutlined />, color: "#0f9d6e" }, // teal: the config we tune
  "readme.md": { icon: <FileMarkdownOutlined />, color: "#2a78d6" },
};

export function fileIcon(name: string): React.ReactNode {
  const lower = name.toLowerCase();
  const spec =
    BY_NAME[lower] ??
    BY_EXT[lower.slice(lower.lastIndexOf(".") + 1)] ?? {
      icon: <FileOutlined />,
      color: "#8c8c8c",
    };
  return <span style={{ color: spec.color }}>{spec.icon}</span>;
}

export function folderIcon(open = false): React.ReactNode {
  return (
    <span style={{ color: "#d9a400" }}>
      {open ? <FolderOpenFilled /> : <FolderFilled />}
    </span>
  );
}

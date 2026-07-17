// VS Code-quality file icons for the explorer, from the vscode-icons set
// bundled through Iconify (offline, no network fetch). This replaces the
// tinted AntD glyphs in the Files workspace; other surfaces may keep the
// lightweight fileIcons module.
import { Icon } from "@iconify/react";
import type { IconifyIcon } from "@iconify/react";
import defaultFile from "@iconify-icons/vscode-icons/default-file";
import defaultFolder from "@iconify-icons/vscode-icons/default-folder";
import defaultFolderOpened from "@iconify-icons/vscode-icons/default-folder-opened";
import fileTypeYaml from "@iconify-icons/vscode-icons/file-type-yaml";
import fileTypeJson from "@iconify-icons/vscode-icons/file-type-json-official";
import fileTypeXml from "@iconify-icons/vscode-icons/file-type-xml";
import fileTypeToml from "@iconify-icons/vscode-icons/file-type-toml";
import fileTypeIni from "@iconify-icons/vscode-icons/file-type-ini";
import fileTypeConfig from "@iconify-icons/vscode-icons/file-type-config";
import fileTypeDotenv from "@iconify-icons/vscode-icons/file-type-dotenv";
import fileTypeMarkdown from "@iconify-icons/vscode-icons/file-type-markdown";
import fileTypeHtml from "@iconify-icons/vscode-icons/file-type-html";
import fileTypeShell from "@iconify-icons/vscode-icons/file-type-shell";
import fileTypeCert from "@iconify-icons/vscode-icons/file-type-cert";
import fileTypeKey from "@iconify-icons/vscode-icons/file-type-key";
import fileTypeGit from "@iconify-icons/vscode-icons/file-type-git";
import fileTypeLog from "@iconify-icons/vscode-icons/file-type-log";
import fileTypeText from "@iconify-icons/vscode-icons/file-type-text";
import fileTypeHelm from "@iconify-icons/vscode-icons/file-type-helm";
import folderTypeKubernetes from "@iconify-icons/vscode-icons/folder-type-kubernetes";

const BY_EXT: Record<string, IconifyIcon> = {
  yaml: fileTypeYaml,
  yml: fileTypeYaml,
  json: fileTypeJson,
  xml: fileTypeXml,
  toml: fileTypeToml,
  ini: fileTypeIni,
  conf: fileTypeConfig,
  cfg: fileTypeConfig,
  properties: fileTypeConfig,
  env: fileTypeDotenv,
  md: fileTypeMarkdown,
  html: fileTypeHtml,
  sh: fileTypeShell,
  bash: fileTypeShell,
  crt: fileTypeCert,
  pem: fileTypeCert,
  key: fileTypeKey,
  log: fileTypeLog,
  txt: fileTypeText,
};

// Well-known filenames get their own treatment (helm/kpt/kustomize/git).
const BY_NAME: Record<string, IconifyIcon> = {
  "chart.yaml": fileTypeHelm,
  "values.yaml": fileTypeHelm,
  "additional-values.yaml": fileTypeHelm,
  "kustomization.yaml": folderTypeKubernetes,
  "kustomization.yml": folderTypeKubernetes,
  kptfile: fileTypeConfig,
  ".gitignore": fileTypeGit,
  ".gitattributes": fileTypeGit,
};

export function vsFileIcon(name: string, size = 16): React.ReactNode {
  const lower = name.toLowerCase();
  const icon =
    BY_NAME[lower] ?? BY_EXT[lower.slice(lower.lastIndexOf(".") + 1)] ?? defaultFile;
  return <Icon icon={icon} width={size} height={size} style={{ flexShrink: 0 }} />;
}

export function vsFolderIcon(open = false, size = 16): React.ReactNode {
  return (
    <Icon
      icon={open ? defaultFolderOpened : defaultFolder}
      width={size}
      height={size}
      style={{ flexShrink: 0 }}
    />
  );
}

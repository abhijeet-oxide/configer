// The single icon registry. Every icon the app renders is defined HERE and
// nowhere else: change a mapping in this file and it changes everywhere.
// Components keep importing the familiar AntD names (SaveOutlined and so on)
// but from "./icons" instead of "@ant-design/icons"; each name is a thin
// wrapper around a Phosphor glyph (bundled offline via Iconify), which gives
// the whole product one mature, consistent icon language.
//
// The wrapper mimics AntD's icon DOM (span.anticon > svg, sized at 1em) so
// every existing AntD spacing rule (buttons, tags, menus, alerts) keeps
// working unchanged.
//
// File-type glyphs for the explorer live in components/vsIcons.tsx
// (vscode-icons set); this file covers UI icons only.
import { Icon } from "@iconify/react";
import type { IconifyIcon } from "@iconify/react";
import type { CSSProperties, MouseEventHandler } from "react";

import phTreeStructure from "@iconify-icons/ph/tree-structure";
import phPlugsConnected from "@iconify-icons/ph/plugs-connected";
import phSquaresFour from "@iconify-icons/ph/squares-four";
import phArrowLeft from "@iconify-icons/ph/arrow-left";
import phArrowRight from "@iconify-icons/ph/arrow-right";
import phArrowUp from "@iconify-icons/ph/arrow-up";
import phBell from "@iconify-icons/ph/bell";
import phGitBranch from "@iconify-icons/ph/git-branch";
import phCheckCircleFill from "@iconify-icons/ph/check-circle-fill";
import phCheckCircle from "@iconify-icons/ph/check-circle";
import phCheck from "@iconify-icons/ph/check";
import phCheckSquare from "@iconify-icons/ph/check-square";
import phXCircleFill from "@iconify-icons/ph/x-circle-fill";
import phXCircle from "@iconify-icons/ph/x-circle";
import phX from "@iconify-icons/ph/x";
import phCloudArrowDown from "@iconify-icons/ph/cloud-arrow-down";
import phHardDrives from "@iconify-icons/ph/hard-drives";
import phCloudCheck from "@iconify-icons/ph/cloud-check";
import phCloudArrowUp from "@iconify-icons/ph/cloud-arrow-up";
import phStack from "@iconify-icons/ph/stack";
import phCode from "@iconify-icons/ph/code";
import phCopy from "@iconify-icons/ph/copy";
import phDatabase from "@iconify-icons/ph/database";
import phTrash from "@iconify-icons/ph/trash";
import phGitDiff from "@iconify-icons/ph/git-diff";
import phPlugs from "@iconify-icons/ph/plugs";
import phCaretDoubleLeft from "@iconify-icons/ph/caret-double-left";
import phCaretDoubleRight from "@iconify-icons/ph/caret-double-right";
import phCaretDown from "@iconify-icons/ph/caret-down";
import phCaretLeft from "@iconify-icons/ph/caret-left";
import phCaretRight from "@iconify-icons/ph/caret-right";
import phCaretUp from "@iconify-icons/ph/caret-up";
import phDownloadSimple from "@iconify-icons/ph/download-simple";
import phPencilSimple from "@iconify-icons/ph/pencil-simple";
import phWarningCircleFill from "@iconify-icons/ph/warning-circle-fill";
import phWarningCircle from "@iconify-icons/ph/warning-circle";
import phArrowSquareOut from "@iconify-icons/ph/arrow-square-out";
import phEye from "@iconify-icons/ph/eye";
import phFilePlus from "@iconify-icons/ph/file-plus";
import phFile from "@iconify-icons/ph/file";
import phFileLock from "@iconify-icons/ph/file-lock";
import phFileMagnifyingGlass from "@iconify-icons/ph/file-magnifying-glass";
import phFileText from "@iconify-icons/ph/file-text";
import phFunnelFill from "@iconify-icons/ph/funnel-fill";
import phFolderPlus from "@iconify-icons/ph/folder-plus";
import phFolderFill from "@iconify-icons/ph/folder-fill";
import phFolderOpenFill from "@iconify-icons/ph/folder-open-fill";
import phFolderOpen from "@iconify-icons/ph/folder-open";
import phFolder from "@iconify-icons/ph/folder";
import phNotePencil from "@iconify-icons/ph/note-pencil";
import phArrowsIn from "@iconify-icons/ph/arrows-in";
import phArrowsOut from "@iconify-icons/ph/arrows-out";
import phGithubLogo from "@iconify-icons/ph/github-logo";
import phGlobe from "@iconify-icons/ph/globe";
import phHardDrive from "@iconify-icons/ph/hard-drive";
import phClockCounterClockwise from "@iconify-icons/ph/clock-counter-clockwise";
import phHouse from "@iconify-icons/ph/house";
import phFileHtml from "@iconify-icons/ph/file-html";
import phTray from "@iconify-icons/ph/tray";
import phInfoFill from "@iconify-icons/ph/info-fill";
import phInfo from "@iconify-icons/ph/info";
import phLink from "@iconify-icons/ph/link";
import phSpinner from "@iconify-icons/ph/spinner";
import phLock from "@iconify-icons/ph/lock";
import phMinusCircle from "@iconify-icons/ph/minus-circle";
import phDotsThreeVertical from "@iconify-icons/ph/dots-three-vertical";
import phGraph from "@iconify-icons/ph/graph";
import phPlusCircle from "@iconify-icons/ph/plus-circle";
import phPlus from "@iconify-icons/ph/plus";
import phGitPullRequest from "@iconify-icons/ph/git-pull-request";
import phQuestion from "@iconify-icons/ph/question";
import phArrowClockwise from "@iconify-icons/ph/arrow-clockwise";
import phArrowsClockwise from "@iconify-icons/ph/arrows-clockwise";
import phRocketLaunch from "@iconify-icons/ph/rocket-launch";
import phArrowUUpLeft from "@iconify-icons/ph/arrow-u-up-left";
import phFloppyDisk from "@iconify-icons/ph/floppy-disk";
import phMagnifyingGlass from "@iconify-icons/ph/magnifying-glass";
import phPaperPlaneTilt from "@iconify-icons/ph/paper-plane-tilt";
import phGear from "@iconify-icons/ph/gear";
import phStarFill from "@iconify-icons/ph/star-fill";
import phStar from "@iconify-icons/ph/star";
import phArrowsLeftRight from "@iconify-icons/ph/arrows-left-right";
import phTable from "@iconify-icons/ph/table";
import phLightning from "@iconify-icons/ph/lightning";
import phArrowCounterClockwise from "@iconify-icons/ph/arrow-counter-clockwise";
import phUser from "@iconify-icons/ph/user";
import phWarningFill from "@iconify-icons/ph/warning-fill";
import phSun from "@iconify-icons/ph/sun";
import phMoon from "@iconify-icons/ph/moon";
import phMonitor from "@iconify-icons/ph/monitor";
import phSignOut from "@iconify-icons/ph/sign-out";
import phUsersThree from "@iconify-icons/ph/users-three";
import phSparkle from "@iconify-icons/ph/sparkle";
import phGlobeHemisphereWest from "@iconify-icons/ph/globe-hemisphere-west";
import phMapPin from "@iconify-icons/ph/map-pin";

export interface AppIconProps {
  className?: string;
  style?: CSSProperties;
  onClick?: MouseEventHandler<HTMLSpanElement>;
  /** rotate continuously (LoadingOutlined spins by default) */
  spin?: boolean;
  title?: string;
}

function make(slug: string, icon: IconifyIcon, spinDefault = false) {
  function AppIcon({ className, style, onClick, spin = spinDefault, title }: AppIconProps) {
    const cls =
      `anticon anticon-${slug}` +
      (spin ? " icon-spin" : "") +
      (className ? ` ${className}` : "");
    return (
      <span role="img" aria-label={slug} title={title} onClick={onClick} className={cls} style={style}>
        <Icon icon={icon} />
      </span>
    );
  }
  AppIcon.displayName = slug;
  return AppIcon;
}

// devicon:swagger - the Swagger brand logo, kept in its own colors (the two
// path fills are explicit, so it reads as the logo, not a monochrome glyph).
const devSwagger: IconifyIcon = {
  width: 128,
  height: 128,
  body:
    `<path fill="#85ea2d" d="M63.999 124.945c-33.607 0-60.95-27.34-60.95-60.949C3.05 30.388 30.392 3.048 64 3.048s60.95 27.342 60.95 60.95c0 33.607-27.343 60.946-60.95 60.946z"/><path fill="#173647" d="M40.3 43.311c-.198 2.19.072 4.454-.073 6.668c-.173 2.217-.444 4.407-.888 6.596c-.615 3.126-2.56 5.489-5.24 7.458c5.218 3.396 5.807 8.662 6.152 14.003c.172 2.88.098 5.785.394 8.638c.221 2.215 1.082 2.782 3.372 2.854c.935.025 1.894 0 2.978 0v6.842c-6.768 1.156-12.354-.762-13.734-6.496a39.3 39.3 0 0 1-.836-6.4c-.148-2.287.097-4.577-.074-6.864c-.492-6.277-1.305-8.393-7.308-8.689v-7.8c.441-.1.86-.174 1.302-.223c3.298-.172 4.701-1.182 5.414-4.43a37.5 37.5 0 0 0 .616-5.536c.247-3.569.148-7.21.763-10.754c.86-5.094 4.01-7.556 9.254-7.852c1.476-.074 2.978 0 4.676 0v6.99c-.714.05-1.33.147-1.969.147c-4.258-.148-4.48 1.304-4.8 4.848zm8.195 16.193h-.099c-2.462-.123-4.578 1.796-4.702 4.258c-.122 2.485 1.797 4.603 4.259 4.724h.295c2.436.148 4.527-1.724 4.676-4.16v-.245c.05-2.486-1.944-4.527-4.43-4.577zm15.43 0c-2.386-.074-4.38 1.796-4.454 4.159c0 .149 0 .271.024.418c0 2.684 1.821 4.406 4.578 4.406c2.707 0 4.406-1.772 4.406-4.553c-.025-2.682-1.823-4.455-4.554-4.43m15.801 0a4.596 4.596 0 0 0-4.676 4.454a4.515 4.515 0 0 0 4.528 4.528h.05c2.264.394 4.553-1.796 4.701-4.429c.122-2.437-2.092-4.553-4.604-4.553Zm21.682.369c-2.855-.123-4.284-1.083-4.996-3.79a27.4 27.4 0 0 1-.811-5.292c-.198-3.298-.174-6.62-.395-9.918c-.516-7.826-6.177-10.557-14.397-9.205v6.792c1.304 0 2.313 0 3.322.025c1.748.024 3.077.69 3.249 2.634c.172 1.772.172 3.568.344 5.365c.346 3.57.542 7.187 1.157 10.706c.542 2.904 2.536 5.07 5.02 6.841c-4.355 2.929-5.636 7.113-5.857 11.814c-.122 3.223-.196 6.472-.368 9.721c-.148 2.953-1.181 3.913-4.16 3.987c-.835.024-1.648.098-2.583.148v6.964c1.748 0 3.347.1 4.946 0c4.971-.295 7.974-2.706 8.96-7.531c.417-2.658.662-5.34.737-8.023c.171-2.46.148-4.946.394-7.382c.369-3.815 2.116-5.389 5.93-5.636a5 5 0 0 0 1.06-.245v-7.801c-.64-.074-1.084-.148-1.552-.173zM64 6.1c31.977 0 57.9 25.92 57.9 57.898c0 31.977-25.923 57.899-57.9 57.899c-31.976 0-57.898-25.922-57.898-57.9C6.102 32.023 32.024 6.101 64 6.101m0-6.1C28.71 0 0 28.71 0 64c0 35.288 28.71 63.998 64 63.998s64-28.71 64-64S99.289.002 64 .002Z"/>`,
};
export const SwaggerOutlined = make("swagger", devSwagger);

// Navigation and structure
export const HomeOutlined = make("home", phHouse);
export const AppstoreOutlined = make("appstore", phSquaresFour);
export const ApartmentOutlined = make("apartment", phTreeStructure);
export const PartitionOutlined = make("partition", phGraph);
export const ClusterOutlined = make("cluster", phStack);
export const TableOutlined = make("table", phTable);
export const InboxOutlined = make("inbox", phTray);
export const GlobalOutlined = make("global", phGlobe);
// Scope glyphs: a filled hemisphere globe for global (shared everywhere) and
// a map pin for instance (a specific deployment target).
export const ScopeGlobalOutlined = make("scope-global", phGlobeHemisphereWest);
export const ScopeInstanceOutlined = make("scope-instance", phMapPin);
export const SettingOutlined = make("setting", phGear);
export const SunOutlined = make("sun", phSun);
export const MoonOutlined = make("moon", phMoon);
export const DesktopOutlined = make("desktop", phMonitor);
export const UserOutlined = make("user", phUser);
export const TeamOutlined = make("team", phUsersThree);
export const LogoutOutlined = make("logout", phSignOut);
export const SparkleOutlined = make("sparkle", phSparkle);
export const BellOutlined = make("bell", phBell);

// Chevrons and arrows
export const LeftOutlined = make("left", phCaretLeft);
export const RightOutlined = make("right", phCaretRight);
export const UpOutlined = make("up", phCaretUp);
export const DownOutlined = make("down", phCaretDown);
export const DoubleLeftOutlined = make("double-left", phCaretDoubleLeft);
export const DoubleRightOutlined = make("double-right", phCaretDoubleRight);
export const ArrowLeftOutlined = make("arrow-left", phArrowLeft);
export const ArrowRightOutlined = make("arrow-right", phArrowRight);
export const ArrowUpOutlined = make("arrow-up", phArrowUp);
export const SwapOutlined = make("swap", phArrowsLeftRight);
export const FullscreenOutlined = make("fullscreen", phArrowsOut);
export const FullscreenExitOutlined = make("fullscreen-exit", phArrowsIn);
export const ExportOutlined = make("export", phArrowSquareOut);

// Status
export const CheckOutlined = make("check", phCheck);
export const CheckCircleOutlined = make("check-circle", phCheckCircle);
export const CheckCircleFilled = make("check-circle-fill", phCheckCircleFill);
export const CheckSquareOutlined = make("check-square", phCheckSquare);
export const CloseOutlined = make("close", phX);
export const CloseCircleOutlined = make("close-circle", phXCircle);
export const CloseCircleFilled = make("close-circle-fill", phXCircleFill);
export const ExclamationCircleOutlined = make("exclamation-circle", phWarningCircle);
export const ExclamationCircleFilled = make("exclamation-circle-fill", phWarningCircleFill);
export const WarningFilled = make("warning-fill", phWarningFill);
export const InfoCircleOutlined = make("info-circle", phInfo);
export const InfoCircleFilled = make("info-circle-fill", phInfoFill);
export const QuestionCircleOutlined = make("question-circle", phQuestion);
export const LoadingOutlined = make("loading", phSpinner, true);
export const ThunderboltOutlined = make("thunderbolt", phLightning);
export const RocketOutlined = make("rocket", phRocketLaunch);
export const StarOutlined = make("star", phStar);
export const StarFilled = make("star-fill", phStarFill);
export const EyeOutlined = make("eye", phEye);
export const LockOutlined = make("lock", phLock);

// Editing and actions
export const EditOutlined = make("edit", phPencilSimple);
export const FormOutlined = make("form", phNotePencil);
export const SaveOutlined = make("save", phFloppyDisk);
export const DeleteOutlined = make("delete", phTrash);
export const CopyOutlined = make("copy", phCopy);
export const PlusOutlined = make("plus", phPlus);
export const PlusCircleOutlined = make("plus-circle", phPlusCircle);
export const MinusCircleOutlined = make("minus-circle", phMinusCircle);
export const SearchOutlined = make("search", phMagnifyingGlass);
export const FilterFilled = make("filter-fill", phFunnelFill);
export const MoreOutlined = make("more", phDotsThreeVertical);
export const SendOutlined = make("send", phPaperPlaneTilt);
export const UndoOutlined = make("undo", phArrowCounterClockwise);
export const RollbackOutlined = make("rollback", phArrowUUpLeft);
export const ReloadOutlined = make("reload", phArrowClockwise);
export const SyncOutlined = make("sync", phArrowsClockwise);
export const DownloadOutlined = make("download", phDownloadSimple);
export const LinkOutlined = make("link", phLink);

// Files and folders
export const FileOutlined = make("file", phFile);
export const FileTextOutlined = make("file-text", phFileText);
export const FileAddOutlined = make("file-add", phFilePlus);
export const FileSearchOutlined = make("file-search", phFileMagnifyingGlass);
export const FileProtectOutlined = make("file-protect", phFileLock);
export const FileMarkdownOutlined = make("file-markdown", phFileText);
export const Html5Outlined = make("file-html", phFileHtml);
export const FolderOutlined = make("folder", phFolder);
export const FolderOpenOutlined = make("folder-open", phFolderOpen);
export const FolderFilled = make("folder-fill", phFolderFill);
export const FolderOpenFilled = make("folder-open-fill", phFolderOpenFill);
export const FolderAddOutlined = make("folder-add", phFolderPlus);

// Git, repo and infrastructure
export const BranchesOutlined = make("branches", phGitBranch);
export const PullRequestOutlined = make("pull-request", phGitPullRequest);
export const DiffOutlined = make("diff", phGitDiff);
export const GithubOutlined = make("github", phGithubLogo);
export const HistoryOutlined = make("history", phClockCounterClockwise);
export const CodeOutlined = make("code", phCode);
export const DatabaseOutlined = make("database", phDatabase);
export const HddOutlined = make("hdd", phHardDrive);
export const CloudServerOutlined = make("cloud-server", phHardDrives);
export const CloudSyncOutlined = make("cloud-sync", phCloudCheck);
export const CloudDownloadOutlined = make("cloud-download", phCloudArrowDown);
export const CloudUploadOutlined = make("cloud-upload", phCloudArrowUp);
export const ApiOutlined = make("api", phPlugsConnected);
export const DisconnectOutlined = make("disconnect", phPlugs);

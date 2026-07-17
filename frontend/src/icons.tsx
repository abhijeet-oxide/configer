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
export const UserOutlined = make("user", phUser);
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

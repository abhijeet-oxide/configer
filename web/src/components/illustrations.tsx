// The state illustrations moved into the shared design system, where both
// tools get the same drawing for the same situation - a service that will not
// answer looks the same whichever product you are looking at. Re-exported from
// their old path so the existing import sites did not all have to change.
export {
  SuccessArt,
  ScanArt,
  EmptyArt,
  AllClearArt,
  InboxZeroArt,
  InSyncArt,
  OfflineArt,
  WorkspaceArt,
  SignedOutArt,
  SessionExpiredArt,
  ServiceDownArt,
  AccessDeniedArt,
  NotFoundArt,
  StatePanel,
} from "../uikit";

// The product design layer above Ant Design: every custom surface composes
// these pieces so the whole app shares one visual grammar.
//
// Most of them now come from `uikit/` - the design system this tool shares
// byte for byte with every other tool on the platform (see uikit/README.md).
// They kept their names and their props, so this file is still the one import
// a component reaches for, and nothing downstream had to change.
//
// What is still LOCAL is what is Configer's own vocabulary: a value and its
// difference, and the chips that say which application you are looking at.
// Those are not design-system pieces, they are this product's nouns, and
// pushing them into the shared folder would be how the shared folder starts
// naming a product.
export {
  StatusPill,
  ChangeChip,
  StatTile,
  PageHeader,
  SectionCard,
  AttentionCard,
  Toolbar,
  EmptyState,
  InlineNotice,
  LoadingStage,
  Stepper,
  Kbd,
  FadeIn,
  Stagger,
  StaggerItem,
} from "../../uikit";
export type {
  PillTone,
  ChangeKind,
  AttentionSeverity,
  NoticeTone,
  StepDef,
} from "../../uikit";

export { default as AppContextChips, MonoChip } from "./AppContextChips";
export { default as ValueDiff, InlineValueDiff } from "./ValueDiff";

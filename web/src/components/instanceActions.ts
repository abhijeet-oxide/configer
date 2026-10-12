import type { ReactNode } from "react";

// What can be DONE to an instance, as data.
//
// There are four surfaces that show an estate - the table, the topology, the
// map, and the dossier all three of them open - and every one of them used to
// answer "what can I do with this?" differently. The table had six icon-only
// buttons in a row and no labels; the topology's dialog had exactly one action
// on it ("Open configuration"), so clicking a node on the map and clicking the
// same instance in the table led to two different products.
//
// So the actions are a LIST, built once where the mutations and dialogs live,
// and handed to whatever is drawing an instance. A surface decides how much
// room it has; it never decides what the actions are.
export interface InstanceAction {
  key: string;
  /** the words on the button, or in the menu. Always present - an icon-only
   *  row of six is a quiz, and "which one was the archive icon" is not a
   *  question anybody should have to answer twice. */
  label: string;
  icon: ReactNode;
  /** what it does, in a sentence, for the tooltip */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  loading?: boolean;
  /** PRIMARY actions get their own button; everything else folds into the
   *  three-dot menu beside them. The split is by how often it is reached, not
   *  by how important it is: comparing and correcting the metadata are the
   *  everyday errands, and cloning, copying, archiving and retiring are the
   *  ones somebody goes looking for. */
  primary?: boolean;
  /** a destructive or surprising action asks first */
  confirm?: { title: string; description: string; okText: string };
  run: () => void;
}

/** The everyday ones, in the order they are drawn. */
export const primaryActions = (all: InstanceAction[]): InstanceAction[] => all.filter((a) => a.primary);

/** Everything behind the three dots, in the order they are drawn. */
export const overflowActions = (all: InstanceAction[]): InstanceAction[] => all.filter((a) => !a.primary);

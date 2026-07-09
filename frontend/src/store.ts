import { create } from "zustand";
import type { BrandKey, Mode } from "./theme";

// UI state: theme, the active top-nav section, category filter, the selected
// parameter (drives the details panel), and the two instances being compared.
interface UIState {
  mode: Mode;
  brand: BrandKey;
  section: string;
  categoryKey: string | null;
  selectedParamId: string | null;
  compareLeft: string | null;
  compareRight: string | null;
  setMode: (m: Mode) => void;
  setBrand: (b: BrandKey) => void;
  setSection: (s: string) => void;
  setCategory: (k: string | null) => void;
  selectParam: (id: string | null) => void;
  setCompare: (left: string | null, right: string | null) => void;
}

export const useUI = create<UIState>((set) => ({
  mode: (localStorage.getItem("configer.mode") as Mode) || "light",
  brand: (localStorage.getItem("configer.brand") as BrandKey) || "configer",
  section: "config",
  categoryKey: null,
  selectedParamId: null,
  compareLeft: null,
  compareRight: null,
  setMode: (mode) => {
    localStorage.setItem("configer.mode", mode);
    set({ mode });
  },
  setBrand: (brand) => {
    localStorage.setItem("configer.brand", brand);
    set({ brand });
  },
  setSection: (section) => set({ section }),
  setCategory: (categoryKey) => set({ categoryKey }),
  selectParam: (selectedParamId) => set({ selectedParamId }),
  setCompare: (compareLeft, compareRight) => set({ compareLeft, compareRight }),
}));

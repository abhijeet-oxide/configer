import { useQueryClient } from "@tanstack/react-query";
import { useUI } from "./store";

// Switching the active repository re-points the API client and drops every
// cached query, so all views load fresh from the newly selected
// configuration; nothing from the previous repository can bleed through.
export function useSwitchRepo() {
  const qc = useQueryClient();
  const setRepo = useUI((s) => s.setRepo);
  return (id: string | null) => {
    setRepo(id);
    qc.clear();
  };
}

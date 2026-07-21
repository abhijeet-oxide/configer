import NewApplicationWizard from "./NewApplicationWizard";
import { STEP_HANDOFF } from "./ImportWizard";
import { useUI } from "../store";
import { useSwitchRepo } from "../useSwitchRepo";

// GlobalNewApplication mounts the New Application wizard once, driven by the
// deep-linkable store flag (?new=1), so it can be opened from anywhere - the
// command palette, a shared link - not only from a page button. On success it
// hands off to the new repository's scan step, matching the page-level flows.
export default function GlobalNewApplication() {
  const { newAppOpen, closeNewApp, setSection } = useUI();
  const switchRepo = useSwitchRepo();
  return (
    <NewApplicationWizard
      open={newAppOpen}
      onClose={closeNewApp}
      onCreated={(r) => {
        closeNewApp();
        sessionStorage.setItem(STEP_HANDOFF, "1");
        switchRepo(r.id);
        setSection("import");
      }}
    />
  );
}

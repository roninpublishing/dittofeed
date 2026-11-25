import axios from "axios";
import { useRouter } from "next/router";
import { enqueueSnackbar } from "notistack";
import { useCallback, useRef, useState } from "react";

import { useAppStorePick } from "./appStore";

export default function useWorkspaceSwitch() {
  const { apiBase, authMode } = useAppStorePick(["apiBase", "authMode"]);
  const router = useRouter();
  const pending = useRef(false);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const switchWorkspace = useCallback(
    async (workspaceId: string, destination = "/home"): Promise<boolean> => {
      if (pending.current) return false;
      pending.current = true;
      setSwitchingWorkspace(true);
      try {
        if (authMode === "google") {
          await axios.post(`${apiBase}/api/account/workspace`, { workspaceId });
        } else if (authMode === "single-tenant" || authMode === "anonymous") {
          await axios.post(`${apiBase}/api/public/single-tenant/workspace`, {
            workspaceId,
          });
        } else {
          const query = new URLSearchParams({
            workspaceId,
            redirectTo: destination,
          });
          window.location.assign(
            `${router.basePath}/select-workspace?${query}`,
          );
          return true;
        }
        window.location.assign(`${router.basePath}${destination}`);
        return true;
      } catch {
        pending.current = false;
        setSwitchingWorkspace(false);
        enqueueSnackbar("Unable to switch workspace.", { variant: "error" });
        return false;
      }
    },
    [apiBase, authMode, router.basePath],
  );
  return { switchWorkspace, switchingWorkspace };
}

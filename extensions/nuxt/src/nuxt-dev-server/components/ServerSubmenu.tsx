/**
 * Server submenu component for displaying a single Nuxt server with actions
 */

import { MenuBarExtra, Icon } from "@raycast/api";
import type { NuxtProcess } from "../utils/process";
import {
  handleOpenBrowser,
  handleStopServer,
  handleOpenRepository,
} from "../utils/actions";

interface ServerSubmenuProps {
  process: NuxtProcess;
  projectName: string;
  revalidate: () => void;
}

export function ServerSubmenu({ process, projectName, revalidate }: ServerSubmenuProps) {
  const { port, pid, projectInfo, memory, cpu } = process;

  return (
    <MenuBarExtra.Submenu title={projectName} icon={Icon.Box}>
      {/* Project Information */}
      <MenuBarExtra.Item title={`Port: ${port}`} icon={Icon.Network} />

      {projectInfo?.version && <MenuBarExtra.Item title={`Version: ${projectInfo.version}`} icon={Icon.Tag} />}

      {memory && <MenuBarExtra.Item title={`Memory: ${memory}`} icon={Icon.MemoryChip} />}

      {cpu && <MenuBarExtra.Item title={`CPU: ${cpu}`} icon={Icon.Gauge} />}

      <MenuBarExtra.Separator />

      {/* Quick Actions */}
      <MenuBarExtra.Item title="Open in Browser" icon={Icon.Globe} onAction={() => handleOpenBrowser(port)} />

      {projectInfo?.repository && (
        <MenuBarExtra.Item
          title="Open GitHub Repo"
          icon={Icon.Link}
          onAction={() => handleOpenRepository(projectInfo.repository!)}
        />
      )}

      <MenuBarExtra.Separator />

      {/* Stop Server */}
      <MenuBarExtra.Item
        title={`Stop Server (PID: ${pid})`}
        icon={Icon.Stop}
        onAction={() => handleStopServer(pid, revalidate)}
      />
    </MenuBarExtra.Submenu>
  );
}

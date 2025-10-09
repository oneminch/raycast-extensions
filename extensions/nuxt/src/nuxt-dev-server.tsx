import {
  MenuBarExtra,
  Icon,
  open,
  showToast,
  Toast,
  launchCommand,
  LaunchType,
  openExtensionPreferences,
} from "@raycast/api";
import { useExec } from "@raycast/utils";
import { useMemo, useEffect, useState } from "react";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

interface ProjectInfo {
  name?: string;
  version?: string;
  repository?: string;
}

interface NuxtProcess {
  pid: string;
  port: string;
  command: string;
  cwd?: string;
  projectInfo?: ProjectInfo;
  memory?: string;
  cpu?: string;
}

function getProjectInfo(pid: string, command: string): { cwd?: string; projectInfo?: ProjectInfo; memory?: string; cpu?: string } {
  const { execSync } = require("child_process");

  try {
    // Try to extract project path from the command line
    // Command usually contains something like: node /path/to/project/.nuxt/dev/index.mjs
    let cwd: string | undefined;

    // Look for common Nuxt patterns in the command
    const nuxtPatterns = [
      /node\s+([^\s]+)\/node_modules\/.*?nuxt.*?\s+dev/,  // node /path/node_modules/.../nuxt.mjs dev
      /node\s+([^\s]+\/)\.nuxt\/dev/,                     // node /path/.nuxt/dev
      /npx\s+nuxi.*?\s+-C\s+([^\s]+)/,                    // npx nuxi -C /path
      /npm\s+run\s+dev.*?--prefix\s+([^\s]+)/,           // npm run dev --prefix /path
    ];

    for (const pattern of nuxtPatterns) {
      const match = command.match(pattern);
      if (match && match[1]) {
        cwd = match[1];
        // Clean up the path
        cwd = cwd.replace(/\/$/, ""); // Remove trailing slash
        break;
      }
    }

    // If we couldn't extract from command, try lsof as fallback (might work in some cases)
    if (!cwd) {
      try {
        const lsofOutput = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, { encoding: "utf8", timeout: 1000 }).trim();
        const lines = lsofOutput.split("\n");
        for (const line of lines) {
          if (line.startsWith("n")) {
            cwd = line.substring(1);
            break;
          }
        }
      } catch (e) {
        // lsof failed, that's ok
      }
    }

    if (!cwd) {
      return {};
    }

    // Read package.json
    const packageJsonPath = join(cwd, "package.json");
    let projectInfo: ProjectInfo | undefined;

    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        projectInfo = {
          name: packageJson.name,
          version: packageJson.version,
          repository: packageJson.repository?.url || packageJson.repository,
        };
      } catch (e) {
        // Ignore package.json parse errors
      }
    }

    // If no repository in package.json, try to get it from .git/config
    if (projectInfo && !projectInfo.repository) {
      const gitConfigPath = join(cwd, ".git", "config");
      if (existsSync(gitConfigPath)) {
        try {
          const gitConfig = readFileSync(gitConfigPath, "utf8");
          // Look for [remote "origin"] url = ...
          const urlMatch = gitConfig.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(.+)/);
          if (urlMatch && urlMatch[1]) {
            projectInfo.repository = urlMatch[1].trim();
          }
        } catch (e) {
          // Ignore git config parse errors
        }
      }
    }

    // Get memory and CPU usage
    let memory: string | undefined;
    let cpu: string | undefined;

    try {
      const psOutput = execSync(`ps -p ${pid} -o rss=,pcpu= 2>/dev/null`, { encoding: "utf8" }).trim();
      if (psOutput) {
        const parts = psOutput.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
          const memoryKB = parseInt(parts[0], 10);
          const memoryMB = Math.round(memoryKB / 1024);
          const cpuPercent = parseFloat(parts[1]);

          memory = `${memoryMB} MB`;
          cpu = `${cpuPercent.toFixed(1)}%`;
        }
      }
    } catch (e) {
      // Memory/CPU optional
    }

    return { cwd, projectInfo, memory, cpu };
  } catch (error) {
    return {};
  }
}

export default function Command() {
  const [processDetails, setProcessDetails] = useState<Map<string, ReturnType<typeof getProjectInfo>>>(new Map());

  // Check for Node processes listening on common Nuxt ports
  const { data: lsofData, isLoading: lsofLoading, revalidate: lsofRevalidate } = useExec("sh", [
    "-c",
    `lsof -i :3000-3010 -sTCP:LISTEN -n -P 2>/dev/null | grep -i node | awk '{print $2, $9}' || echo ""`,
  ]);

  // Also check for nuxt/nuxi processes
  const { data: psData } = useExec("sh", [
    "-c",
    'ps aux | grep -i "node.*nuxt\\|nuxi\\|nitro" | grep -v grep | grep -v "menu-bar" || echo ""',
  ]);

  const nuxtProcesses = useMemo(() => {
    const processes: NuxtProcess[] = [];

    if (!lsofData || lsofData.trim() === "") {
      return processes;
    }

    // Parse lsof output: PID PORT
    // Example: "12345 localhost:3000"
    const lsofLines = lsofData.trim().split("\n").filter(l => l.trim());

    for (const line of lsofLines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;

      const pid = parts[0];
      const address = parts[1];

      // Extract port from address (format: *:3000 or localhost:3000)
      const portMatch = address.match(/:(\d+)/);
      if (!portMatch) continue;

      const port = portMatch[1];

      // Verify this is a Nuxt process by checking ps data
      let isNuxt = false;
      let command = `Node.js server on port ${port}`;

      if (psData) {
        const psLines = psData.split("\n");
        for (const psLine of psLines) {
          if (psLine.includes(pid)) {
            // Check if it's actually a Nuxt process
            const lowerLine = psLine.toLowerCase();
            if (lowerLine.includes("nuxt") || lowerLine.includes("nuxi") || lowerLine.includes("nitro")) {
              isNuxt = true;
              command = psLine.split(/\s+/).slice(10).join(" ");
              break;
            }
          }
        }
      } else {
        // If we don't have ps data, assume any node process on 3000-3010 could be Nuxt
        isNuxt = true;
      }

      if (isNuxt) {
        processes.push({
          pid,
          port,
          command,
          // Details will be filled by useEffect
          cwd: undefined,
          projectInfo: undefined,
          memory: undefined,
          cpu: undefined,
        });
      }
    }

    return processes;
  }, [lsofData, psData]);

  // Fetch project info for new processes
  useEffect(() => {
    if (nuxtProcesses.length === 0) {
      if (processDetails.size > 0) {
        setProcessDetails(new Map());
      }
      return;
    }

    const activePids = new Set(nuxtProcesses.map(p => p.pid));
    let needsUpdate = false;

    // Check if we need to update (new processes or removed processes)
    for (const process of nuxtProcesses) {
      if (!processDetails.has(process.pid)) {
        needsUpdate = true;
        break;
      }
    }

    for (const pid of processDetails.keys()) {
      if (!activePids.has(pid)) {
        needsUpdate = true;
        break;
      }
    }

    if (!needsUpdate) {
      return;
    }

    const newDetails = new Map<string, ReturnType<typeof getProjectInfo>>();

    // Keep existing details for active processes
    for (const [pid, details] of processDetails.entries()) {
      if (activePids.has(pid)) {
        newDetails.set(pid, details);
      }
    }

    // Fetch info for new processes only
    for (const process of nuxtProcesses) {
      if (!newDetails.has(process.pid)) {
        const info = getProjectInfo(process.pid, process.command);
        newDetails.set(process.pid, info);
      }
    }

    setProcessDetails(newDetails);
  }, [nuxtProcesses.map(p => p.pid).join(","), processDetails.size]);

  const isLoading = lsofLoading;
  const revalidate = () => {
    lsofRevalidate();
  };

  const hasNuxtRunning = nuxtProcesses.length > 0;

  // Get unique ports
  const ports = useMemo(() => {
    const uniquePorts = new Set(nuxtProcesses.map((p) => p.port));
    return Array.from(uniquePorts);
  }, [nuxtProcesses]);

  const icon = { source: "icon.png" }
  const title = hasNuxtRunning ? `${nuxtProcesses.length}` : undefined;

  const handleOpenBrowser = async (port: string) => {
    try {
      await open(`http://localhost:${port}`);
      await showToast({
        style: Toast.Style.Success,
        title: `Opening localhost:${port}`,
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to open browser",
        message: String(error),
      });
    }
  };

  const handleKillProcess = async (pid: string) => {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: "Stopping Nuxt server...",
      });

      // Use kill command to stop the process
      const { execSync } = require("child_process");
      execSync(`kill -9 ${pid}`);

      await showToast({
        style: Toast.Style.Success,
        title: "Server stopped",
      });

      // Refresh the process list
      revalidate();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to stop server",
        message: String(error),
      });
    }
  };


  return (
    <MenuBarExtra icon={icon} title={title} isLoading={isLoading} tooltip="Nuxt Dev Server Monitor">
      {hasNuxtRunning ? (
        <>
          <MenuBarExtra.Section title="Running Servers">
            {ports.map((port) => {
              const processesOnPort = nuxtProcesses.filter((p) => p.port === port);
              const mainProcess = processesOnPort[0];
              const details = mainProcess ? processDetails.get(mainProcess.pid) : undefined;
              const projectName = details?.projectInfo?.name || `Port ${port}`;

              return (
                <MenuBarExtra.Submenu key={port} title={projectName} icon={Icon.Box}>
                  {/* Always show port */}
                  <MenuBarExtra.Item
                    title={`Port: ${port}`}
                    icon={Icon.Network}
                  />

                  {/* Show version if available */}
                  {details?.projectInfo?.version && (
                    <MenuBarExtra.Item
                      title={`Version: ${details.projectInfo.version}`}
                      icon={Icon.Tag}
                    />
                  )}

                  {/* Show memory if available */}
                  {details?.memory && (
                    <MenuBarExtra.Item
                      title={`Memory: ${details.memory}`}
                      icon={Icon.MemoryChip}
                    />
                  )}

                  {/* Show CPU if available */}
                  {details?.cpu && (
                    <MenuBarExtra.Item
                      title={`CPU: ${details.cpu}`}
                      icon={Icon.Gauge}
                    />
                  )}

                  <MenuBarExtra.Separator />

                  <MenuBarExtra.Item
                    title="Open in Browser"
                    icon={Icon.Globe}
                    onAction={() => handleOpenBrowser(port)}
                  />

                  {details?.projectInfo?.repository && (
                    <MenuBarExtra.Item
                      title="Open GitHub Repo"
                      icon={Icon.Link}
                      onAction={async () => {
                        try {
                          // Clean up git URL to https URL
                          let repoUrl = details.projectInfo!.repository!;
                          if (repoUrl.startsWith("git+")) {
                            repoUrl = repoUrl.substring(4);
                          }
                          if (repoUrl.startsWith("git@")) {
                            repoUrl = repoUrl.replace("git@github.com:", "https://github.com/");
                          }
                          repoUrl = repoUrl.replace(/\.git$/, "");

                          await open(repoUrl);
                        } catch (error) {
                          await showToast({
                            style: Toast.Style.Failure,
                            title: "Failed to open repository",
                            message: String(error),
                          });
                        }
                      }}
                    />
                  )}

                  <MenuBarExtra.Separator />

                  {processesOnPort.map((process) => (
                    <MenuBarExtra.Item
                      key={process.pid}
                      title={`Stop Server (PID: ${process.pid})`}
                      icon={Icon.Stop}
                      onAction={() => handleKillProcess(process.pid)}
                    />
                  ))}
                </MenuBarExtra.Submenu>
              );
            })}
          </MenuBarExtra.Section>

          <MenuBarExtra.Section>
            <MenuBarExtra.Item
              title="Refresh"
              icon={Icon.ArrowClockwise}
              shortcut={{ modifiers: ["cmd"], key: "r" }}
              onAction={revalidate}
            />
          </MenuBarExtra.Section>
        </>
      ) : (
        <>
          <MenuBarExtra.Section>
            <MenuBarExtra.Item title="No Nuxt servers detected" icon={Icon.ExclamationMark} />
          </MenuBarExtra.Section>
          <MenuBarExtra.Section>
            <MenuBarExtra.Item title="Start your dev server on ports 3000-3010" />
          </MenuBarExtra.Section>
          <MenuBarExtra.Section>
            <MenuBarExtra.Item
              title="Refresh"
              icon={Icon.ArrowClockwise}
              shortcut={{ modifiers: ["cmd"], key: "r" }}
              onAction={revalidate}
            />
          </MenuBarExtra.Section>
        </>
      )}

      <MenuBarExtra.Section title="Documentation">
        <MenuBarExtra.Item
          title="Search Nuxt Docs"
          icon={Icon.Book}
          onAction={async () => {
            try {
              await launchCommand({ name: "search-nuxt-docs", type: LaunchType.UserInitiated });
            } catch (error) {
              await showToast({
                style: Toast.Style.Failure,
                title: "Failed to open command",
                message: String(error),
              });
            }
          }}
        />
        <MenuBarExtra.Item
          title="Search Components"
          icon={Icon.Box}
          onAction={async () => {
            try {
              await launchCommand({ name: "search-components", type: LaunchType.UserInitiated });
            } catch (error) {
              await showToast({
                style: Toast.Style.Failure,
                title: "Failed to open command",
                message: String(error),
              });
            }
          }}
        />
        <MenuBarExtra.Item
          title="Search Modules"
          icon={Icon.Plug}
          onAction={async () => {
            try {
              await launchCommand({ name: "search-modules", type: LaunchType.UserInitiated });
            } catch (error) {
              await showToast({
                style: Toast.Style.Failure,
                title: "Failed to open command",
                message: String(error),
              });
            }
          }}
        />
      </MenuBarExtra.Section>

      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          title="Preferences..."
          icon={Icon.Gear}
          shortcut={{ modifiers: ["cmd"], key: "," }}
          onAction={openExtensionPreferences}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}

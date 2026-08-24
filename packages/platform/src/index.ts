/**
 * Cross-platform adapters: config paths, service install templates, process
 * helpers. Core code never contains launchd/osascript/PowerShell specifics —
 * they live here, behind small typed functions that are unit-testable on any
 * OS (paths and templates are pure functions).
 */

export type Os = 'darwin' | 'win32' | 'linux'

export function currentOs(): Os {
  switch (process.platform) {
    case 'darwin':
      return 'darwin'
    case 'win32':
      return 'win32'
    default:
      return 'linux'
  }
}

/** Per-OS config/home paths for the node agent. */
export function configPaths(os: Os, home: string): { dir: string; nodeFile: string; storeFile: string; logDir: string } {
  if (os === 'win32') {
    const base = process.env['LOCALAPPDATA'] ?? `${home}\\AppData\\Local`
    return {
      dir: `${base}\\dsh-helm`,
      nodeFile: `${base}\\dsh-helm\\node.json`,
      storeFile: `${base}\\dsh-helm\\store.sqlite3`,
      logDir: `${base}\\dsh-helm\\logs`,
    }
  }
  return {
    dir: `${home}/.dsh/helm`,
    nodeFile: `${home}/.dsh/helm/node.json`,
    storeFile: `${home}/.dsh/helm/store.sqlite3`,
    logDir: `${home}/.dsh/helm/logs`,
  }
}

/** Default hub mesh + MCP ports (3470/3471), aligned with protocol constants. */
export const DEFAULT_PORTS = { mesh: 3470, mcp: 3471, presence: 3472 } as const

// ---- service templates ----

export interface ServiceTemplate {
  /** Install this service (returns the command/action to run). */
  install: string
  uninstall: string
  status: string
  start: string
  stop: string
  /** Human-readable service id. */
  id: string
}

/** macOS launchd agent plist for the node agent (LoadAtLoad + KeepAlive). */
export function launchdPlist(label: string, nodeJsPath: string, agentCliPath: string, logDir: string, env: Record<string, string> = {}): string {
  const envKeys = Object.entries(env)
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${v}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeJsPath}</string>
    <string>${agentCliPath}</string>
    <string>agent</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logDir}/agent.log</string>
  <key>StandardErrorPath</key><string>${logDir}/agent.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
${envKeys}
  </dict>
</dict>
</plist>
`
}

// ---- tailscale ----

export {
  findTailscaleCli,
  runTailscale,
  getTailscaleVersion,
  getTailscaleIp,
  parseTailscaleStatusJson,
  getTailscaleStatus,
  isTailscaleInstalled,
} from './tailscale.js'
export type { TailscaleExec, TailscaleRunResult, TailscaleSelf, TailscalePeer, ParsedStatus } from './tailscale.js'

/** Windows Scheduled Task XML for the node agent (runs at logon, restarts on failure). */
export function windowsTaskXml(taskName: string, nodeExe: string, agentCliPath: string, workDir: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>dsh-helm node agent</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${nodeExe}</Command>
      <Arguments>${agentCliPath} agent</Arguments>
      <WorkingDirectory>${workDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

/** Linux systemd user unit for the node agent. */
export function systemdUnit(description: string, nodeJsPath: string, agentCliPath: string, logDir: string): string {
  return `[Unit]
Description=${description}
After=network-online.target

[Service]
Type=simple
ExecStart=${nodeJsPath} ${agentCliPath} agent
Restart=always
RestartSec=10
StandardOutput=append:${logDir}/agent.log
StandardError=append:${logDir}/agent.err.log

[Install]
WantedBy=default.target
`
}

/** Concrete service install helpers per OS (return the shell command). */
export function serviceCommands(os: Os, opts: { label: string; nodeJsPath: string; agentCliPath: string; logDir: string; workDir: string }): ServiceTemplate {
  if (os === 'darwin') {
    const plistPath = `${process.env.HOME ?? '.'}/Library/LaunchAgents/${opts.label}.plist`
    return {
      id: opts.label,
      install: `cat > ${plistPath} <<'PLIST'\n${launchdPlist(opts.label, opts.nodeJsPath, opts.agentCliPath, opts.logDir)}\nPLIST\nlaunchctl bootstrap gui/$(id -u) ${plistPath}`,
      uninstall: `launchctl bootout gui/$(id -u)/${opts.label} 2>/dev/null; rm -f ${plistPath}`,
      status: `launchctl print gui/$(id -u)/${opts.label} >/dev/null 2>&1 && echo running || echo stopped`,
      start: `launchctl kickstart -k gui/$(id -u)/${opts.label}`,
      stop: `launchctl bootout gui/$(id -u)/${opts.label}`,
    }
  }
  if (os === 'win32') {
    const task = 'dsh-helm-node-agent'
    return {
      id: task,
      install: `schtasks /Create /TN "${task}" /XML "${opts.workDir}\\task.xml" /F`,
      uninstall: `schtasks /Delete /TN "${task}" /F`,
      status: `schtasks /Query /TN "${task}"`,
      start: `schtasks /Run /TN "${task}"`,
      stop: `schtasks /End /TN "${task}"`,
    }
  }
  return {
    id: 'dsh-helm-node-agent.service',
    install: `mkdir -p ${opts.logDir} && cat > ~/.config/systemd/user/${opts.label} <<'UNIT'\n${systemdUnit('dsh-helm node agent', opts.nodeJsPath, opts.agentCliPath, opts.logDir)}\nUNIT\nsystemctl --user daemon-reload && systemctl --user enable --now ${opts.label}`,
    uninstall: `systemctl --user disable --now ${opts.label} 2>/dev/null; rm -f ~/.config/systemd/user/${opts.label}`,
    status: `systemctl --user is-active ${opts.label}`,
    start: `systemctl --user start ${opts.label}`,
    stop: `systemctl --user stop ${opts.label}`,
  }
}

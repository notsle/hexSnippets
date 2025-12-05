import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { execFile } from "child_process";

type RawSnippet = {
  prefix: string | string[];
  body: string | string[];
  description?: string;
  scope?: string; // comma/space separated list of languages
};

type TeamSnippet = {
  name: string;
  prefixes: string[];
  bodyLines: string[];
  description?: string;
  languages: string[]; // e.g. ["javascript"] or ["*"]
};

type RepoConfig = {
  id: string;
  name: string;
  localRepoPath: string;
  branch: string;
  snippetsPath: string;
  includeJsonFiles: boolean;
  enableGitPull: boolean;
};

type RepoStatus = {
  id: string;
  name: string;
  lastSync?: Date;
  lastError?: string;
  snippetCount: number;
};

let snippetMap: Map<string, TeamSnippet[]> = new Map();
let providerDisposables: vscode.Disposable[] = [];
let repoWatchers: vscode.FileSystemWatcher[] = [];
let syncTimer: NodeJS.Timeout | undefined;
let statusBarItem: vscode.StatusBarItem;
const repoStatuses = new Map<string, RepoStatus>();

export function activate(context: vscode.ExtensionContext) {
  const log = createLogger();

  // Status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "hexSnippets.syncNow";
  statusBarItem.show();
  updateStatusBar();

  // Command: manual sync
  const syncCommand = vscode.commands.registerCommand("hexSnippets.syncNow", async () => {
    await syncAllRepos(context, {
      showNotifications: true,
      allowGitPull: true,
      log,
    });
  });
  context.subscriptions.push(syncCommand);

  // Command: open snippets folder
  const openFolderCommand = vscode.commands.registerCommand("hexSnippets.openSnippetsFolder", async () => {
    const cfg = vscode.workspace.getConfiguration("hexSnippets");
    const repos = getRepoConfigs(cfg);

    if (repos.length === 0) {
      vscode.window.showWarningMessage("HexSnippets: No repositories configured.");
      return;
    }

    let repo: RepoConfig | undefined;

    if (repos.length === 1) {
      repo = repos[0];
    } else {
      const pickedName = await vscode.window.showQuickPick(
        repos.map((r) => ({
          label: r.name,
          description: resolveRepoPath(r.localRepoPath),
        })),
        { placeHolder: "Select a snippets repository to open." }
      );
      if (!pickedName) {
        return;
      }
      repo = repos.find((r) => r.name === pickedName.label);
    }

    if (!repo) return;

    const repoPath = resolveRepoPath(repo.localRepoPath);
    const snippetDir = path.join(repoPath, repo.snippetsPath);

    if (!fs.existsSync(snippetDir)) {
      vscode.window.showWarningMessage(`HexSnippets: Snippets folder '${snippetDir}' does not exist.`);
      return;
    }

    // Open in OS file explorer
    vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(snippetDir));
  });
  context.subscriptions.push(openFolderCommand);

  // Initial sync on startup
  syncAllRepos(context, {
    showNotifications: false,
    allowGitPull: true,
    log,
  });

  // Auto-sync timer
  scheduleAutoSync(context, log);

  // Re-sync if config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("hexSnippets")) {
        scheduleAutoSync(context, log);
        syncAllRepos(context, {
          showNotifications: true,
          allowGitPull: true,
          log,
        });
      }
    })
  );
}

export function deactivate() {
  disposeProviders();
  disposeWatchers();
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = undefined;
  }
}

// ---------- Core sync logic ----------

async function syncAllRepos(
  context: vscode.ExtensionContext,
  options: {
    showNotifications: boolean;
    allowGitPull: boolean;
    log: (msg: string, debugOnly?: boolean) => void;
  }
) {
  const { showNotifications, allowGitPull, log } = options;
  const cfg = vscode.workspace.getConfiguration("hexSnippets");
  const repos = getRepoConfigs(cfg);

  if (repos.length === 0) {
    if (showNotifications) {
      vscode.window.showWarningMessage("HexSnippets: No repositories configured. Configure 'hexSnippets.repositories' or the legacy single-repo settings.");
    }
    snippetMap = new Map();
    repoStatuses.clear();
    disposeProviders();
    disposeWatchers();
    updateStatusBar();
    return;
  }

  const aggregateMap = new Map<string, TeamSnippet[]>();
  repoStatuses.clear();
  disposeWatchers();

  for (const repo of repos) {
    const repoPath = resolveRepoPath(repo.localRepoPath);
    const status: RepoStatus = {
      id: repo.id,
      name: repo.name,
      snippetCount: 0,
    };

    if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, ".git"))) {
      status.lastError = `Not a git repo: ${repoPath}`;
      repoStatuses.set(repo.id, status);
      continue;
    }

    // Git pull
    if (allowGitPull && repo.enableGitPull) {
      try {
        log(`Running 'git pull' in ${repoPath} (branch ${repo.branch})`, true);
        await runGitPull(repoPath, repo.branch);
      } catch (err: any) {
        status.lastError = `git pull failed: ${err?.message || err}`;
        repoStatuses.set(repo.id, status);
        // still attempt to read current files
      }
    }

    const snippetDir = path.join(repoPath, repo.snippetsPath);
    if (!fs.existsSync(snippetDir)) {
      if (!status.lastError) {
        status.lastError = `Snippets folder not found: ${snippetDir}`;
      }
      repoStatuses.set(repo.id, status);
      continue;
    }

    // Collect snippets for this repo
    const repoMap = await collectSnippetsFromFolder(snippetDir, repo.includeJsonFiles, log);
    const repoSnippetCount = countTotalSnippets(repoMap);
    status.snippetCount = repoSnippetCount;
    if (!status.lastError) {
      status.lastSync = new Date();
    }

    // Merge into aggregate
    for (const [lang, snips] of repoMap.entries()) {
      if (!aggregateMap.has(lang)) {
        aggregateMap.set(lang, []);
      }
      aggregateMap.get(lang)!.push(...snips);
    }

    repoStatuses.set(repo.id, status);

    // Set up watcher for this repo's snippet dir
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(snippetDir, "**/*"));
    watcher.onDidChange(async () => {
      log(`File changed in ${snippetDir}; reloading all repos (without git pull).`, true);
      await syncAllRepos(context, {
        showNotifications: false,
        allowGitPull: false,
        log,
      });
    });
    watcher.onDidCreate(async () => {
      log(`File created in ${snippetDir}; reloading all repos (without git pull).`, true);
      await syncAllRepos(context, {
        showNotifications: false,
        allowGitPull: false,
        log,
      });
    });
    watcher.onDidDelete(async () => {
      log(`File deleted in ${snippetDir}; reloading all repos (without git pull).`, true);
      await syncAllRepos(context, {
        showNotifications: false,
        allowGitPull: false,
        log,
      });
    });
    repoWatchers.push(watcher);
  }

  snippetMap = aggregateMap;
  disposeProviders();
  providerDisposables = registerCompletionProviders(snippetMap, options.log);
  updateStatusBar();

  if (showNotifications) {
    const totalSnips = countTotalSnippets(snippetMap);
    const errorCount = Array.from(repoStatuses.values()).filter((s) => !!s.lastError).length;
    const repoCount = repos.length;
    const msg = errorCount ? `HexSnippets: Loaded ${totalSnips} snippet(s) from ${repoCount} repo(s) with ${errorCount} error(s).` : `HexSnippets: Loaded ${totalSnips} snippet(s) from ${repoCount} repo(s).`;
    vscode.window.showInformationMessage(msg);
  }
}

// ---------- Git + path helpers ----------

function runGitPull(repoPath: string, branch: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["-C", repoPath, "pull", "--ff-only", "origin", branch];
    execFile("git", args, { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) {
        error.message += ` | stdout: ${stdout} | stderr: ${stderr}`;
        return reject(error);
      }
      resolve();
    });
  });
}

function resolveRepoPath(configPath: string): string {
  if (path.isAbsolute(configPath)) {
    return configPath;
  }
  const wf = vscode.workspace.workspaceFolders?.[0];
  if (wf) {
    return path.join(wf.uri.fsPath, configPath);
  }
  return path.join(process.cwd(), configPath);
}

// ---------- Repo configs ----------

function getRepoConfigs(cfg: vscode.WorkspaceConfiguration): RepoConfig[] {
  const repos = (cfg.get<any[]>("repositories") || []) as any[];
  const result: RepoConfig[] = [];

  if (repos.length > 0) {
    repos.forEach((r, index) => {
      const localRepoPath = String(r.localRepoPath || "").trim();
      if (!localRepoPath) return;

      const name = String(r.name || "").trim() || `Repo ${index + 1} (${localRepoPath})`;

      result.push({
        id: `repo-${index}`,
        name,
        localRepoPath,
        branch: String(r.branch || "main"),
        snippetsPath: String(r.snippetsPath || "snippets"),
        includeJsonFiles: typeof r.includeJsonFiles === "boolean" ? r.includeJsonFiles : true,
        enableGitPull: typeof r.enableGitPull === "boolean" ? r.enableGitPull : true,
      });
    });

    return result;
  }

  // Fallback: single-repo mode using legacy properties
  const fallbackPath = (cfg.get<string>("localRepoPath") || "").trim();
  if (!fallbackPath) {
    return [];
  }

  return [
    {
      id: "fallback",
      name: "Default Repo",
      localRepoPath: fallbackPath,
      branch: cfg.get<string>("branch") || "main",
      snippetsPath: cfg.get<string>("snippetsPath") || "snippets",
      includeJsonFiles: cfg.get<boolean>("includeJsonFiles") ?? true,
      enableGitPull: cfg.get<boolean>("enableGitPull") ?? true,
    },
  ];
}

// ---------- Snippet loading & registration ----------

async function collectSnippetsFromFolder(snippetDir: string, includeJson: boolean, log: (msg: string, debugOnly?: boolean) => void): Promise<Map<string, TeamSnippet[]>> {
  const files = walk(snippetDir).filter((f) => {
    if (f.endsWith(".code-snippets")) return true;
    if (includeJson && f.endsWith(".json")) return true;
    return false;
  });

  log(`Found ${files.length} snippet file(s) in ${snippetDir}`, true);

  const map = new Map<string, TeamSnippet[]>();

  for (const file of files) {
    try {
      const text = fs.readFileSync(file, "utf8");
      if (!text.trim()) continue;
      const json = JSON.parse(text) as Record<string, RawSnippet>;
      for (const [name, raw] of Object.entries(json)) {
        const snippet = normalizeSnippet(name, raw);
        for (const lang of snippet.languages) {
          const key = lang.toLowerCase();
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push(snippet);
        }
      }
    } catch (err: any) {
      vscode.window.showWarningMessage(`HexSnippets: Failed to load snippets from '${file}': ${err?.message || err}`);
    }
  }

  return map;
}

function normalizeSnippet(name: string, raw: RawSnippet): TeamSnippet {
  const prefixes = Array.isArray(raw.prefix) ? raw.prefix : [raw.prefix];
  const bodyLines = Array.isArray(raw.body) ? raw.body : raw.body.split(/\r?\n/);

  let languages: string[] = ["*"]; // global by default
  if (raw.scope && raw.scope.trim()) {
    languages = raw.scope
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return {
    name,
    prefixes,
    bodyLines,
    description: raw.description,
    languages,
  };
}

function registerCompletionProviders(map: Map<string, TeamSnippet[]>, log: (msg: string, debugOnly?: boolean) => void): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  const languages = new Set<string>();
  for (const lang of map.keys()) languages.add(lang);

  const globalSnips = map.get("*") || [];

  // 1) Language-specific providers
  languages.forEach((lang) => {
    if (lang === "*") return;

    const selector: vscode.DocumentSelector = [{ language: lang }];
    const langSnips = map.get(lang) || [];

    const provider: vscode.CompletionItemProvider = {
      provideCompletionItems() {
        // merge global + language-specific
        const all = [...globalSnips, ...langSnips];
        const items: vscode.CompletionItem[] = [];

        for (const snip of all) {
          for (const prefix of snip.prefixes) {
            const item = new vscode.CompletionItem(snip.name || prefix, vscode.CompletionItemKind.Snippet);
            item.insertText = new vscode.SnippetString(snip.bodyLines.join("\n"));
            item.filterText = prefix;
            item.sortText = `zzz_team_${prefix}`;
            item.detail = `Team Snippet (${lang})`;
            if (snip.description) {
              item.documentation = snip.description;
            }
            items.push(item);
          }
        }

        log(`Providing ${items.length} completion items for language '${lang}'.`, true);
        return items;
      },
    };

    // Trigger characters based on prefixes
    const allForLang = [...globalSnips, ...langSnips];
    const triggerChars = Array.from(
      new Set(
        allForLang
          .flatMap((s) => s.prefixes)
          .map((p) => (p.length > 0 ? p[p.length - 1] : ""))
          .filter(Boolean)
      )
    );

    const disposable = vscode.languages.registerCompletionItemProvider(selector, provider, ...triggerChars);
    disposables.push(disposable);
  });

  // 2) Global-only provider (if there are global snippets and NO lang-specific ones)
  if (globalSnips.length > 0 && languages.size === 1 && languages.has("*")) {
    const selector: vscode.DocumentSelector = [{ scheme: "file" }];

    const provider: vscode.CompletionItemProvider = {
      provideCompletionItems() {
        const items: vscode.CompletionItem[] = [];

        for (const snip of globalSnips) {
          for (const prefix of snip.prefixes) {
            const item = new vscode.CompletionItem(snip.name || prefix, vscode.CompletionItemKind.Snippet);
            item.insertText = new vscode.SnippetString(snip.bodyLines.join("\n"));
            item.filterText = prefix;
            item.sortText = `zzz_team_${prefix}`;
            item.detail = `Team Snippet (global)`;
            if (snip.description) {
              item.documentation = snip.description;
            }
            items.push(item);
          }
        }

        log(`Providing ${items.length} global completion items (no scoped snippets).`, true);
        return items;
      },
    };

    const triggerChars = Array.from(
      new Set(
        globalSnips
          .flatMap((s) => s.prefixes)
          .map((p) => (p.length > 0 ? p[p.length - 1] : ""))
          .filter(Boolean)
      )
    );

    const disposable = vscode.languages.registerCompletionItemProvider(selector, provider, ...triggerChars);
    disposables.push(disposable);
  }

  log(`Registered completion providers for languages: ${Array.from(languages).join(", ")} (global snippets: ${globalSnips.length}).`, true);
  return disposables;
}
function disposeProviders() {
  for (const d of providerDisposables) d.dispose();
  providerDisposables = [];
}

function disposeWatchers() {
  for (const w of repoWatchers) w.dispose();
  repoWatchers = [];
}

function countTotalSnippets(map: Map<string, TeamSnippet[]>): number {
  let count = 0;
  for (const arr of map.values()) count += arr.length;
  return count;
}

// ---------- Misc utils ----------

function walk(dir: string): string[] {
  let results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walk(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function createLogger() {
  return (message: string, debugOnly = false) => {
    const cfg = vscode.workspace.getConfiguration("hexSnippets");
    const debug = cfg.get<boolean>("debug") ?? false;
    if (debugOnly && !debug) return;
    console.log(`[hexSnippets] ${message}`);
  };
}

// ---------- Status bar ----------

function updateStatusBar() {
  const statuses = Array.from(repoStatuses.values());
  const totalSnips = countTotalSnippets(snippetMap);

  if (statuses.length === 0) {
    statusBarItem.text = "$(circle-slash) HexSnippets";
    statusBarItem.tooltip = "HexSnippets: No repositories configured.";
    return;
  }

  const errorCount = statuses.filter((s) => !!s.lastError).length;

  if (errorCount > 0) {
    statusBarItem.text = `$(warning) HexSnippets (${totalSnips})`;
  } else {
    statusBarItem.text = `$(check) HexSnippets (${totalSnips})`;
  }

  const lines: string[] = [];
  lines.push("HexSnippets Status");
  lines.push("");
  for (const s of statuses) {
    const icon = s.lastError ? "⚠" : "✔";
    const lastSyncStr = s.lastSync ? s.lastSync.toLocaleString() : "never";
    const base = `${icon} ${s.name} — ${s.snippetCount} snippet(s)`;
    if (s.lastError) {
      lines.push(`${base}\n   Last error: ${s.lastError}`);
    } else {
      lines.push(`${base}\n   Last sync: ${lastSyncStr}`);
    }
    lines.push("");
  }
  lines.push("Click to sync now.");
  statusBarItem.tooltip = lines.join("\n");
}

// ---------- Auto-sync ----------

function scheduleAutoSync(context: vscode.ExtensionContext, log: (msg: string, debugOnly?: boolean) => void) {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = undefined;
  }
  const cfg = vscode.workspace.getConfiguration("hexSnippets");
  const minutes = cfg.get<number>("autoSyncIntervalMinutes") ?? 15;
  if (minutes > 0) {
    log(`Auto-sync every ${minutes} minute(s).`, true);
    syncTimer = setInterval(() => {
      syncAllRepos(context, {
        showNotifications: false,
        allowGitPull: true,
        log,
      });
    }, minutes * 60_000);
  } else {
    log("Auto-sync disabled (interval = 0).", true);
  }
}

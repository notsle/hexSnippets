# **HexSnippets**

A lightweight, zero-auth, VS Code extension that loads shared code snippets from one or more **local git repositories**. Automatically keeps them updated via `git pull`, reloads snippets when files change, and provides a status overview in the VS Code status bar.

Perfect for teams who store snippets in private repos, use multiple snippet sources (core + project-specific), or want centralized snippet management without publishing extensions.

---

## ✨ **Features**

### 🔄 **Automatically load and merge snippets from multiple git repos**

Configure as many local git repos as you want. Each repo can contain its own snippet folder.

### 🔃 **Auto-sync via `git pull`**

At a configurable interval (default: 15 minutes), the extension will pull changes from each repo and reload snippets.

### 👀 **Auto-reload on file changes**

If you edit snippet files locally or another process updates them, the extension automatically reloads all snippets instantly.

### 📦 **Standard VS Code snippet JSON format**

The extension loads:

- `*.code-snippets`
- `*.json` (optional)

Follows VS Code’s native snippet format, including `prefix`, `scope`, and tabstops.

### 🧠 **Merged output**

Snippets from all configured repos are merged together:

- Global snippets (`"scope": "*"`)
- Per-language snippets (`"scope": "javascript,typescript"`)

### 📡 **Status bar indicator**

Shows:

- Total snippets loaded
- Git sync success/errors
- Per-repo status in tooltip
- Click to run manual sync

### 📁 **Open snippets folder**

Command: **HexSnippets: Open Snippets Folder**
If you have multiple repos, a quick picker lets you choose which one to open.

---

## 🚀 **Installation**

1. Clone/fork this repo.
2. Run:

   ```bash
   npm install
   npm run compile
   ```

3. Press **F5** in VS Code to launch the extension in a development host.
4. Package with:

   ```bash
   npx vsce package
   ```

---

## ⚙️ **Configuration**

Add this to your VS Code `settings.json`:

### **Multiple repositories (recommended)**

```jsonc
{
  "hexSnippets.repositories": [
    {
      "name": "Core Snippets",
      "localRepoPath": "/home/user/dev/snippets-core",
      "branch": "main",
      "snippetsPath": "snippets",
      "includeJsonFiles": true,
      "enableGitPull": true
    },
    {
      "name": "Client A",
      "localRepoPath": "/home/user/projects/client-a-snippets",
      "branch": "main",
      "snippetsPath": "snippets",
      "includeJsonFiles": true,
      "enableGitPull": false // only reload, never pull
    }
  ],

  "hexSnippets.autoSyncIntervalMinutes": 15,
  "hexSnippets.debug": false
}
```

## 🛠 **Commands**

### 🔄 **HexSnippets: Sync Now**

Runs `git pull` (if enabled) for all configured repos and reloads snippets.

### 📁 **HexSnippets: Open Snippets Folder**

Opens the snippets directory for any repo in your OS file explorer.

---

## 📌 **Snippet Format**

Standard VS Code snippet JSON:

```jsonc
{
  "Log Variable": {
    "prefix": "logv",
    "scope": "javascript,typescript",
    "body": ["console.log('${1:label}:', ${2:value});"],
    "description": "Log a variable with a label"
  }
}
```

- `"scope": "*"` → global snippet
- Multiple prefixes are allowed
- Body can be a string or an array

---

## 🔧 How It Works

### 1. On startup (or interval)

- For each repo:

  - Resolves the local repo path (absolute or relative).
  - Optionally runs `git pull`.
  - Loads snippet files under the configured snippet folder.

### 2. Snippets are parsed & merged

- Grouped by language
- Added to VS Code via completion providers

### 3. Watchers monitor file changes

Any change triggers a **fast reload** (no git pull).

### 4. Status shown in VS Code

Hover to see:

- Repo sync success/errors
- Last sync timestamps
- Snippet counts

---

## 💡 Tips & Best Practices

- Store snippets in separate repos per team, client, or project.
- Add sample snippets to help new teammates onboard quickly.
- Use `enableGitPull: false` when working offline or when using Git worktrees.
- Use `debug: true` while developing new snippet sets.

---

## 🐛 Troubleshooting

### “Path is not a git repo”

Ensure the repo contains a `.git` folder and your configured path is correct.

### Snippets not loading

Check:

- File extensions (must be `.code-snippets` or `.json`)
- JSON syntax validity
- That `"scope"` is correct for the language

### Status bar shows ⚠

Hover over it — the tooltip will show the per-repo error details.

---

## 📄 License

MIT License
Copyright ©

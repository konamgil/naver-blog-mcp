# @oddeye/naver-blog-mcp

MCP server for **Naver blog automation** via Playwright. Use with Claude Desktop, Claude Code, Cursor, or any MCP-compatible agent to publish, schedule, and delete posts on Naver blog.

> ⚠️ Naver actively blocks automation. Session reuse works best; ID/PW login often triggers CAPTCHA. Use `naver_login_interactive` for first-time login.

## Install via MCP client

### Claude Desktop
Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

**macOS / Linux**
```json
{
  "mcpServers": {
    "naver-blog": {
      "command": "npx",
      "args": ["-y", "@oddeye/naver-blog-mcp"]
    }
  }
}
```

**Windows** (Node's `spawn` cannot resolve `npx.cmd` directly — wrap with `cmd /c`):
```json
{
  "mcpServers": {
    "naver-blog": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@oddeye/naver-blog-mcp"]
    }
  }
}
```

### Claude Code
Add to `.mcp.json` in your project root, or run:
```bash
# macOS / Linux
claude mcp add naver-blog -- npx -y @oddeye/naver-blog-mcp

# Windows
claude mcp add naver-blog -- cmd /c npx -y @oddeye/naver-blog-mcp
```

### Cursor
Add to `~/.cursor/mcp.json` (use the same OS-specific `command`/`args` as Claude Desktop above).

> **First run** downloads Playwright's Chromium (~150 MB). This may delay the first MCP startup by 30–90 s. If your client times out, install Chromium ahead of time:
> ```bash
> npx playwright install chromium
> ```
> Then restart your MCP client.

## Tools

| Tool | Description |
|---|---|
| `naver_login_with_credentials` | Auto-login with ID/PW. ⚠️ Often blocked by CAPTCHA. |
| `naver_login_interactive` | Open a browser window for the user to log in manually (handles CAPTCHA/2FA). Optional `password` arg stores credentials encrypted for auto session recovery. |
| `naver_login_status` | Check whether a saved session exists for a given Naver ID. |
| `naver_register_account` | Register an account in the local DB without logging in. |
| `naver_list_accounts` | List registered accounts. |
| `naver_delete_account` | Remove an account from the local DB. |
| `naver_create_post` | Create a draft or scheduled post in the DB. |
| `naver_publish_post` | Publish an existing DB post to Naver. |
| `naver_publish_now` | Create + publish in one call. |
| `naver_publish_adhoc` | Publish without writing to the DB (bypasses DB lookup). |
| `naver_list_posts` | List posts (optional status filter). |
| `naver_delete_post` | Remove a post from DB and (if published) from Naver. |

## First-time setup flow

1. Tell the agent: *"Register my Naver blog. ID: `myid`, blog URL ID: `myblog_url`. Use interactive login."*
2. Agent calls `naver_login_interactive`. A Chromium window opens.
3. **You log in manually** (handles CAPTCHA / 2FA / new-device verification).
4. On successful login the session is saved to disk; account upserted.
5. Subsequent calls (`naver_publish_now`, etc.) reuse the session — no browser interaction needed.

## Session resilience

If both ID and encrypted password are stored (via `naver_login_with_credentials`, or `naver_login_interactive` with the optional `password` arg, or `naver_register_account` with `password`), publish automatically recovers from session loss:

- **No session file** → auto-login with stored password before publishing.
- **Session file exists but Naver invalidated it** (`SESSION_EXPIRED` at publish time) → auto-login + retry publish once.

This means: give the credentials **once**, and the agent keeps publishing across long gaps without re-prompting the user. If you only saved a session (no password), session loss requires another interactive login.

## Data location

Everything is stored under `~/.blog-automation/`:
```
~/.blog-automation/
├── app.db                 # SQLite (accounts, posts)
├── sessions/<naverId>.json  # Playwright storage state
└── .encryption-key        # AES-256-GCM key (auto-generated on first run)
```

Override the base directory with `BLOG_AUTOMATION_HOME`.

## Environment variables (all optional)

| Var | Default | Purpose |
|---|---|---|
| `BLOG_AUTOMATION_HOME` | `~/.blog-automation` | Base data directory |
| `DATABASE_URL` | `$HOME/app.db` | SQLite file path |
| `SESSION_DIR` | `$HOME/sessions` | Playwright session storage |
| `ENCRYPTION_KEY` | auto-generated to file | 64 hex chars (32 bytes) for password encryption |
| `HEADLESS` | `true` | Set `false` to see the browser (publish/login) |
| `MCP_HTTP_TOKEN` | unset | If set, the optional HTTP transport requires `Authorization: Bearer …` |
| `PORT` | `3000` | HTTP transport port (if you run the bundled REST/HTTP server) |
| `SCHEDULER_CRON` | `* * * * *` | Cron expression for scheduled-post polling |
| `SKIP_PLAYWRIGHT_INSTALL` | unset | Set to `1` to skip Chromium auto-download during `npm install` (then run `npx playwright install chromium` manually) |

## Security notes

- Passwords are encrypted with AES-256-GCM and stored locally only. They never leave your machine.
- If you pass a password through the agent's chat, it **may be logged by the LLM provider**. Prefer `naver_login_interactive` when possible.
- Naver detects automation aggressively from datacenter IPs. Run on your local machine or a Korea-region VPS for best stability.

## Troubleshooting

**`Failed to reconnect to naver-blog: -32000` (Claude Code/Desktop)**
- **Windows**: confirm the config uses `"command": "cmd", "args": ["/c", "npx", ...]` (not bare `"npx"`). Node's `spawn` cannot resolve `.cmd` shims without the wrapper.
- npx cache corruption: `npm cache clean --force` then restart the client.
- Startup timeout on first run: install Chromium ahead of time (`npx playwright install chromium`).

**`Unsupported URL Type "workspace:"` during install**
- Happens when running `npm install @oddeye/naver-blog-mcp` from a pnpm workspace cwd. Install in a plain folder, or use `npx -y` directly.

**`browserType.launch: Executable doesn't exist`**
- Chromium auto-install was skipped or failed. Run:
  ```bash
  npx playwright install chromium
  ```

**Login keeps failing with CAPTCHA**
- Use `naver_login_interactive` instead of `naver_login_with_credentials`. Naver blocks scripted ID/PW logins aggressively.

## License

MIT

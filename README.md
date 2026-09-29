# YUNTA

<img src="assets/brand/yunta/logo.png" alt="YUNTA logo" width="240">

MCP server for controlled, auditable WordPress draft creation.

YUNTA is an independent capability developed within ARO ARO ARO. It can be understood and used on its own; ARO ARO ARO is its parent brand and is not required to run YUNTA.

## Scope in v0.1.0

YUNTA v0.1.0 includes:

- An MCP server that communicates over stdio.
- The `wordpress.create_draft` tool.
- WordPress REST API integration for creating and verifying draft posts.
- Security validation for WordPress targets and tool inputs.
- Local durable audit records.
- Explicit handling of ambiguous execution outcomes.

YUNTA v0.1.0 does not include:

- An agent platform or general autonomy.
- Multiple connectors.
- Automatic publication of WordPress posts.
- A complete ARO ARO ARO ecosystem.

## Architecture

An MCP client starts YUNTA as a local stdio process. The client invokes `wordpress.create_draft`; YUNTA validates the request and WordPress target, calls the WordPress REST API, verifies the resulting draft, and writes local audit records. Standard output is reserved for MCP messages and diagnostics are written to standard error.

## Requirements

- Node.js 24 or newer (required to run the TypeScript entrypoint directly).
- npm 11 or newer; this checkout specifies npm 11.19.0.
- Alternatively, the Windows x64 portable executable can run without Node.js or npm on the user's machine.
- A reachable WordPress site with its REST API enabled and a user permitted to create draft posts.
- An MCP client that can launch a local stdio server.

## Installation

Obtain a YUNTA checkout, then run the following in the checkout root:

```bash
npm ci
npm start
```

`npm start` runs the server in the terminal. It waits for MCP protocol messages on stdin; it does not show an interactive prompt. Stop it with EOF or your terminal's interrupt key. To use the tool, configure an MCP client as described below. Installing with `npm ci` uses the committed lockfile; no build step is needed.

### Windows portable executable

`YUNTA.exe` is a portable Windows x64 MCP stdio server, not a GUI application. To build it from this checkout on Windows x64 with Node 24 and npm 11, run `npm ci`, `npm run build:windows`, and `npm run test:windows-exe`. The locally generated `dist/YUNTA.exe` can then be copied on its own to another directory; the receiving machine does not need Node.js, npm, or this checkout. When the v0.1.0 GitHub Release is available, its Windows x64 executable asset is named `YUNTA-v0.1.0-windows-x64.exe`.

Configure your MCP client to launch the absolute path to `YUNTA.exe` directly, with no script arguments. Supply `WORDPRESS_BASE_URL`, `WORDPRESS_USERNAME`, `WORDPRESS_APPLICATION_PASSWORD`, `YUNTA_ACTOR_ID`, and `YUNTA_AUDIT_PATH` through the client's secure environment setup exactly as described below. Keep the audit path absolute, in an existing private directory outside the executable's directory and any enclosing checkout. No credentials are built into the executable.

## WordPress setup

1. Confirm that the site's REST API is available and the intended WordPress user has permission to create posts as drafts.
2. In that user's WordPress profile, generate a dedicated **Application Password** for YUNTA. Use the WordPress username and this Application Password, **not** the user's normal login password. Store the Application Password securely and revoke it in WordPress when no longer needed.
3. Use the site's HTTPS origin as `WORDPRESS_BASE_URL`, for example `https://example.org`. Do not include credentials in the URL. YUNTA calls `/wp-json/wp/v2/users/me` and `/wp-json/wp/v2/posts` from the origin root; the quickstart assumes those endpoints are accessible there.

## Configuration

Set these variables in the environment of the **MCP server process** before invoking the tool:

| Variable | Meaning |
| --- | --- |
| `WORDPRESS_BASE_URL` | HTTPS origin of the WordPress site. |
| `WORDPRESS_USERNAME` | WordPress username associated with the Application Password. |
| `WORDPRESS_APPLICATION_PASSWORD` | Application Password for that user. |
| `YUNTA_ACTOR_ID` | A nonempty identifier for the actor creating drafts, used in execution records. |
| `YUNTA_AUDIT_PATH` | Absolute path to the audit JSONL file; see below. |

Supply secrets through your operating system's secure secret storage or the client's secure environment-injection mechanism. Ensure the client passes the variables to its child process (or inherits an environment in which they are already set). Do not put an Application Password in command arguments, the client JSON example, a committed file, a URL, or a log. YUNTA reads process environment variables; it does not load `.env` files.

The server can start and list its tool before these variables are set, but `wordpress.create_draft` needs all five when called. Restart the MCP client after changing its process environment.

## Audit

Create a private directory **outside the YUNTA checkout** before using the tool. Set `YUNTA_AUDIT_PATH` to an absolute path for a JSONL file inside it; the parent directory must already exist, be writable by the MCP process, and be protected against other users. YUNTA writes audit events and request-claim files there. Keep these files private and do not commit them. The audit filename need not exist in advance; if it already exists, it must be a regular, non-symlink file (and private on non-Windows systems).

## Connect an MCP client

Add a local stdio server to your MCP client's configuration. For clients using an `mcpServers` JSON mapping, the shape is:

```json
{
  "mcpServers": {
    "yunta": {
      "command": "<ABSOLUTE_PATH_TO_NODE_EXECUTABLE>",
      "args": ["<ABSOLUTE_PATH_TO_YUNTA>/entrypoints/mcp/stdio.ts"]
    }
  }
}
```

Replace both placeholders with absolute paths on your machine (escape Windows backslashes as `\\` in JSON, or use `/`). The recommended client launch is `node <ABSOLUTE_PATH_TO_YUNTA>/entrypoints/mcp/stdio.ts`, with `node` resolved to the absolute executable in the client configuration. Absolute paths let the client start YUNTA from any working directory. Inject or inherit the five variables above through your client's secure environment setup; the JSON example contains no credentials. Restart the client, then find `wordpress.create_draft` in its tool list. Point the client directly at Node rather than `npm start` to keep stdout exclusively for MCP JSON-RPC.

## Create your first draft

Ask your MCP client to call `wordpress.create_draft` with:

```json
{
  "title": "A draft title",
  "contentHtml": "<p>Draft content.</p>"
}
```

On success the tool returns `postId`, `status: "draft"`, and `resourceUrl`. Confirm the draft in WordPress. It never publishes a post.

## `wordpress.create_draft` contract

- Input: exactly `title` and `contentHtml`, both nonblank strings. Title: at most 200 Unicode characters. HTML: at most 65,536 Unicode characters **and** 65,536 UTF-8 bytes.
- Output on success: `postId` (positive integer), `status: "draft"`, `resourceUrl` (string). The tool does not return credentials or the submitted content.
- Stdio messages are limited to 256 KiB. One draft operation runs at a time per server process; simultaneous calls can return `EXECUTION_NOT_READY`.
- The tool is not idempotent across calls. A lost response does not prove that WordPress did not create a draft.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Server or tool does not appear | Check Node 24+, the two absolute paths, the client's stdio server configuration, and that the client was restarted. Listing the tool does not require WordPress credentials. |
| `MISSION_ENTRYPOINT_FAILED` | Check all five environment variables in the server process, HTTPS URL, and the existing writable, protected audit parent outside the checkout (and outside the executable's directory). The MCP response remains generic; when a request was claimed, the private audit may record `failureStage`, `failureCategory`, `failureCode`, and `elapsedMs` to help narrow down the failure. Keep the audit private. |
| `EXECUTION_NOT_READY` | Another draft call may be running. Also check WordPress REST API availability and credentials: an unhealthy pre-execution check can prevent a call. |
| WordPress authentication fails | Confirm username, Application Password, user's post-creation permissions, HTTPS connectivity, and access to `/wp-json/wp/v2/users/me`. Authentication failure during health checks can surface as `EXECUTION_NOT_READY`; a rejected post may return `WORDPRESS_UNAUTHORIZED` or `WORDPRESS_REQUEST_REJECTED`. |
| `EXECUTION_OUTCOME_AMBIGUOUS`, cancellation, or disconnected client | Inspect WordPress drafts and the private audit before deciding whether to send another call. **Never retry automatically:** WordPress may already have created the draft. |

## Security and limits

WordPress targets require HTTPS; HTTP is accepted only for literal `127.0.0.1` or `[::1]` loopback targets. Redirects are not followed. Diagnostics go to stderr, and stdout is reserved for MCP messages. Protect the MCP client's configuration, process environment, and audit files. In particular, an interrupted call may still complete in WordPress even if its response cannot reach the client.

## Roadmap

Future work is intentionally separate from the v0.1.0 scope. YUNTA does not currently claim additional connectors, autonomous operation, automatic publishing, or a general agent platform.

## Validate locally

From the checkout root, run:

```bash
npm ci
npm run typecheck
npm test
npm run validate
npm audit
```

Tests exercise MCP stdio and the WordPress integration against controlled local HTTP fixtures; they do not require a real WordPress account.

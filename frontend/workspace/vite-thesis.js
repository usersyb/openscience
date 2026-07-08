import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { readFileSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"

/**
 * Dev-only Vite plugin exposing the Atlas graph API at /api/thesis/*.
 *
 * Mirrors the production backend bridge (backend/cli/src/server/routes/
 * atlas-bridge.ts): it proxies straight to the Atlas REST API
 * (`API_BASE/api/v1/*`) using the `thk_` key from the local CLI session
 * (`~/.local/share/openscience/openscience-session.json`). No `atlas` binary needed.
 * 60s cache on GETs so toggling tabs doesn't re-hit the cloud each time.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
void __dirname

// Neutral public default — mirrors backend/cli/src/endpoints.ts. Never bake an
// internal deployment codename into a shipped default; override via env for dev.
const API_BASE = (
  process.env.OPENSCIENCE_API_BASE ||
  process.env.SYNSC_API_BASE ||
  process.env.MANAGED_API_BASE ||
  process.env.ATLAS_BASE_URL ||
  "https://app.syntheticsciences.ai"
).replace(/\/+$/, "")

const cache = new Map() // key -> { at: number, body: string, status: number }
const CACHE_TTL_MS = 60_000

function sessionToken() {
  try {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
    const raw = readFileSync(join(base, "openscience", "openscience-session.json"), "utf8")
    return JSON.parse(raw).api_key || null
  } catch {
    return null
  }
}

async function atlasFetch(method, path, body) {
  const token = sessionToken()
  if (!token) throw new Error("not logged in — run `openscience login`")
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`atlas ${path} → HTTP ${res.status}`)
  const text = await res.text()
  return text ? JSON.parse(text) : {}
}

function spawnCommand(command, args, cwd) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      cwd: cwd || process.cwd(),
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => (out += d.toString()))
    child.stderr.on("data", (d) => (err += d.toString()))
    child.on("error", rejectP)
    child.on("close", (code) => {
      if (code === 0) {
        resolveP(out.trim())
        return
      }
      rejectP(new Error(err.trim() || `${command} exited ${code}`))
    })
  })
}

async function readBody(req) {
  return await new Promise((resolveP, rejectP) => {
    let data = ""
    req.on("data", (chunk) => (data += chunk))
    req.on("end", () => resolveP(data))
    req.on("error", rejectP)
  })
}

function send(res, status, body) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(typeof body === "string" ? body : JSON.stringify(body))
}

function hash(input) {
  return createHash("sha256").update(String(input)).digest("hex").slice(0, 16)
}

function nodeID(input) {
  return (
    input?.node_id ??
    input?.id ??
    input?.node?.node_id ??
    input?.node?.id ??
    input?.committed?.node_id ??
    input?.result?.node_id ??
    null
  )
}

function normalizeGitHubRemote(remote) {
  if (!remote) return null
  const trimmed = String(remote).trim()
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/)
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}`
  const https = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (https) return `https://github.com/${https[1]}/${https[2]}`
  return trimmed
}

async function git(args, directory) {
  return await spawnCommand("git", args, directory)
}

async function repoContext(directory) {
  if (!directory) {
    return {
      repo_url: null,
      branch_name: null,
      head_commit_sha: null,
      origin_host: null,
      updated_by: null,
      external_transcript_ref: null,
    }
  }
  const [remote, branch, head, user] = await Promise.all([
    git(["config", "--get", "remote.origin.url"], directory).catch(() => ""),
    git(["branch", "--show-current"], directory).catch(() => ""),
    git(["rev-parse", "HEAD"], directory).catch(() => ""),
    git(["config", "user.email"], directory).catch(() => ""),
  ])
  const repo = normalizeGitHubRemote(remote)
  const host = (() => {
    if (!repo) return null
    try {
      return new URL(repo).hostname
    } catch {
      return null
    }
  })()
  return {
    repo_url: repo,
    branch_name: branch || null,
    head_commit_sha: head || null,
    origin_host: host,
    updated_by: user || null,
    external_transcript_ref: null,
  }
}

async function commitNewNode(input) {
  const data = await atlasFetch("POST", "/api/v1/nodes/commit-new", {
    local_temp_node_id: input.localID,
    parent_ids: input.parentIDs ?? [],
    staged_payload: {
      title: input.title,
      kind: input.kind,
      content: input.content,
      summary: input.summary,
      hypothesis: input.hypothesis,
      insights: input.insights ?? [],
      no_artifacts_reason: input.reason,
      repo_context: input.context,
    },
  })
  return { node_id: nodeID(data), raw: data }
}

// ── per-folder project resolution (mirrors atlas-bridge.ts) ────────────────
function projectIdOf(data) {
  const p = Array.isArray(data?.projects) ? data.projects[0] : undefined
  return p?.project_id ?? p?.id ?? p?.node_id ?? data?.project_id ?? data?.id ?? null
}

async function repoTop(directory) {
  const top = await git(["rev-parse", "--show-toplevel"], directory).catch(() => "")
  if (!top) return directory
  try {
    return realpathSync(top)
  } catch {
    return top
  }
}

// Must match computeDedupeKey() in atlas-bridge.ts so dev + prod resolve the
// SAME Atlas project for a given repo/folder.
function computeDedupeKey(directory, repoUrl) {
  if (repoUrl) {
    try {
      const u = new URL(repoUrl)
      const segments = u.pathname
        .replace(/^\/+/, "")
        .replace(/\.git$/, "")
        .split("/")
      const owner = segments.shift()
      const name = segments.join("/")
      if (owner && name) return `repo:${u.hostname}/${owner}/${name}`
    } catch {}
  }
  try {
    return `local-folder:${realpathSync(directory)}`
  } catch {
    return `local-folder:${directory}`
  }
}

async function resolveProjectId(directory) {
  if (!directory) return null
  try {
    const root = await repoTop(directory)
    const ctx = await repoContext(root)
    const key = computeDedupeKey(root, ctx.repo_url)
    const data = await atlasFetch("GET", `/api/agent/projects?dedupe_key=${encodeURIComponent(key)}`)
    return projectIdOf(data)
  } catch {
    return null
  }
}

// Find-or-create the opened folder's Atlas project (mirrors initProjectDetailed):
// resolve first, else the /api/agent/projects endpoint, else a dedupe-tagged root
// node via commit-new. Returns { project_id } or { project_id: null, error, message }.
async function initProject(directory) {
  if (!directory) return { project_id: null, error: "backend", message: "no directory provided" }
  if (!sessionToken()) return { project_id: null, error: "unauthenticated", message: "run `openscience login`" }
  const existing = await resolveProjectId(directory)
  if (existing) return { project_id: existing }
  const root = await repoTop(directory)
  const ctx = await repoContext(root)
  const key = computeDedupeKey(root, ctx.repo_url)
  const name = root.split("/").filter(Boolean).pop() || "project"
  try {
    const data = await atlasFetch("POST", "/api/agent/projects", {
      title: name,
      dedupe_key: key,
      repo_url: ctx.repo_url ?? undefined,
      branch_name: ctx.branch_name ?? undefined,
    })
    const id = projectIdOf(data)
    if (id) return { project_id: id }
  } catch {
    /* fall through to the commit-new fallback */
  }
  try {
    const { node_id } = await commitNewNode({
      localID: `local-project-${hash(key)}`,
      parentIDs: [],
      title: `Project: ${name}`,
      kind: "insight",
      summary: `Atlas research-graph root for ${name}.`,
      hypothesis: "",
      content: "",
      reason: "Initialized as this repo's Atlas research-graph root.",
      context: { ...ctx, external_transcript_ref: `atlas-project-dedupe:${key}` },
    })
    if (node_id) return { project_id: node_id }
  } catch (e) {
    return { project_id: null, error: "backend", message: String(e?.message ?? e) }
  }
  return { project_id: null, error: "backend", message: "projects endpoint returned no project id" }
}

const GITHUB = {
  status: () => atlasFetch("GET", "/api/v1/auth/github/status"),
  refresh: () => atlasFetch("POST", "/api/v1/auth/github/refresh-repos", {}),
  disconnect: () => atlasFetch("DELETE", "/api/v1/auth/github/disconnect"),
}

async function handle(req, res) {
  const path = (req.url || "/").split("?")[0].replace(/^\/+/, "")
  const method = req.method || "GET"
  const query = new URLSearchParams((req.url || "").split("?")[1] || "")
  const cacheKey = `${method} ${req.url}`
  // /project resolution must never serve a stale null across an init — resolve fresh.
  const cacheable = method === "GET" && path !== "project"

  if (cacheable) {
    const hit = cache.get(cacheKey)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return send(res, hit.status, hit.body)
    }
  }

  try {
    let body
    if (method === "GET" && path === "nodes") {
      body = JSON.stringify(await atlasFetch("GET", "/api/v1/nodes"))
    } else if (method === "GET" && path === "graphs") {
      body = JSON.stringify(await atlasFetch("GET", "/api/v1/nodes?root_only=true"))
    } else if (method === "GET" && /^graphs\/[\w-]+\/tree$/.test(path)) {
      const id = path.split("/")[1]
      body = JSON.stringify(await atlasFetch("GET", `/api/v1/nodes/${encodeURIComponent(id)}/tree?projection=full`))
    } else if (method === "GET" && /^nodes\/[\w-]+\/artifacts$/.test(path)) {
      const id = path.split("/")[1]
      try {
        body = JSON.stringify(await atlasFetch("GET", `/api/v1/nodes/${encodeURIComponent(id)}/artifacts`))
      } catch {
        body = JSON.stringify({ artifacts: [], has_more: false })
      }
    } else if (method === "POST" && path === "nodes") {
      const parsed = JSON.parse((await readBody(req)) || "{}")
      const title = String(parsed.title ?? "Untitled node")
      const result = await commitNewNode({
        localID: `local-node-${hash(title)}`,
        parentIDs: [],
        title,
        kind: "insight",
        summary: "",
        hypothesis: "",
        content: "",
        reason: "Created from OpenScience web.",
        context: await repoContext(process.cwd()),
      })
      cache.delete("GET /nodes")
      return send(res, 200, result)
    } else if (method === "GET" && path === "github/status") {
      return send(res, 200, await GITHUB.status())
    } else if (method === "POST" && path === "github/refresh") {
      return send(res, 200, await GITHUB.refresh())
    } else if (method === "POST" && path === "github/disconnect") {
      return send(res, 200, await GITHUB.disconnect())
    } else if (method === "GET" && path === "health") {
      return send(res, 200, { ok: !!sessionToken() })
    } else if (method === "GET" && path === "project") {
      // Resolve the opened folder's Atlas project (find-only).
      body = JSON.stringify({ project_id: await resolveProjectId(query.get("directory") || "") })
    } else if (method === "POST" && path === "project/init") {
      // Find-or-create the opened folder's Atlas project graph.
      return send(res, 200, await initProject(query.get("directory") || ""))
    } else {
      // Mirror the backend bridge's `.all("/*") → 200 {}`: quietly answer any
      // other path the SPA probes (e.g. GET /project for a folder with no linked
      // graph) with an empty object, so dev doesn't spam 404s where production
      // returns 200. The graph list + per-graph tree above are the real routes.
      return send(res, 200, {})
    }

    if (cacheable) cache.set(cacheKey, { at: Date.now(), body, status: 200 })
    return send(res, 200, body)
  } catch (e) {
    return send(res, 502, { error: "atlas request failed", detail: String(e?.message ?? e) })
  }
}

export default {
  name: "atlas-bridge",
  configureServer(server) {
    server.middlewares.use("/api/thesis", (req, res, next) => {
      handle(req, res).catch(next)
    })
  },
}

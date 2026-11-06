#!/usr/bin/env node
/**
 * Capture harness for the cf-opencode settings panel.
 *
 *   node hillclimb/harness/capture.cjs <label>
 *
 * Serves public/ locally, stubs /api/settings per state, and writes
 * runs/<label>/<state>@<viewport>.png plus manifest.json, app.log and run.json.
 * Refuses to overwrite an existing label. Fails loudly on a bad capture.
 */

const { chromium } = require("playwright")
const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { execSync } = require("node:child_process")

const ROOT = path.resolve(__dirname, "..", "..")
const PUBLIC = path.join(ROOT, "public")
const LABEL = process.argv[2]
if (!LABEL) {
  console.error("usage: capture.cjs <label>")
  process.exit(2)
}
const OUT = path.join(ROOT, "hillclimb", "runs", LABEL)
if (fs.existsSync(OUT)) {
  console.error(`label already exists: ${OUT}`)
  process.exit(1)
}
fs.mkdirSync(OUT, { recursive: true })

const STATES = ["empty", "idle", "active", "waiting", "long", "error"]
const VIEWPORTS = [
  { name: "900x650", width: 900, height: 650 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1600x1000", width: 1600, height: 1000 },
]
const DPR = 2
const PORT = 8788
const BASE = `http://127.0.0.1:${PORT}/`

const settings = {
  workspaceRepo: "https://github.com/chester-hill-solutions/opencode-slack",
  workspaceBranch: "main",
  model: "opencode/deepseek-v4.1-flash",
  pollSeconds: 2,
  streaming: true,
  permissions: {
    allow: [
      "ls *", "cat *", "head *", "tail *", "rg *", "find *", "pwd *", "jq *", "wc *", "file *",
      "git status *", "git diff *", "git log *", "git show *", "git branch *", "bun test *",
      "bun run typecheck *", "node --version *",
    ],
    ask: [],
    deny: [
      "sudo *", "rm -rf *", "git push --force*", "git reset --hard*", "chmod 777 *",
      "curl * | sh", "curl * | bash", "wget * | sh",
    ],
  },
  version: 3,
  updatedAt: 1793920000000,
}

const longSettings = {
  ...settings,
  workspaceRepo:
    "https://github.com/chester-hill-solutions/a-really-long-repository-name-that-keeps-going-and-going-for-layout-testing",
  permissions: {
    allow: Array.from({ length: 40 }, (_, i) => `command-${i} --with-a-long-flag *`),
    ask: ["git push *"],
    deny: ["sudo *", "rm -rf *"],
  },
  version: 7,
}

function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

async function main() {
  const server = http.createServer((req, res) => {
    const name = req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]).slice(1)
    const file = path.join(PUBLIC, name)
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
      res.writeHead(404)
      return res.end("not found")
    }
    res.writeHead(200, {
      "content-type": ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" })[path.extname(name)] ?? "application/octet-stream",
    })
    res.end(fs.readFileSync(file))
  })
  await new Promise((resolve, reject) => server.once("error", reject).listen(PORT, "127.0.0.1", resolve))

  const browser = await chromium.launch({ channel: "chrome", headless: true })
  const log = []
  const failures = []
  const files = []

  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: DPR,
        locale: "en-CA",
        timezoneId: "America/Toronto",
        colorScheme: "dark",
      })

      for (const state of STATES) {
        const page = await context.newPage()
        page.on("console", (message) => log.push(`${state}@${viewport.name} console ${message.type()}: ${message.text()}`))
        page.on("pageerror", (error) => log.push(`${state}@${viewport.name} pageerror: ${error.message}`))

        await page.route("**/api/settings", async (route) => {
          const request = route.request()
          if (request.method() === "GET") {
            return route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(state === "long" ? longSettings : settings),
            })
          }
          if (state === "waiting") await new Promise((resolve) => setTimeout(resolve, 1500))
          if (state === "error") {
            return route.fulfill({
              status: 400,
              contentType: "application/json",
              body: JSON.stringify({ error: "model must be provider/model or provider/model#variant" }),
            })
          }
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ...settings, version: settings.version + 1, updatedAt: 1793920000000 }),
          })
        })

        await page.addInitScript(({ token }) => {
          if (token) localStorage.setItem("cfopencode.token", token)
        }, { token: state === "empty" ? "" : "fixture-token" })

        await page.goto(BASE, { waitUntil: "domcontentloaded" })
        await page.addStyleTag({
          content: "*{transition:none!important;animation:none!important;caret-color:transparent!important}",
        })
        await page.evaluate(() => document.fonts.ready)

        if (state !== "empty") {
          await page.waitForFunction(
            () => document.getElementById("status")?.textContent === "loaded",
            null,
            { timeout: 5000 },
          )
        }

        if (state === "active") {
          await page.fill("#workspaceBranch", "feature/settings-panel")
          await page.focus("#workspaceBranch")
        }

        if (state === "waiting" || state === "error") {
          await page.click('button[type="submit"]')
          if (state === "waiting") {
            await page.waitForTimeout(300)
          } else {
            await page.waitForFunction(
              () => document.getElementById("status")?.classList.contains("error"),
              null,
              { timeout: 5000 },
            )
          }
        }

        await page.evaluate(() => window.scrollTo(0, 0))
        const file = path.join(OUT, `${state}@${viewport.name}.png`)
        await page.screenshot({ path: file, animations: "disabled" })

        const buffer = fs.readFileSync(file)
        const size = pngSize(buffer)
        const expected = { width: viewport.width * DPR, height: viewport.height * DPR }
        if (size.width !== expected.width || size.height !== expected.height) {
          failures.push(`${state}@${viewport.name}: ${size.width}x${size.height}, expected ${expected.width}x${expected.height}`)
        }
        if (buffer.length < 20000) failures.push(`${state}@${viewport.name}: only ${buffer.length} bytes`)

        files.push({
          state,
          viewport: viewport.name,
          file: path.basename(file),
          bytes: buffer.length,
          width: size.width,
          height: size.height,
          dpr: DPR,
        })
        await page.close()
      }
      await context.close()
    }
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }

  const expected = STATES.length * VIEWPORTS.length
  if (files.length !== expected) failures.push(`captured ${files.length} of ${expected} shots`)

  const manifest = {
    label: LABEL,
    states: STATES,
    viewports: VIEWPORTS.map((viewport) => viewport.name),
    dpr: DPR,
    expected,
    captures: files.length,
    failures,
    files,
  }
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2))
  fs.writeFileSync(path.join(OUT, "app.log"), log.join("\n") + "\n")

  const harness = {}
  for (const rel of ["hillclimb/harness/capture.cjs", "hillclimb/RUBRIC.md", "hillclimb/harness/console-patterns.txt"]) {
    harness[rel] = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex")
  }
  let git = {}
  try {
    git = {
      commit: execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim(),
      dirty: execSync("git status --porcelain", { cwd: ROOT }).toString().trim().split("\n").filter(Boolean),
    }
  } catch {
    /* not a git checkout */
  }
  fs.writeFileSync(
    path.join(OUT, "run.json"),
    JSON.stringify(
      { label: LABEL, at: new Date().toISOString(), harness, git, viewports: VIEWPORTS, states: STATES, dpr: DPR },
      null,
      2,
    ),
  )

  if (failures.length) {
    console.error("capture failed:")
    for (const failure of failures) console.error("  " + failure)
    process.exitCode = 1
  } else {
    console.log(`captured ${files.length} shots → ${OUT}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

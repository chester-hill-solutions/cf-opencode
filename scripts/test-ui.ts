import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { chromium, type Page } from "playwright"
import { defaultSettings, type HarnessSettings } from "../src/settings"
import { MODEL_CATALOG, recommendModel } from "../src/models"
import { staticAsset } from "./ui-server"

const fixture: HarnessSettings = {
  ...defaultSettings({ WORKSPACE_REPO: "https://github.com/example/aboiteau" }),
  version: 3,
}
let mode = "normal"
let puts: unknown[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith("/api/")) return staticAsset(request)
    if (request.headers.get("authorization") !== "Bearer fixture-token")
      return Response.json({ error: "unauthorized" }, { status: 401 })
    if (url.pathname === "/api/models")
      return mode === "catalogue-unavailable"
        ? Response.json({ error: "unavailable" }, { status: 503 })
        : Response.json({ models: MODEL_CATALOG, recommended: recommendModel().ref })
    if (request.method === "GET")
      return Response.json(
        mode === "bootstrap" ? { ...fixture, workspaceRepo: "", workspaceBranch: "" } : fixture
      )
    const payload = await request.json()
    puts.push(payload)
    if (mode === "saving") await new Promise((resolve) => setTimeout(resolve, 600))
    if (mode === "save-error")
      return Response.json({ error: "workspaceBranch was rejected by the server" }, { status: 400 })
    return Response.json({ ...payload, version: fixture.version + 1, updatedAt: 1793970000000 })
  },
})
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
})
const output = "hillclimb/runs/aboiteau-settings-v1"
await mkdir(output, { recursive: true })
let passed = 0

async function status(page: Page, value: string) {
  await page.waitForFunction(
    (text) => document.getElementById("status")?.textContent === text,
    value
  )
}

async function test(name: string, run: (page: Page) => Promise<void>, token = true) {
  mode = "normal"
  puts = []
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    locale: "en-CA",
    timezoneId: "America/Toronto",
  })
  if (token)
    await context.addInitScript(() => localStorage.setItem("cfopencode.token", "fixture-token"))
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await run(page)
    assert.deepEqual(errors, [], "Uncaught browser errors")
    passed++
    console.log("PASS " + name)
  } finally {
    await context.close()
  }
}

try {
  await test(
    "empty state and keyboard connection",
    async (page) => {
      await page.goto(server.url.href)
      await page.getByLabel("API token", { exact: true }).waitFor()
      assert(await page.getByRole("button", { name: "Save settings" }).isDisabled())
      assert(await page.getByLabel("Repository URL").isDisabled())
      await page.getByLabel("API token", { exact: true }).fill("fixture-token")
      await page.getByLabel("API token", { exact: true }).press("Tab")
      assert.equal(await page.locator(":focus").getAttribute("id"), "load")
      await page.keyboard.press("Enter")
      await status(page, "loaded")
      assert.equal(await page.getByLabel("Repository URL").inputValue(), fixture.workspaceRepo)
    },
    false
  )
  await test(
    "token rejection has a recovery path",
    async (page) => {
      await page.goto(server.url.href)
      await page.getByLabel("API token", { exact: true }).fill("bad-token")
      await page.getByRole("button", { name: "Load settings" }).click()
      await status(page, "load failed")
      assert(await page.getByText("The API token was rejected.", { exact: false }).isVisible())
      await page.getByLabel("API token", { exact: true }).fill("fixture-token")
      await page.getByRole("button", { name: "Load settings" }).click()
      await status(page, "loaded")
    },
    false
  )
  await test("load, dirty state, pending state and complete save payload", async (page) => {
    await page.goto(server.url.href)
    await status(page, "loaded")
    await page.getByLabel("Branch", { exact: true }).fill("feature/aboiteau")
    await status(page, "unsaved changes")
    assert(await page.getByRole("button", { name: "Load settings" }).isDisabled())
    mode = "saving"
    await page.getByRole("button", { name: "Save settings" }).click()
    await status(page, "saving…")
    assert(await page.locator("#save").isDisabled())
    assert(await page.getByLabel("Branch", { exact: true }).isDisabled())
    await status(page, "saved")
    assert.deepEqual(puts, [
      {
        workspaceRepo: fixture.workspaceRepo,
        workspaceBranch: "feature/aboiteau",
        model: fixture.model,
        pollSeconds: 2,
        streaming: true,
        permissions: fixture.permissions,
      },
    ])
    assert.equal(await page.locator("#meta").textContent(), "v4")
  })
  await test("custom models, checkboxes and permission patterns", async (page) => {
    await page.goto(server.url.href)
    await status(page, "loaded")
    await page.locator("#modelSelect").selectOption("__custom")
    await page.getByLabel("Custom model reference").fill("provider/custom#fast")
    const streaming = page.getByRole("checkbox", { name: "Stream progress" })
    await streaming.focus()
    await streaming.press("Space")
    assert(!(await streaming.isChecked()))
    await page.locator('[data-slot="checkbox"]').filter({ hasText: "Stream progress" }).click()
    assert(await streaming.isChecked())
    await streaming.focus()
    await streaming.press("Space")
    await page.getByLabel("Ask", { exact: true }).fill("  git push * \n\n bun add *  ")
    await page.getByRole("button", { name: "Save settings" }).click()
    await status(page, "saved")
    const body = puts[0] as HarnessSettings
    assert.equal(body.model, "provider/custom#fast")
    assert.equal(body.streaming, false)
    assert.deepEqual(body.permissions.ask, ["git push *", "bun add *"])
  })
  await test("save errors retain edits and allow retry", async (page) => {
    await page.goto(server.url.href)
    await status(page, "loaded")
    await page.getByLabel("Branch", { exact: true }).fill("keep-my-draft")
    mode = "save-error"
    await page.getByRole("button", { name: "Save settings" }).click()
    await status(page, "save failed")
    assert.equal(await page.getByLabel("Branch", { exact: true }).inputValue(), "keep-my-draft")
    assert.equal(
      await page.getByLabel("Branch", { exact: true }).getAttribute("aria-invalid"),
      "true"
    )
    assert(await page.locator("#errorDetail").isVisible())
    mode = "normal"
    await page.getByRole("button", { name: "Save settings" }).click()
    await status(page, "saved")
  })
  await test("network failures retain edits", async (page) => {
    await page.goto(server.url.href)
    await status(page, "loaded")
    await page.getByLabel("Branch", { exact: true }).fill("still-here")
    await page.route("**/api/settings", (route) =>
      route.request().method() === "PUT" ? route.abort("failed") : route.continue()
    )
    await page.getByRole("button", { name: "Save settings" }).click()
    await status(page, "connection unavailable")
    assert.equal(await page.getByLabel("Branch", { exact: true }).inputValue(), "still-here")
    assert(await page.getByText("Your changes are still here.", { exact: false }).isVisible())
  })
  await test("credentials can be corrected without losing an unsaved draft", async (page) => {
    await page.goto(server.url.href)
    await status(page, "loaded")
    await page.getByLabel("Branch", { exact: true }).fill("keep-after-token-error")
    await page.getByLabel("API token", { exact: true }).fill("expired-token")
    await page.getByRole("button", { name: "Save settings" }).click()
    await status(page, "save failed")
    await page.getByLabel("API token", { exact: true }).fill("fixture-token")
    await page.getByRole("button", { name: "Save settings" }).click()
    await status(page, "saved")
    assert.equal(
      await page.getByLabel("Branch", { exact: true }).inputValue(),
      "keep-after-token-error"
    )
  })
  await test("catalogue failure keeps the free-form model available", async (page) => {
    mode = "catalogue-unavailable"
    await page.goto(server.url.href)
    await status(page, "loaded")
    await page.getByLabel("Model reference", { exact: true }).fill("provider/available-model")
    assert(await page.getByText("Model catalogue unavailable.", { exact: false }).isVisible())
    await page.getByRole("button", { name: "Save settings" }).click()
    await status(page, "saved")
    assert.equal((puts[0] as HarnessSettings).model, "provider/available-model")
  })
  await test("incomplete deployment defaults can be configured", async (page) => {
    mode = "bootstrap"
    await page.goto(server.url.href)
    await status(page, "loaded")
    assert(!(await page.getByLabel("Repository URL").isDisabled()))
    await page.getByLabel("Repository URL").fill("https://github.com/example/new-repo")
    await page.getByLabel("Branch", { exact: true }).fill("main")
    await page.getByRole("button", { name: "Save settings" }).click()
    await status(page, "saved")
  })
  await test("desktop, mobile, zoom and the component gallery", async (page) => {
    await page.goto(server.url.href)
    await status(page, "loaded")
    await page.evaluate(() => document.fonts.ready)
    assert.equal(
      await page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgb(248, 244, 236)"
    )
    const saveBox = await page.getByRole("button", { name: "Save settings" }).boundingBox()
    assert(saveBox && saveBox.y >= 0 && saveBox.y + saveBox.height <= 1100)
    await page.screenshot({ path: output + "/settings-desktop.png", animations: "disabled" })
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        "Horizontal overflow at " + width
      )
      const footer = await page.locator(".save-footer").boundingBox()
      assert(footer && footer.y + footer.height <= 845)
      await page.getByLabel("Deny", { exact: true }).scrollIntoViewIfNeeded()
      const field = await page.getByLabel("Deny", { exact: true }).boundingBox()
      assert(field && footer && field.y + field.height <= footer.y, "Last field overlaps save bar")
      if (width === 390) {
        await page.evaluate(() => window.scrollTo(0, 0))
        await page.screenshot({ path: output + "/settings-mobile.png", animations: "disabled" })
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.addStyleTag({ content: "html{font-size:32px}" })
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      "Horizontal overflow at 200% text size"
    )
    await page.goto(new URL("ui-kit/", server.url).href)
    await page.getByRole("heading", { name: "Room to build." }).waitFor()
    await page.getByRole("button", { name: "Primary action", exact: true }).click()
    assert(await page.getByText("Primary action selected", { exact: true }).isVisible())
    await page.setViewportSize({ width: 1440, height: 1100 })
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: output + "/ui-kit-desktop.png", animations: "disabled" })
  })
  console.log(passed + " browser checks passed. Screenshots: " + output)
} finally {
  await browser.close()
  server.stop(true)
}

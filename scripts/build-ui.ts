import { copyFile, mkdir, readdir, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { logoPaths, logoViewBox } from "../packages/ui/src/brand"

const root = resolve(import.meta.dir, "..")
const output = resolve(root, "public")
// This directory is generated and ignored; do not upload stale hashed chunks.
await rm(resolve(output, "assets"), { recursive: true, force: true })
await mkdir(resolve(output, "assets"), { recursive: true })
await mkdir(resolve(output, "brand"), { recursive: true })
await mkdir(resolve(output, "onboarding"), { recursive: true })
await mkdir(resolve(output, "ui-kit"), { recursive: true })

const entries = [
  resolve(root, "web/settings.tsx"),
  resolve(root, "web/ui-kit.tsx"),
  resolve(root, "web/onboarding.tsx"),
]
// One bundle per page: a shared chunk would make the settings page download the
// gallery's chart, carousel and overlay dependencies.
const builds = await Promise.all(
  entries.map((entrypoint) =>
    Bun.build({
      entrypoints: [entrypoint],
      outdir: resolve(output, "assets"),
      target: "browser",
      format: "esm",
      splitting: false,
      minify: true,
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    })
  )
)
for (const build of builds) {
  if (!build.success) throw new AggregateError(build.logs, "UI JavaScript build failed")
}

const css = Bun.spawnSync(
  [
    process.execPath,
    resolve(root, "node_modules/@tailwindcss/cli/dist/index.mjs"),
    "-i",
    resolve(root, "web/styles.css"),
    "-o",
    resolve(output, "assets/styles.css"),
    "--minify",
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" }
)
if (css.exitCode !== 0) throw new Error("UI CSS build failed")

await Promise.all([
  copyFile(resolve(root, "web/index.html"), resolve(output, "index.html")),
  copyFile(resolve(root, "web/ui-kit.html"), resolve(output, "ui-kit/index.html")),
  copyFile(resolve(root, "web/onboarding.html"), resolve(output, "onboarding/index.html")),
  copyFile(
    resolve(
      root,
      "node_modules/@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2"
    ),
    resolve(output, "brand/dm-sans-latin-variable.woff2")
  ),
  copyFile(
    resolve(root, "node_modules/@fontsource-variable/dm-sans/LICENSE"),
    resolve(output, "brand/DM-Sans-LICENSE.txt")
  ),
])
for (const file of await readdir(resolve(root, "packages/ui/assets"))) {
  if (file === "logo-approved-reference.png") continue
  await copyFile(resolve(root, "packages/ui/assets", file), resolve(output, "brand", file))
}
await Bun.write(
  resolve(output, "brand/logo.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
    logoViewBox +
    '" fill="#1746D1"><title>Aboiteau</title>' +
    logoPaths.map((path) => '<path d="' + path + '"/>').join("") +
    "</svg>\n"
)
console.log("Built Aboiteau settings, UI kit and brand assets in public/.")

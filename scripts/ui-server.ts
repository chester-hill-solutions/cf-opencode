import { resolve, sep } from "node:path"

const publicRoot = resolve(import.meta.dir, "../public")

/** Static development/test host; API requests stay host-owned. */
export function staticAsset(request: Request): Response | Promise<Response> {
  const url = new URL(request.url)
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return new Response("Bad path", { status: 400 })
  }
  if (pathname.endsWith("/")) pathname += "index.html"
  if (pathname === "/ui-kit") pathname = "/ui-kit/index.html"
  const path = resolve(publicRoot, "." + pathname)
  if (!path.startsWith(publicRoot + sep)) return new Response("Not found", { status: 404 })
  const file = Bun.file(path)
  return file
    .exists()
    .then((exists) => (exists ? new Response(file) : new Response("Not found", { status: 404 })))
}

export type QualificationRoute =
  | { kind: "prepare" }
  | { kind: "cleanup" }
  | { kind: "core"; path: "/context" | "/debug" }

/** Resolve only the four fixed public routes used by the isolated fixture. */
export function resolveQualificationRoute(pathname: string, method: string): QualificationRoute | undefined {
  if (method === "POST" && pathname === "/prepare") return { kind: "prepare" }
  if (method === "POST" && pathname === "/cleanup") return { kind: "cleanup" }
  if (method === "GET" && pathname === "/api/conversations/lifecycle-idle-qualification/context") {
    return { kind: "core", path: "/context" }
  }
  if (method === "GET" && pathname === "/api/conversations/lifecycle-idle-qualification/debug") {
    return { kind: "core", path: "/debug" }
  }
  return undefined
}

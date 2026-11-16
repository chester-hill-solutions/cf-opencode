export const TOKEN_KEY = "cfopencode.token"

export function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ""
  } catch {
    return ""
  }
}

export function rememberToken(token: string): boolean {
  try {
    localStorage.setItem(TOKEN_KEY, token)
    return true
  } catch {
    return false
  }
}

export async function api<T>(
  token: string,
  path: string,
  init?: {
    method?: string
    body?: unknown
    signal?: AbortSignal
  }
): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
      headers: {
        authorization: "Bearer " + token,
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: init?.signal ?? AbortSignal.timeout(60000),
      cache: "no-store",
    })
  } catch (cause) {
    if (init?.signal?.aborted) throw cause
    throw new Error("Couldn’t reach Aboiteau. Check your connection and try again.")
  }
  const payload: unknown = await response.json().catch(() => null)
  if (response.status === 401)
    throw new Error("The API token was rejected. Check the token and try again.")
  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "error" in payload ? payload.error : null
    throw new Error(
      typeof detail === "string" ? detail : `Request failed (${response.status}). Try again.`
    )
  }
  if (payload === null) throw new Error("The server returned an unreadable response. Try again.")
  return payload as T
}

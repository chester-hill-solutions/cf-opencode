import { describe, expect, test } from "bun:test"
import {
  answerHint,
  describeAnswer,
  describeForm,
  formButtons,
  parseFormAnswer,
  type Form,
} from "../src/slack-forms"

const chooseRepo: Form = {
  id: "frm_1",
  sessionID: "ses_1",
  title: "Which repository?",
  fields: [
    {
      key: "repo",
      type: "string",
      title: "Repository",
      required: true,
      options: [
        { value: "callcaster", label: "CallCaster" },
        { value: "opencode-slack", label: "OpenCode Slack" },
      ],
    },
  ],
}

const confirm: Form = {
  id: "frm_2",
  title: "Continue?",
  fields: [{ key: "go", type: "boolean", title: "Continue", required: true }],
}

const details: Form = {
  id: "frm_3",
  title: "Branch details",
  fields: [
    { key: "branch", type: "string", title: "Branch", required: true },
    { key: "count", type: "integer", title: "Commits", required: false, minimum: 1, maximum: 10 },
    { key: "hidden", type: "string", hidden: true },
  ],
}

describe("describeForm", () => {
  test("renders title, fields, flags and options", () => {
    const out = describeForm(chooseRepo)
    expect(out).toContain("❓ *Which repository?*")
    expect(out).toContain("`repo` — *Repository* _(string, required)_")
    expect(out).toContain("1) `callcaster` CallCaster")
    expect(out).toContain("2) `opencode-slack` OpenCode Slack")
  })

  test("hides hidden fields", () => {
    expect(describeForm(details)).not.toContain("hidden")
  })
})

describe("answerHint", () => {
  test("suggests buttons for option fields and key=value for multi-field forms", () => {
    expect(answerHint(chooseRepo)).toContain("!answer <option>")
    expect(answerHint(chooseRepo)).toContain("!cancel")
    expect(answerHint(confirm)).toContain("!answer yes")
    expect(answerHint(confirm)).toContain("!cancel")
    expect(answerHint(details)).toContain("key=value")
  })
})

describe("formButtons", () => {
  test("builds one button per option with a typed payload", () => {
    const buttons = formButtons(chooseRepo)
    expect(buttons.map((button) => button.text)).toEqual(["CallCaster", "OpenCode Slack"])
    expect(JSON.parse(buttons[0]!.value)).toEqual({ field: "repo", value: "callcaster" })
  })

  test("builds Yes/No for a boolean field", () => {
    expect(formButtons(confirm).map((button) => button.text)).toEqual(["Yes", "No"])
    expect(JSON.parse(formButtons(confirm)[0]!.value)).toEqual({ field: "go", value: true })
  })

  test("refuses buttons for multi-field forms", () => {
    expect(formButtons(details)).toEqual([])
  })
})

describe("parseFormAnswer", () => {
  test("accepts an option value, its label, or its number", () => {
    expect(parseFormAnswer(chooseRepo, "callcaster")).toEqual({ ok: true, answer: { repo: "callcaster" } })
    expect(parseFormAnswer(chooseRepo, "OpenCode Slack")).toEqual({ ok: true, answer: { repo: "opencode-slack" } })
    expect(parseFormAnswer(chooseRepo, "2")).toEqual({ ok: true, answer: { repo: "opencode-slack" } })
  })

  test("rejects an option that is not offered", () => {
    const result = parseFormAnswer(chooseRepo, "nope")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("expects one of")
  })

  test("coerces booleans", () => {
    expect(parseFormAnswer(confirm, "yes")).toEqual({ ok: true, answer: { go: true } })
    expect(parseFormAnswer(confirm, "n")).toEqual({ ok: true, answer: { go: false } })
    expect(parseFormAnswer(confirm, "maybe").ok).toBe(false)
  })

  test("parses key=value pairs for multi-field forms and enforces bounds", () => {
    expect(parseFormAnswer(details, "branch=main, count=3")).toEqual({
      ok: true,
      answer: { branch: "main", count: 3 },
    })
    const tooBig = parseFormAnswer(details, "branch=main\ncount=99")
    expect(tooBig.ok).toBe(false)
    if (!tooBig.ok) expect(tooBig.error).toContain("at most 10")
  })

  test("reports unknown and missing fields", () => {
    const unknown = parseFormAnswer(details, "nope=1")
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toContain("Unknown field")

    const missing = parseFormAnswer(details, "count=2")
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toContain("Missing required: branch")
  })

  test("accepts multi-select as a list of options", () => {
    const multi: Form = {
      id: "frm_4",
      title: "Pick reviewers",
      fields: [
        {
          key: "people",
          type: "multiselect",
          options: [
            { value: "ann", label: "Ann" },
            { value: "bo", label: "Bo" },
          ],
        },
      ],
    }
    expect(parseFormAnswer(multi, "ann, Bo")).toEqual({ ok: true, answer: { people: ["ann", "bo"] } })
  })

  test("rejects external fields, which are answered elsewhere", () => {
    const external: Form = {
      id: "frm_5",
      title: "Authorise",
      fields: [{ key: "oauth", type: "external", url: "https://example.test/auth" }],
    }
    const result = parseFormAnswer(external, "anything")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("https://example.test/auth")
  })
})

describe("describeAnswer", () => {
  test("labels values with their field titles", () => {
    expect(describeAnswer({ repo: "callcaster" }, chooseRepo.fields)).toBe("Repository: `callcaster`")
  })
})

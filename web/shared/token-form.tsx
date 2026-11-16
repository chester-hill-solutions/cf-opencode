import { useId } from "react"
import { Button, Field, FieldDescription, FieldLabel, Input } from "@aboiteau/ui"

export function TokenForm({
  token,
  setToken,
  connect,
  pending,
  label = "Connect workspace",
}: {
  token: string
  setToken: (value: string) => void
  connect: () => void
  pending: boolean
  label?: string
}) {
  const id = useId()
  return (
    <form
      className="token-form"
      onSubmit={(event) => {
        event.preventDefault()
        connect()
      }}
    >
      <Field>
        <FieldLabel htmlFor={id}>Deployment API token (required)</FieldLabel>
        <Input
          id={id}
          name="token"
          type="password"
          required
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          value={token}
          disabled={pending}
          aria-describedby={id + "-hint"}
          onChange={(event) => setToken(event.target.value)}
        />
        <FieldDescription id={id + "-hint"}>
          Use the API token from your Aboiteau deployment. After connecting, it is remembered on
          this browser. Use a trusted device.
        </FieldDescription>
      </Field>
      <Button type="submit" pending={pending} pendingLabel="Connecting…">
        {label}
      </Button>
    </form>
  )
}

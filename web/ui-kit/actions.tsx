import { useState } from "react"
import {
  BulkActionBar,
  Button,
  ButtonGroup,
  Kbd,
  KbdGroup,
  LinkButton,
  ListItemActions,
  SaveBar,
  Toggle,
  ToggleGroup,
  ToggleGroupItem,
  Toolbar,
} from "@aboiteau/ui"
import { Demo, GallerySection, Row } from "./shared"

export function Actions() {
  const [dirty, setDirty] = useState(true)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState("Ready to try")

  return (
    <GallerySection
      id="actions"
      number="04"
      accent="ultramarine"
      title="Actions"
      description="Ultramarine carries the primary action. Every control has a complete border, visible focus and a target of at least 44px on touch."
    >
      <Demo
        name="Button"
        note="Seven variants, ten sizes, a pending state and a disabled state."
        wide
      >
        <Row>
          <Button onPress={() => setMessage("Primary action selected")}>Primary</Button>
          <Button variant="outline" onPress={() => setMessage("Secondary selected")}>
            Secondary
          </Button>
          <Button variant="secondary">Tertiary</Button>
          <Button variant="ghost">Quiet</Button>
          <Button variant="destructive">Delete</Button>
          <Button variant="destructive-outline">Delete safely</Button>
          <Button variant="link">Read more</Button>
          <Button isDisabled>Unavailable</Button>
        </Row>
        <Row>
          <Button size="xs">Extra small</Button>
          <Button size="sm">Small</Button>
          <Button>Default</Button>
          <Button size="lg">Large</Button>
          <Button size="touch">Touch target</Button>
          <Button size="icon" aria-label="Icon action">
            +
          </Button>
        </Row>
        <Row>
          <Button
            pending={pending}
            pendingLabel="Saving…"
            onPress={() => {
              setPending(true)
              setMessage("Saving example…")
              window.setTimeout(() => {
                setPending(false)
                setMessage("Example saved")
              }, 1200)
            }}
          >
            Try pending state
          </Button>
          <LinkButton href="/">Link that looks like a button</LinkButton>
          <span className="catalog-note" role="status" aria-live="polite" style={{ margin: 0 }}>
            {message}
          </span>
        </Row>
      </Demo>

      <Demo name="Button group" note="Related actions share one visual edge.">
        <ButtonGroup>
          <Button variant="outline">Day</Button>
          <Button variant="outline">Week</Button>
          <Button variant="outline">Month</Button>
        </ButtonGroup>
      </Demo>

      <Demo name="Toggle & toggle group">
        <Toggle defaultSelected>Pin</Toggle>
        <ToggleGroup selectionMode="multiple" defaultSelectedKeys={["bold"]}>
          <ToggleGroupItem id="bold">Bold</ToggleGroupItem>
          <ToggleGroupItem id="italic">Italic</ToggleGroupItem>
          <ToggleGroupItem id="underline">Underline</ToggleGroupItem>
        </ToggleGroup>
      </Demo>

      <Demo name="Toolbar" note="Content on the left, actions on the right." wide>
        <Toolbar
          actions={
            <>
              <Button variant="outline">Reset</Button>
              <Button>Apply</Button>
            </>
          }
        >
          <Button variant="outline">Filter</Button>
          <Button variant="outline">Sort</Button>
          <span className="catalog-note" style={{ margin: 0 }}>
            3 of 12 records shown
          </span>
        </Toolbar>
      </Demo>

      <Demo name="Save bar" note="Persistent feedback while a form is dirty." wide>
        <div style={{ width: "100%" }}>
          <SaveBar
            isDirty={dirty}
            isPending={pending}
            onSave={() => {
              setPending(true)
              window.setTimeout(() => {
                setPending(false)
                setDirty(false)
              }, 900)
            }}
            onReset={() => setDirty(false)}
          />
          {!dirty ? (
            <Button variant="outline" onPress={() => setDirty(true)}>
              Make the form dirty again
            </Button>
          ) : null}
        </div>
      </Demo>

      <Demo name="Bulk action bar" note="Appears only while a selection exists." wide>
        <div style={{ width: "100%" }}>
          <BulkActionBar
            count={3}
            onClear={() => undefined}
            actions={
              <>
                <Button variant="outline" size="sm">
                  Archive
                </Button>
                <Button variant="destructive" size="sm">
                  Delete
                </Button>
              </>
            }
          />
        </div>
      </Demo>

      <Demo name="List item actions" note="Move and remove controls for ordered items.">
        <ListItemActions
          label="Rule"
          isFirst={false}
          isLast={false}
          onMove={() => undefined}
          onRemove={() => undefined}
        />
      </Demo>

      <Demo name="Keyboard hints">
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
        <Kbd>Esc</Kbd>
        <Kbd>↵</Kbd>
      </Demo>
    </GallerySection>
  )
}

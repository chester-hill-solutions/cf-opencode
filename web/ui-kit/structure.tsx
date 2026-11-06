import {
  AspectRatio,
  Badge,
  Marker,
  PageHeader,
  PageSection,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  ScrollArea,
  Separator,
} from "@aboiteau/ui"
import { Demo, GallerySection, Row } from "./shared"

export function Structure() {
  return (
    <GallerySection
      id="structure"
      number="09"
      accent="ink"
      title="Page structure"
      description="Small layout primitives and the shared page frame. These keep reading surfaces quiet and boundaries explicit."
    >
      <Demo name="Page header" wide>
        <PageHeader
          headingLevel="h2"
          eyebrow="Aboiteau / workspace"
          title="Settings"
          description="Connect a repository, choose a model and review what the agent may run."
          meta={
            <>
              <Badge variant="outline">Global</Badge>
              <span>Version 7</span>
            </>
          }
          actions={<Badge variant="secondary">Saved</Badge>}
          back={
            <a href="#top" className="text-sm">
              ← Back to workspace
            </a>
          }
        />
      </Demo>

      <Demo name="Page section" wide>
        <PageSection
          title="Runtime"
          description="Changes restart the container on the next turn."
          actions={<Badge variant="outline">2 fields</Badge>}
          variant="card"
        >
          <p className="text-sm text-muted-foreground">
            The workspace is restored from its checkpoint before the container starts.
          </p>
        </PageSection>
      </Demo>

      <Demo name="Separator">
        <div className="grid w-full gap-3 text-sm">
          <span>Above</span>
          <Separator />
          <span>Below</span>
        </div>
      </Demo>

      <Demo name="Marker">
        <div className="grid w-full gap-1">
          <Marker variant="bordered">3 unsaved changes</Marker>
          <Marker variant="status">Checkpoint ready</Marker>
          <Marker variant="separator">or</Marker>
        </div>
      </Demo>

      <Demo name="Aspect ratio">
        <AspectRatio ratio={16 / 9} className="w-full overflow-hidden rounded-md bg-muted">
          <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
            16 : 9
          </div>
        </AspectRatio>
      </Demo>

      <Demo name="Scroll area">
        <ScrollArea className="h-32 w-full rounded-md border border-border p-3">
          <div className="grid gap-2 text-sm text-muted-foreground">
            {Array.from({ length: 10 }, (_, index) => (
              <p key={index} className="m-0">
                Line {index + 1} — the scroll area keeps a long surface inside its boundary.
              </p>
            ))}
          </div>
        </ScrollArea>
      </Demo>

      <Demo name="Resizable panels" wide>
        <div className="h-40 w-full overflow-hidden rounded-md border border-border">
          <ResizablePanelGroup>
            <ResizablePanel defaultSize={40}>
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Workspace
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={60}>
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Agent output
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </Demo>

      <Demo name="Row rhythm" wide surface={false}>
        <Row>
          <span className="catalog-note" style={{ margin: 0 }}>
            The specimen row wraps at narrow widths and keeps a consistent gap.
          </span>
        </Row>
      </Demo>
    </GallerySection>
  )
}

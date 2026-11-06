import { useState } from "react"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  AlertDescription,
  AlertTitle,
  Attachment,
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  Badge,
  Bubble,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  Checklist,
  CodeBlock,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DataTable,
  DataTablePagination,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
  Message,
  MessageScroller,
  MetricCard,
  Progress,
  ProgressLabel,
  ProgressValue,
  Skeleton,
  Spinner,
  Status,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  Toaster,
  Trace,
  type ChartConfig,
  type DataTableColumn,
  type TraceStep,
} from "@aboiteau/ui"
import { DatabaseIcon, PackageIcon, SearchIcon } from "lucide-react"
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts"
import { Demo, GallerySection, Row, Stack } from "./shared"

const people = [
  { id: "a", name: "Alex Martin", team: "Operations" },
  { id: "b", name: "Sam Chen", team: "Design" },
  { id: "c", name: "Robin Roy", team: "Engineering" },
]

const columns: DataTableColumn<(typeof people)[number]>[] = [
  { id: "name", header: "Name", cell: (person) => person.name, allowsSorting: true },
  { id: "team", header: "Team", cell: (person) => person.team },
]

const adoptionData = [
  { component: "Button", apps: 12 },
  { component: "Input", apps: 10 },
  { component: "Dialog", apps: 7 },
  { component: "Table", apps: 6 },
  { component: "Toggle", apps: 4 },
]

const adoptionConfig = {
  apps: { label: "Apps using", color: "var(--chart-1)" },
} satisfies ChartConfig

const traceSteps: TraceStep[] = [
  {
    id: "inspect",
    label: "Inspect source files",
    description: "Component contracts and theme tokens",
    meta: "3 files",
    status: "complete",
  },
  {
    id: "build",
    label: "Build component preview",
    description: "Compile the preview assets",
    status: "running",
  },
  {
    id: "review",
    label: "Prepare review",
    description: "Theme and accessibility samples",
    status: "pending",
  },
]

const releaseNotes = [
  { version: "0.1.0", note: "Buttons, inputs and the token pipeline" },
  { version: "0.2.0", note: "Data display: table, chart, progress" },
  { version: "0.3.0", note: "Carousel, toggle group, button group" },
  { version: "0.4.0", note: "Every CHS primitive, one package" },
]

export function DataDisplay() {
  const [page, setPage] = useState(0)

  return (
    <GallerySection
      id="data"
      number="08"
      accent="vermilion"
      title="Data display"
      description="Cards, status, tables, charts and progress. Colour supports the written label; it never replaces it."
    >
      <Demo name="Card">
        <Card>
          <CardHeader>
            <CardTitle>Workspace checkpoint</CardTitle>
            <CardDescription>Last settled turn, 14:32</CardDescription>
            <CardAction>
              <Badge variant="outline">R2</Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Dependencies are excluded. WAL is flushed before the archive.
            </p>
          </CardContent>
          <CardFooter className="gap-2">
            <Badge variant="secondary">42 MB</Badge>
            <Badge variant="outline">tar.gz</Badge>
          </CardFooter>
        </Card>
      </Demo>

      <Demo name="Alert">
        <Stack>
          <Alert variant="info" role="note">
            <AlertTitle>Changes apply on the next turn</AlertTitle>
            <AlertDescription>Your workspace is restored when the container restarts.</AlertDescription>
          </Alert>
          <Alert variant="destructive" role="note">
            <AlertTitle>Couldn’t save settings</AlertTitle>
            <AlertDescription>
              Your changes are still here. Check the connection and try again.
            </AlertDescription>
          </Alert>
        </Stack>
      </Demo>

      <Demo name="Badge & status">
        <Stack>
          <Row>
            <Badge>Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="destructive">Destructive</Badge>
            <Badge variant="ghost">Ghost</Badge>
            <Badge variant="link">Link</Badge>
          </Row>
          <Row>
            <Status>Not loaded</Status>
            <Status tone="success">Saved</Status>
            <Status tone="warning">Unsaved changes</Status>
            <Status tone="busy">Saving…</Status>
            <Status tone="error">Save failed</Status>
          </Row>
          <Row>
            <StatusBadge tone="ok">Ready</StatusBadge>
            <StatusBadge tone="warn">Provisioning</StatusBadge>
            <StatusBadge tone="danger">Blocked</StatusBadge>
            <StatusBadge tone="action">Running</StatusBadge>
            <StatusBadge status="completed" />
          </Row>
        </Stack>
      </Demo>

      <Demo name="Avatar">
        <Stack>
          <Row>
            <Avatar>
              <AvatarFallback>SR</AvatarFallback>
            </Avatar>
            <Avatar size="sm">
              <AvatarFallback>KT</AvatarFallback>
            </Avatar>
            <Avatar size="lg">
              <AvatarFallback>AR</AvatarFallback>
              <AvatarBadge aria-label="Online" className="bg-success" />
            </Avatar>
            <AvatarGroup>
              <Avatar>
                <AvatarFallback>AM</AvatarFallback>
              </Avatar>
              <Avatar>
                <AvatarFallback>SC</AvatarFallback>
              </Avatar>
              <AvatarGroupCount>+4</AvatarGroupCount>
            </AvatarGroup>
          </Row>
        </Stack>
      </Demo>

      <Demo name="Skeleton & spinner">
        <Stack>
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="grid gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-28" />
            </div>
          </div>
          <Row>
            <Spinner />
            <span className="text-sm text-muted-foreground">Loading the catalogue…</span>
          </Row>
        </Stack>
      </Demo>

      <Demo name="Metric card & marker" wide>
        <Stack>
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard label="Turn latency (p50)" value="1.2 s" tone="ok" />
            <MetricCard label="Queue depth" value="3" tone="warn" />
            <MetricCard label="Failed turns" value="0" tone="action" />
          </div>
        </Stack>
      </Demo>

      <Demo name="Description list">
        <DescriptionList>
          <DescriptionItem>
            <DescriptionTerm>Workspace</DescriptionTerm>
            <DescriptionDetails>Community organizing and volunteer operations</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>Status</DescriptionTerm>
            <DescriptionDetails>
              <StatusBadge tone="ok">Active</StatusBadge>
            </DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>Owner</DescriptionTerm>
            <DescriptionDetails>
              <a href="mailto:team@example.com" className="underline underline-offset-4">
                team@example.com
              </a>
            </DescriptionDetails>
          </DescriptionItem>
        </DescriptionList>
      </Demo>

      <Demo name="Item" wide>
        <ItemGroup>
          <Item variant="outline">
            <ItemMedia variant="icon">
              <PackageIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>@aboiteau/ui</ItemTitle>
              <ItemDescription>Brand, theme and accessible components.</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button size="sm" variant="outline">
                Publish
              </Button>
            </ItemActions>
          </Item>
          <ItemSeparator />
          <Item variant="muted" size="sm">
            <ItemContent>
              <ItemTitle>Muted row</ItemTitle>
              <ItemDescription>Filled surface for grouped panels.</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Badge variant="outline">sm</Badge>
            </ItemActions>
          </Item>
        </ItemGroup>
      </Demo>

      <Demo name="Empty" wide>
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <DatabaseIcon />
            </EmptyMedia>
            <EmptyTitle>Create your first environment</EmptyTitle>
            <EmptyDescription>
              Environments hold deploy targets and their overrides. Start with staging.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm">New environment</Button>
          </EmptyContent>
        </Empty>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchIcon />
            </EmptyMedia>
            <EmptyTitle>Zero matches for “toast”</EmptyTitle>
            <EmptyDescription>Try “sonner” for toast notifications.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Demo>

      <Demo name="Table" wide>
        <Table aria-label="Recent builds">
          <TableHeader>
            <TableHead isRowHeader>Build</TableHead>
            <TableHead>Branch</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Duration</TableHead>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>#4821</TableCell>
              <TableCell>main</TableCell>
              <TableCell>
                <Badge variant="secondary">Passed</Badge>
              </TableCell>
              <TableCell className="text-right">1m 42s</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>#4820</TableCell>
              <TableCell>tokens/radius-scale</TableCell>
              <TableCell>
                <Badge variant="secondary">Passed</Badge>
              </TableCell>
              <TableCell className="text-right">2m 05s</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>#4819</TableCell>
              <TableCell>feat/combobox-chips</TableCell>
              <TableCell>
                <Badge variant="destructive">Failed</Badge>
              </TableCell>
              <TableCell className="text-right">0m 58s</TableCell>
            </TableRow>
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>Total</TableCell>
              <TableCell colSpan={2}>3 builds</TableCell>
              <TableCell className="text-right">4m 45s</TableCell>
            </TableRow>
          </TableFooter>
          <TableCaption>Recent build output for the workspace image.</TableCaption>
        </Table>
      </Demo>

      <Demo name="Data table" wide>
        <DataTable
          aria-label="Team members"
          columns={columns}
          items={people}
          getRowId={(person) => person.id}
          footer={
            <DataTablePagination
              hasPreviousPage={page > 0}
              hasNextPage={page < 1}
              onPreviousPage={() => setPage(page - 1)}
              onNextPage={() => setPage(page + 1)}
            >
              Page {page + 1} of 2
            </DataTablePagination>
          }
        />
      </Demo>

      <Demo name="Chart" wide>
        <ChartContainer config={adoptionConfig} className="h-64 w-full">
          <BarChart accessibilityLayer data={adoptionData}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="component" tickLine={false} tickMargin={8} axisLine={false} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar dataKey="apps" fill="var(--color-apps)" radius={4} />
          </BarChart>
        </ChartContainer>
      </Demo>

      <Demo name="Carousel" wide>
        <div className="w-full px-12">
          <Carousel aria-label="Release highlights" className="w-full">
            <CarouselContent>
              {releaseNotes.map((release) => (
                <CarouselItem key={release.version}>
                  <Card>
                    <CardContent className="flex h-28 flex-col items-center justify-center gap-1">
                      <span className="font-mono text-lg font-semibold">v{release.version}</span>
                      <span className="text-sm text-muted-foreground">{release.note}</span>
                    </CardContent>
                  </Card>
                </CarouselItem>
              ))}
            </CarouselContent>
            <CarouselPrevious />
            <CarouselNext />
          </Carousel>
        </div>
      </Demo>

      <Demo name="Progress">
        <Stack>
          <Progress value={64}>
            <ProgressLabel>Token migration</ProgressLabel>
            <ProgressValue />
          </Progress>
          <Progress isIndeterminate>
            <ProgressLabel>Resolving workspace dependencies</ProgressLabel>
          </Progress>
        </Stack>
      </Demo>

      <Demo name="Accordion & collapsible">
        <Accordion defaultExpandedKeys={["deploy"]}>
          <AccordionItem id="deploy">
            <AccordionTrigger>Deployment</AccordionTrigger>
            <AccordionContent>Changes apply on the next turn.</AccordionContent>
          </AccordionItem>
          <AccordionItem id="secrets">
            <AccordionTrigger>Secrets</AccordionTrigger>
            <AccordionContent>Credentials stay outside the sandbox.</AccordionContent>
          </AccordionItem>
        </Accordion>
        <Collapsible defaultExpanded>
          <CollapsibleTrigger className="text-sm font-medium underline underline-offset-4">
            Show more
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2 text-sm text-muted-foreground">
            Collapsible content uses the same disclosure behaviour.
          </CollapsibleContent>
        </Collapsible>
      </Demo>

      <Demo name="Checklist">
        <Checklist
          title="Pre-flight"
          items={[
            { id: "image", label: "Container image built", status: "pass" },
            { id: "secrets", label: "Secrets configured", status: "pass" },
            { id: "verify", label: "First turn verified", status: "warn" },
          ]}
        />
      </Demo>

      <Demo name="Code block" wide>
        <div className="grid w-full gap-4 lg:grid-cols-2">
          <CodeBlock
            title="Theme configuration"
            language="tsx"
            showLineNumbers
            code={'<UiI18nProvider locale="en-CA">\n  <App />\n</UiI18nProvider>'}
          />
          <CodeBlock
            variant="diff"
            title="Theme change"
            showLineNumbers
            code={'- theme: "stark"\n+ theme: "aboiteau"\n  locale: "en-CA"'}
          />
        </div>
      </Demo>

      <Demo name="Trace" wide>
        <Trace label="Preview preparation" steps={traceSteps} />
      </Demo>

      <Demo name="Attachment" wide>
        <div className="grid w-full gap-3 sm:grid-cols-2">
          <Attachment filename="launch-brief.pdf" size={146432} mediaType="application/pdf" />
          <Attachment
            filename="workspace-checkpoint.tar.gz"
            size={44 * 1024 * 1024}
            mediaType="application/gzip"
            status="uploading"
            progress={35}
            onRemove={() => undefined}
          />
        </div>
      </Demo>

      <Demo name="Message & bubble" wide>
        <Stack>
          <Message author="Alex" timestamp="14:32">
            <Bubble group="first">The shared foundation is ready.</Bubble>
            <Bubble
              group="last"
              details={<p>It includes a page header, a filter toolbar and responsive panels.</p>}
            >
              There are a few implementation details available.
            </Bubble>
          </Message>
          <Message author="You" align="end">
            <Bubble variant="accent" align="end">
              Thanks, I will take a look.
            </Bubble>
          </Message>
          <Message author="Alex">
            <Bubble variant="muted">Supporting context can use a quieter surface.</Bubble>
          </Message>
        </Stack>
      </Demo>

      <Demo name="Message scroller" wide surface={false}>
        <MessageScroller
          className="h-72 w-full rounded-lg border border-border bg-card"
          items={[
            { id: "1", author: "Alex", text: "The draft is ready for review." },
            { id: "2", author: "You", text: "I am checking the compact controls.", outgoing: true },
            { id: "3", author: "Alex", text: "The host application still owns all conversation data." },
          ]}
          getKey={(item) => item.id}
          label="Example conversation"
          renderMessage={(item) => (
            <Message author={item.author} align={item.outgoing ? "end" : "start"}>
              <Bubble variant={item.outgoing ? "accent" : "default"} align={item.outgoing ? "end" : "start"}>
                {item.text}
              </Bubble>
            </Message>
          )}
        />
      </Demo>

      <Demo name="Toaster" note="Mounted once; host code calls toast() from sonner.">
        <Toaster position="bottom-right" />
        <span className="text-sm text-muted-foreground">Notification region ready.</span>
      </Demo>
    </GallerySection>
  )
}

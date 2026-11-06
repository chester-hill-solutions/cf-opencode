import { useState } from "react"
import {
  AppShell,
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarTrigger,
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  PageHeader,
  PageSection,
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarSeparator,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@aboiteau/ui"
import { LayersIcon, PaletteIcon, ServerIcon, SwatchBookIcon } from "lucide-react"
import { Demo, GallerySection, Stack } from "./shared"

const sections = ["Overview", "Records", "Settings"]
const descriptions: Record<string, string> = {
  Overview: "A clear view of the work in this workspace.",
  Records: "Review source records and their current status.",
  Settings: "Manage the preferences for this workspace.",
}

export function Navigation() {
  const [active, setActive] = useState("Overview")
  const [menuStatus, setMenuStatus] = useState("No action yet")

  return (
    <GallerySection
      id="navigation"
      number="06"
      accent="yellow"
      title="Navigation & structure"
      description="Wayfinding stays quiet and predictable: a location trail, page controls, tabs, and a shell that can frame a whole workspace."
    >
      <Demo name="Breadcrumb" wide>
        <Stack>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href="#workbench">Workbench</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbItem>
                <BreadcrumbLink href="#tokens">Tokens</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbItem>
                <BreadcrumbPage>Colour scale</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href="#workbench">Workbench</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbItem>
                <BreadcrumbEllipsis />
              </BreadcrumbItem>
              <BreadcrumbItem>
                <BreadcrumbLink href="#environments">Environments</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbItem>
                <BreadcrumbPage>staging-eu</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Stack>
      </Demo>

      <Demo name="Pagination" wide>
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious href="#page-1" />
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#page-1">1</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationEllipsis />
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#page-12" isActive>
                12
              </PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#page-13">13</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationNext href="#page-13" />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </Demo>

      <Demo name="Tabs" wide>
        <Tabs defaultSelectedKey="tokens">
          <TabsList aria-label="Foundation areas">
            <TabsTrigger id="tokens">Tokens</TabsTrigger>
            <TabsTrigger id="components">Components</TabsTrigger>
            <TabsTrigger id="tests">Tests</TabsTrigger>
          </TabsList>
          <TabsContent id="tokens" className="pt-3 text-sm text-muted-foreground">
            Semantic colours, radius and type scale.
          </TabsContent>
          <TabsContent id="components" className="pt-3 text-sm text-muted-foreground">
            Representative controls across forms, overlays and feedback.
          </TabsContent>
          <TabsContent id="tests" className="pt-3 text-sm text-muted-foreground">
            Behaviour and accessibility coverage for each exported component.
          </TabsContent>
        </Tabs>
      </Demo>

      <Demo name="Navigation menu" wide>
        <NavigationMenu aria-label="Documentation sections">
          <NavigationMenuList>
            <NavigationMenuItem>
              <NavigationMenuLink href="#overview">Overview</NavigationMenuLink>
            </NavigationMenuItem>
            <NavigationMenuItem value="learn">
              <NavigationMenuTrigger>Learn</NavigationMenuTrigger>
              <NavigationMenuContent>
                <NavigationMenuLink href="#foundations">Foundations</NavigationMenuLink>
                <NavigationMenuLink href="#components">Components</NavigationMenuLink>
                <NavigationMenuLink href="#patterns">Patterns</NavigationMenuLink>
              </NavigationMenuContent>
            </NavigationMenuItem>
          </NavigationMenuList>
        </NavigationMenu>
      </Demo>

      <Demo name="Menubar" note={menuStatus}>
        <Menubar aria-label="Document commands">
          <MenubarMenu>
            <MenubarTrigger>File</MenubarTrigger>
            <MenubarContent>
              <MenubarItem onClick={() => setMenuStatus("Created a document")}>
                New document
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onClick={() => setMenuStatus("Exported a document")}>
                Export
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger>Edit</MenubarTrigger>
            <MenubarContent>
              <MenubarItem onClick={() => setMenuStatus("Undone")}>Undo</MenubarItem>
              <MenubarItem disabled>Redo</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>
      </Demo>

      <Demo name="Sidebar" note="Inline navigation rail with grouped menus and a footer." wide surface={false}>
        <div className="specimen-stack" style={{ height: "22rem", overflow: "hidden" }}>
          <SidebarProvider className="min-h-0 h-full">
            <Sidebar collapsible="none">
              <SidebarHeader>
                <span className="px-2 text-sm font-semibold">Workbench</span>
                <SidebarInput placeholder="Search tokens…" />
              </SidebarHeader>
              <SidebarContent>
                <SidebarGroup>
                  <SidebarGroupLabel>Foundations</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      <SidebarMenuItem>
                        <SidebarMenuButton href="#tokens" isActive>
                          <SwatchBookIcon />
                          <span>Token sets</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                      <SidebarMenuItem>
                        <SidebarMenuButton href="#themes">
                          <PaletteIcon />
                          <span>Themes</span>
                        </SidebarMenuButton>
                        <SidebarMenuBadge>2</SidebarMenuBadge>
                      </SidebarMenuItem>
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
                <SidebarSeparator />
                <SidebarGroup>
                  <SidebarGroupLabel>Delivery</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      <SidebarMenuItem>
                        <SidebarMenuButton href="#environments">
                          <ServerIcon />
                          <span>Environments</span>
                        </SidebarMenuButton>
                        <SidebarMenuSub>
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton href="#staging">
                              <span>staging</span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton href="#production">
                              <span>production</span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        </SidebarMenuSub>
                      </SidebarMenuItem>
                      <SidebarMenuItem>
                        <SidebarMenuButton href="#drafts">
                          <LayersIcon />
                          <span>Drafts</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </SidebarContent>
              <SidebarFooter>
                <span className="px-2 text-xs text-muted-foreground">v0.4 · main</span>
              </SidebarFooter>
            </Sidebar>
            <main className="flex-1 p-4 text-sm text-muted-foreground">Selected: Token sets</main>
          </SidebarProvider>
        </div>
      </Demo>

      <Demo name="App shell" note="A complete workspace frame with header navigation and content." wide surface={false}>
        <div style={{ overflow: "hidden", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
          <AppShell
            className="min-h-[26rem]"
            brand="Workspace"
            nav={sections.map((label) => ({
              href: `#${label.toLowerCase()}`,
              label,
              active: active === label,
            }))}
            actions={
              <Button size="sm" variant="outline" onPress={() => setActive("Settings")}>
                Preferences
              </Button>
            }
            renderNavLink={(item, props) => (
              <a
                {...props}
                href={props.href}
                onClick={(event) => {
                  event.preventDefault()
                  setActive(String(item.label))
                }}
              >
                {item.label}
              </a>
            )}
          >
            <div className="grid gap-6">
              <PageHeader
                headingLevel="h2"
                density="compact"
                title={active}
                description={descriptions[active]}
                eyebrow="Your workspace"
              />
              <PageSection title="Work in progress" variant="card">
                <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                  <Card size="sm">
                    <CardHeader>
                      <CardTitle>Source records</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-3 text-sm">
                      <StatusBadge tone="ok">Ready</StatusBadge>
                      <p>Keep source identity and status close to the work.</p>
                    </CardContent>
                  </Card>
                  <Card size="sm">
                    <CardHeader>
                      <CardTitle>Recent activity</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                      A quiet reading surface with familiar navigation and clear boundaries.
                    </CardContent>
                  </Card>
                </div>
              </PageSection>
            </div>
          </AppShell>
        </div>
      </Demo>
    </GallerySection>
  )
}

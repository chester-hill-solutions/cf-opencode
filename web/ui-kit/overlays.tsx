import { useState } from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
  ContextMenu,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Popover,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Tooltip,
  TooltipTrigger,
  buttonVariants,
} from "@aboiteau/ui"
import { Demo, GallerySection, Row } from "./shared"

function CommandPalette() {
  return (
    <Command className="max-w-md border border-border">
      <CommandInput placeholder="Search commands…" />
      <CommandList
        aria-label="Workbench commands"
        renderEmptyState={() => <CommandEmpty>No matches. Try a shorter query.</CommandEmpty>}
      >
        <CommandGroup heading="Tokens">
          <CommandItem>
            Create token set
            <CommandShortcut>⌘N</CommandShortcut>
          </CommandItem>
          <CommandItem>Diff against published</CommandItem>
          <CommandItem>Export CSS variables</CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Environments">
          <CommandItem>Switch to staging</CommandItem>
          <CommandItem>
            View deploy logs
            <CommandShortcut>⌘L</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

function CommandDialogDemo() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" onPress={() => setOpen(true)}>
        Open command palette
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Workbench commands"
        description="Search for a workbench command to run"
      >
        <CommandPalette />
      </CommandDialog>
    </>
  )
}

export function Overlays() {
  return (
    <GallerySection
      id="overlays"
      title="Overlays & menus"
      description="Overlays carry brief, focused work. Focus is trapped where the interaction is modal, and every surface can be dismissed from the keyboard."
    >
      <Demo name="Dialog">
        <DialogTrigger>
          <Button>Open dialog</Button>
          <Dialog>
            <DialogHeader>
              <DialogTitle>Publish theme draft</DialogTitle>
              <DialogDescription>
                This writes the current token set into the package theme contract.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button slot="close" variant="outline">
                Cancel
              </Button>
              <Button slot="close">Publish</Button>
            </DialogFooter>
          </Dialog>
        </DialogTrigger>
      </Demo>

      <Demo name="Alert dialog">
        <AlertDialogTrigger>
          <Button variant="destructive">Delete token set</Button>
          <AlertDialog>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete dark-theme-v2?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the token set and its checkpoints from the workspace.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep token set</AlertDialogCancel>
              <AlertDialogAction variant="destructive">Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialog>
        </AlertDialogTrigger>
      </Demo>

      <Demo name="Sheet">
        <SheetTrigger>
          <Button variant="outline">Edit staging</Button>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>Staging environment</SheetTitle>
              <SheetDescription>
                Adjust variables for the staging deploy target. Changes apply on the next build.
              </SheetDescription>
            </SheetHeader>
            <div className="px-6 text-sm text-muted-foreground">
              Region: us-east-1 · Node 22 · 4 secrets
            </div>
            <SheetFooter>
              <SheetClose variant="default">Save changes</SheetClose>
              <SheetClose>Cancel</SheetClose>
            </SheetFooter>
          </SheetContent>
        </SheetTrigger>
      </Demo>

      <Demo name="Drawer">
        <Drawer showSwipeHandle>
          <DrawerTrigger className={buttonVariants({ variant: "outline" })}>Review draft</DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Draft token set</DrawerTitle>
              <DrawerDescription>
                3 tokens changed since the last publish. Swipe down or use the buttons to close.
              </DrawerDescription>
            </DrawerHeader>
            <div className="p-4 text-sm text-muted-foreground">
              color.accent · radius.md · shadow.raised
            </div>
            <DrawerFooter>
              <DrawerClose className={buttonVariants({ variant: "default" })}>
                Publish draft
              </DrawerClose>
              <DrawerClose className={buttonVariants({ variant: "outline" })}>
                Keep editing
              </DrawerClose>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      </Demo>

      <Demo name="Popover">
        <PopoverTrigger>
          <Button variant="outline">Inspect token</Button>
          <Popover>
            <PopoverHeader>
              <PopoverTitle>color.surface.raised</PopoverTitle>
              <PopoverDescription>
                Resolves to a warm paper surface in the light theme and follows the elevation ramp in
                dark mode.
              </PopoverDescription>
            </PopoverHeader>
            <dl className="grid grid-cols-2 gap-1 text-xs">
              <dt className="text-muted-foreground">Tier</dt>
              <dd>semantic</dd>
              <dt className="text-muted-foreground">Consumers</dt>
              <dd>12 components</dd>
            </dl>
          </Popover>
        </PopoverTrigger>
      </Demo>

      <Demo name="Tooltip & hover card">
        <Row>
          <TooltipTrigger>
            <Button variant="outline">Focus me</Button>
            <Tooltip>Tooltips appear on hover and keyboard focus</Tooltip>
          </TooltipTrigger>
          <HoverCard>
            <HoverCardTrigger href="#foundations">Shared foundations</HoverCardTrigger>
            <HoverCardContent>
              <p className="font-semibold">Foundations</p>
              <p className="mt-2 text-muted-foreground">
                Learn about the tokens, density and themes that power every component.
              </p>
            </HoverCardContent>
          </HoverCard>
        </Row>
      </Demo>

      <Demo name="Dropdown menu">
        <DropdownMenuTrigger>
          <Button variant="outline">Token set actions</Button>
          <DropdownMenu aria-label="Token set actions" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Draft</DropdownMenuLabel>
              <DropdownMenuItem>
                Rename
                <DropdownMenuShortcut>⌘R</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem>
                Publish
                <DropdownMenuShortcut>⌘⇧P</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem isDisabled>Restore checkpoint</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Copy link for</DropdownMenuSubTrigger>
              <DropdownMenuSubContent aria-label="Copy link targets">
                <DropdownMenuItem>Preview build</DropdownMenuItem>
                <DropdownMenuItem>Design file</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenu>
        </DropdownMenuTrigger>
      </Demo>

      <Demo name="Context menu" note="Right-click or use the context-menu key.">
        <ContextMenuTrigger>
          <div className="flex h-24 w-full items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
            Right-click tokens/dark.json
          </div>
          <ContextMenu aria-label="File actions">
            <ContextMenuGroup>
              <ContextMenuLabel>File</ContextMenuLabel>
              <ContextMenuItem>Open in editor</ContextMenuItem>
              <ContextMenuItem>
                Copy path
                <ContextMenuShortcut>⌘C</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem isDisabled>Reveal in sidebar</ContextMenuItem>
            </ContextMenuGroup>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive">Delete file</ContextMenuItem>
          </ContextMenu>
        </ContextMenuTrigger>
      </Demo>

      <Demo name="Command" note="An inline palette and the same palette inside a modal." wide>
        <div className="grid w-full gap-4 lg:grid-cols-2">
          <CommandPalette />
          <div className="flex items-start">
            <CommandDialogDemo />
          </div>
        </div>
      </Demo>
    </GallerySection>
  )
}

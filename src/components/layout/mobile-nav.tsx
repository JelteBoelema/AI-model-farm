"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Brand } from "./brand";
import { SidebarNav } from "./sidebar-nav";

export function MobileNav() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
          <Menu />
        </Button>
      </DialogTrigger>
      <DialogContent side="left" className="flex flex-col gap-6 overflow-y-auto bg-sidebar p-4">
        <DialogTitle className="sr-only">Navigation</DialogTitle>
        <Brand />
        <SidebarNav onNavigate={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

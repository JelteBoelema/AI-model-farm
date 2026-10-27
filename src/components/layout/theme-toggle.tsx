"use client";

import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export function ThemeToggle() {
  function toggle() {
    const dark = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("theme", dark ? "dark" : "light");
    } catch {
      /* storage unavailable: theme still switches for this page view */
    }
  }
  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle colour theme">
      <Sun className="hidden dark:block" />
      <Moon className="dark:hidden" />
    </Button>
  );
}

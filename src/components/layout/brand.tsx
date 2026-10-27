import { Sparkles } from "lucide-react";

export function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-3">
      <div className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <Sparkles className="size-4" aria-hidden />
      </div>
      <div className="leading-tight">
        <p className="text-sm font-semibold">Creator Farm</p>
        <p className="text-[11px] text-muted-foreground">AI studio control</p>
      </div>
    </div>
  );
}

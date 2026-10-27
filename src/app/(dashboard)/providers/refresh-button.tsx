"use client";

import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { refreshProvidersAction } from "./actions";

export function RefreshProvidersButton() {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await refreshProvidersAction({});
          if (res.ok) toast.success("Provider status refreshed");
          else toast.error(res.error);
        })
      }
    >
      <RefreshCw className={pending ? "animate-spin" : ""} /> Re-check credentials
    </Button>
  );
}

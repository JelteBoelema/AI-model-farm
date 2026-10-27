"use client";

import { TriangleAlert } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

// Safe error surface: shows the digest for support, never the stack or message from the server.
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card>
      <EmptyState
        icon={TriangleAlert}
        title="This view could not be loaded"
        description={error.digest ? `Reference: ${error.digest}` : "An unexpected error occurred."}
        action={<Button variant="outline" size="sm" onClick={reset}>Try again</Button>}
      />
    </Card>
  );
}

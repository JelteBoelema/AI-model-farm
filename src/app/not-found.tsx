import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-4 text-center">
      <div>
        <p className="text-sm font-medium text-primary">404</p>
        <h1 className="mt-1 text-xl font-semibold">Page not found</h1>
        <Button asChild variant="outline" className="mt-6">
          <Link href="/">Back to overview</Link>
        </Button>
      </div>
    </main>
  );
}

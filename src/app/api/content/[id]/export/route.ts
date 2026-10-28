import { NextResponse } from "next/server";
import { can } from "@/lib/rbac";
import { actorOf, getCurrentUser } from "@/server/auth/session";
import { recordAudit } from "@/server/audit";
import { DomainError } from "@/server/errors";
import { buildExportPackage } from "@/server/services/export-package";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!can(user.role, "publishing:schedule")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const pkg = await buildExportPackage(id);
    await recordAudit(actorOf(user), { action: "content.exported", entityType: "content_item", entityId: id, metadata: { filename: pkg.filename } });
    return new NextResponse(new Uint8Array(pkg.bytes), {
      headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${pkg.filename}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  } catch (err) {
    if (err instanceof DomainError) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }
}

import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/rbac";
import { formatDateTime } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { CreateUserDialog, UserTable } from "./user-admin";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  const user = await requireUser();
  const canManage = can(user.role, "users:manage");
  const users = await db.user.findMany({
    orderBy: [{ disabledAt: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, email: true, role: true, disabledAt: true, lastLoginAt: true },
  });

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between">
        <div>
          <CardTitle>Users and roles</CardTitle>
          <CardDescription>
            Owner: everything incl. users and raising budgets · Admin: providers, accounts, resume · Operator: create, generate, schedule, pause · Viewer: read-only.
          </CardDescription>
        </div>
        {canManage ? <CreateUserDialog /> : null}
      </CardHeader>
      <CardContent className="px-0">
        <UserTable
          currentUserId={user.id}
          canManage={canManage}
          users={users.map((u) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            role: u.role,
            disabled: u.disabledAt !== null,
            lastLogin: formatDateTime(u.lastLoginAt),
          }))}
        />
      </CardContent>
    </Card>
  );
}

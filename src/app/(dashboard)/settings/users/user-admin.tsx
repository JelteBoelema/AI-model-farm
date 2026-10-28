"use client";

import { useState, useTransition } from "react";
import { UserPlus } from "lucide-react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { humanize } from "@/lib/utils";
import { changeRoleAction, createUserAction, resetMfaAction, setDisabledAction } from "../actions";

const ROLES = ["OWNER", "ADMIN", "OPERATOR", "VIEWER"] as const;
type Role = (typeof ROLES)[number];

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  disabled: boolean;
  mfa: boolean;
  lastLogin: string;
}

export function CreateUserDialog() {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(form: FormData) {
    setError(null);
    start(async () => {
      const res = await createUserAction({
        email: form.get("email"),
        name: form.get("name"),
        role: form.get("role"),
        password: form.get("password"),
      });
      if (res.ok) {
        toast.success("User created");
        setOpen(false);
      } else setError(res.error);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlus /> Add user
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>Share the initial password through a secure channel. Minimum 12 characters.</DialogDescription>
        </DialogHeader>
        <form action={submit} className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="new-name">Name</Label>
            <Input id="new-name" name="name" required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-email">Email</Label>
            <Input id="new-email" name="email" type="email" required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-role">Role</Label>
            <NativeSelect id="new-role" name="role" defaultValue="VIEWER">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {humanize(r)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-password">Initial password</Label>
            <Input id="new-password" name="password" type="password" autoComplete="new-password" minLength={12} required />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending} className="mt-2">
            Create user
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function UserTable({ users, currentUserId, canManage, isOwner }: { users: UserRow[]; currentUserId: string; canManage: boolean; isOwner: boolean }) {
  const [pending, start] = useTransition();

  function call(fn: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    start(async () => {
      const res = await fn();
      if (res.ok) toast.success(success);
      else toast.error(res.error ?? "Failed");
    });
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Last sign-in</TableHead>
          {canManage ? <TableHead className="text-right">Actions</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((u) => {
          const self = u.id === currentUserId;
          return (
            <TableRow key={u.id}>
              <TableCell>
                <p className="font-medium">
                  {u.name} {self ? <span className="text-xs font-normal text-muted-foreground">(you)</span> : null}
                </p>
                <p className="text-xs text-muted-foreground">{u.email}</p>
              </TableCell>
              <TableCell>
                {canManage && !self ? (
                  <NativeSelect
                    aria-label={`Role for ${u.email}`}
                    value={u.role}
                    disabled={pending}
                    onChange={(e) => call(() => changeRoleAction({ userId: u.id, role: e.target.value }), "Role updated")}
                    className="w-32"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {humanize(r)}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  humanize(u.role)
                )}
              </TableCell>
              <TableCell>
                <span className="flex flex-wrap items-center gap-1">
                  <StatusBadge status={u.disabled ? "DISABLED" : "ACTIVE"} />
                  <span className="text-xs text-muted-foreground">{u.mfa ? "2FA on" : "no 2FA"}</span>
                </span>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{u.lastLogin}</TableCell>
              {canManage ? (
                <TableCell className="text-right">
                  {!self ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => call(() => setDisabledAction({ userId: u.id, disabled: !u.disabled }), u.disabled ? "User enabled" : "User disabled")}
                    >
                      {u.disabled ? "Enable" : "Disable"}
                    </Button>
                  ) : null}
                  {isOwner && !self && u.mfa ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-2"
                      disabled={pending}
                      onClick={() => {
                        const reason = window.prompt(`Why reset two-factor authentication for ${u.email}? They set it up again at their next sign-in.`);
                        if (reason) call(() => resetMfaAction({ userId: u.id, reason }), "Two-factor authentication reset");
                      }}
                    >
                      Reset 2FA
                    </Button>
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// Account users: who gets in, with what role and which vehicles they see (all,
// those of some groups, or some chosen one by one), and the roles the account
// defines for itself.
import { ALL_PERMISSIONS, type Member, type Permission, type RoleInfo, type Vehicle, type VehicleGroup } from "@opengps/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Ban, Check, ChevronDown, Mail, Pencil, Trash2, UserCheck } from "lucide-react";
import type { TFunction } from "i18next";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Notice, Spinner } from "../../components/ui";
import { cancelInvitation, createRole, deleteRole, getMembers, inviteMember, removeMember, updateMember, updateRole } from "../../lib/api";
import { minutesUntil } from "../../lib/format";
import { VehiclePicker } from "../reports/kit";
import { errorText } from "../widgets";

const selectClass =
  "h-9 rounded-[10px] border border-line bg-surface px-2.5 text-sm text-ink focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10 disabled:bg-canvas disabled:text-muted";

/** `part` chooses what is shown: the people of the account, or its roles. */
export function UsersSection({ groups, vehicles, part }: { groups: VehicleGroup[]; vehicles: Vehicle[]; part: "people" | "roles" }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const data = useQuery({ queryKey: ["members"], queryFn: getMembers });
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["members"] });
  const run = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: () => {
      setError(null);
      return refresh();
    },
    onError: (err) => setError(errorText(err)),
  });

  const roles = data.data?.roles ?? [];
  return (
    <div>
      {data.isLoading && (
        <div className="flex h-32 items-center justify-center text-muted">
          <Spinner />
        </div>
      )}
      {data.isError && <Notice tone="error">{errorText(data.error)}</Notice>}
      {data.data && part === "roles" && <CustomRoles roles={roles} onChanged={refresh} />}
      {data.data && part === "people" && (
        <div className="space-y-6">
          <ul className="divide-y divide-line rounded-[12px] border border-line bg-surface">
            {data.data.members.map((m) => (
              <MemberRow key={m.userId} member={m} roles={roles} groups={groups} vehicles={vehicles} busy={run.isPending} onRun={(action) => run.mutate(action)} />
            ))}
          </ul>

          {data.data.invitations.length > 0 && (
            <section>
              <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-muted">{t("admin.users.invitations.title")}</h3>
              <ul className="divide-y divide-line rounded-[12px] border border-line bg-surface">
                {data.data.invitations.map((i) => (
                  <li key={i.id} className="flex items-center gap-3 px-3.5 py-2.5">
                    <Mail size={16} className="shrink-0 text-muted" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{i.email}</span>
                      <span className="block text-[13px] text-muted">
                        {t("admin.users.invitations.line", { role: i.roleName, scope: scopeLabel(t, i, groups), count: Math.max(1, Math.ceil(minutesUntil(i.expiresAt) / 1440)) })}
                      </span>
                    </span>
                    <Button variant="secondary" size="sm" onClick={() => run.mutate(() => cancelInvitation(i.id))}>
                      {t("admin.users.invitations.cancel")}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {error && <Notice tone="error">{error}</Notice>}

          <InviteForm roles={roles} groups={groups} vehicles={vehicles} onInvited={refresh} />
        </div>
      )}
    </div>
  );
}

/** What a person sees: everything, or some groups plus some vehicles chosen one by one. */
interface ScopeValue {
  groups: string[] | null;
  vehicles: string[];
}

/** "Todos los vehículos", or "Zona norte, 2 vehículos sueltos". */
function scopeLabel(t: TFunction, scope: ScopeValue, groups: VehicleGroup[]): string {
  if (scope.groups === null) return t("admin.users.scope.all");
  const parts = scope.groups.map((id) => groups.find((g) => g.id === id)?.name ?? t("admin.users.scope.unknownGroup"));
  if (scope.vehicles.length > 0) parts.push(t("admin.users.scope.vehiclesCount", { count: scope.vehicles.length }));
  return parts.length === 0 ? t("admin.users.scope.none") : parts.join(", ");
}

function MemberRow(props: {
  member: Member;
  roles: RoleInfo[];
  groups: VehicleGroup[];
  vehicles: Vehicle[];
  busy: boolean;
  onRun: (action: () => Promise<unknown>) => void;
}) {
  const { t } = useTranslation();
  const { member: m, roles, groups } = props;
  const locked = m.role === "owner" || m.isYou;
  const [scopeOpen, setScopeOpen] = useState(false);
  const canScope = !locked && m.role !== "admin" && (groups.length > 0 || props.vehicles.length > 0);

  return (
    <li className={clsx("px-3.5 py-3", m.disabled && "bg-canvas")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 basis-48">
          <span className="block truncate text-[15px] font-medium">
            {m.name}
            {m.isYou && <span className="ml-1.5 text-[13px] font-normal text-muted">{t("admin.users.you")}</span>}
            {m.disabled && <span className="ml-1.5 rounded-full bg-danger/10 px-2 py-0.5 text-[12px] font-medium text-danger">{t("admin.users.blocked")}</span>}
          </span>
          <span className="block truncate text-[13px] text-muted">{m.email}</span>
        </span>

        {locked ? (
          <span className="text-sm text-muted">{m.roleName}</span>
        ) : (
          <>
            <select
              className={selectClass}
              aria-label={t("admin.users.roleOf", { name: m.name })}
              value={m.role}
              disabled={props.busy}
              onChange={(e) => {
                // Read now: by the time the change is sent, the list already went back to the role saved.
                const role = e.target.value;
                props.onRun(() => updateMember(m.userId, { role }));
              }}
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <IconButton
              label={m.disabled ? t("admin.users.unblock", { name: m.name }) : t("admin.users.block", { name: m.name })}
              onClick={() => props.onRun(() => updateMember(m.userId, { disabled: !m.disabled }))}
            >
              {m.disabled ? <UserCheck size={16} /> : <Ban size={16} />}
            </IconButton>
            <IconButton label={t("admin.users.remove", { name: m.name })} onClick={() => props.onRun(() => removeMember(m.userId))}>
              <Trash2 size={16} />
            </IconButton>
          </>
        )}
      </div>

      {canScope && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setScopeOpen((o) => !o)}
            aria-expanded={scopeOpen}
            className="inline-flex items-center gap-1 text-[13px] font-medium text-ink-3 hover:text-ink"
          >
            {t("admin.users.scope.sees")} {scopeLabel(t, m, groups)} <ChevronDown size={14} className={clsx("transition-transform", scopeOpen && "rotate-180")} />
          </button>
          {scopeOpen && (
            <ScopePicker
              groups={groups}
              vehicles={props.vehicles}
              value={{ groups: m.groups, vehicles: m.vehicles }}
              onChange={(next) => props.onRun(() => updateMember(m.userId, next))}
              name={`scope-${m.userId}`}
            />
          )}
        </div>
      )}
    </li>
  );
}

/** Choose between seeing all vehicles, or only those of certain groups and some chosen one by one. */
function ScopePicker({ groups, vehicles, value, onChange, name }: { groups: VehicleGroup[]; vehicles: Vehicle[]; value: ScopeValue; onChange: (value: ScopeValue) => void; name: string }) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const chosen = value.groups;
  const names = value.vehicles.map((id) => vehicles.find((v) => v.id === id)?.name).filter((n): n is string => Boolean(n));
  return (
    <fieldset className="mt-2 space-y-1.5 rounded-[10px] bg-canvas p-3 text-sm">
      <legend className="sr-only">{t("admin.users.scope.legend")}</legend>
      <label className="flex items-center gap-2">
        <input type="radio" name={name} checked={chosen === null} onChange={() => onChange({ groups: null, vehicles: [] })} />
        {t("admin.users.scope.all")}
      </label>
      <label className="flex items-center gap-2">
        <input type="radio" name={name} checked={chosen !== null} onChange={() => onChange({ groups: [], vehicles: [] })} />
        {t("admin.users.scope.some")}
      </label>
      {chosen !== null && (
        <div className="ml-6 space-y-3 pt-1">
          {groups.length > 0 && (
            <div>
              <p className="mb-1.5 text-[13px] font-medium text-ink-3">{t("admin.users.scope.groups")}</p>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {groups.map((g) => (
                  <label key={g.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={chosen.includes(g.id)}
                      onChange={(e) => onChange({ groups: e.target.checked ? [...chosen, g.id] : chosen.filter((id) => id !== g.id), vehicles: value.vehicles })}
                    />
                    {g.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-ink-3">{t("admin.users.scope.vehicles")}</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="min-w-0 text-muted">
                {value.vehicles.length === 0
                  ? t("admin.users.scope.noVehicles")
                  : names.length > 0 && names.length <= 3
                    ? names.join(", ")
                    : t("admin.users.scope.vehiclesCount", { count: value.vehicles.length })}
              </span>
              <Button type="button" variant="secondary" size="sm" disabled={vehicles.length === 0} onClick={() => setPicking(true)}>
                {t(value.vehicles.length === 0 ? "admin.users.scope.pick" : "admin.users.scope.change")}
              </Button>
            </div>
          </div>
        </div>
      )}
      <VehiclePicker open={picking} vehicles={vehicles} chosen={value.vehicles} allowNone onClose={() => setPicking(false)} onDone={(ids) => onChange({ groups: chosen ?? [], vehicles: ids })} />
    </fieldset>
  );
}

function InviteForm({ roles, groups, vehicles, onInvited }: { roles: RoleInfo[]; groups: VehicleGroup[]; vehicles: Vehicle[]; onInvited: () => unknown }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("operator");
  const [scope, setScope] = useState<ScopeValue>({ groups: null, vehicles: [] });
  const [sentTo, setSentTo] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => inviteMember({ email: email.trim(), role, ...(role === "admin" ? { groups: null, vehicles: [] } : scope) }),
    onSuccess: async () => {
      setSentTo(email.trim());
      setEmail("");
      setScope({ groups: null, vehicles: [] });
      await onInvited();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSentTo(null);
    if (email.trim()) invite.mutate();
  };
  const description = roles.find((r) => r.id === role)?.description;

  return (
    <form onSubmit={submit} className="space-y-3 rounded-[14px] border border-line bg-surface p-4" noValidate>
      <h3 className="text-[15px] font-semibold">{t("admin.users.invite.title")}</h3>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <label htmlFor="invitar-correo" className="mb-1.5 block text-[13px] font-medium text-ink-3">
            {t("admin.users.invite.email")}
          </label>
          <input
            id="invitar-correo"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("admin.users.invite.emailPlaceholder")}
            className="h-11 w-full rounded-[10px] border border-line bg-surface px-3.5 text-[15px] placeholder:text-faint focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10"
          />
        </div>
        <div>
          <label htmlFor="invitar-rol" className="mb-1.5 block text-[13px] font-medium text-ink-3">
            {t("admin.users.invite.role")}
          </label>
          <select id="invitar-rol" className={clsx(selectClass, "h-11")} value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" size="lg" className="h-11" loading={invite.isPending} disabled={!email.trim()}>
          {t("admin.users.invite.send")}
        </Button>
      </div>
      {description && <p className="text-[13px] text-muted">{description}.</p>}
      {role !== "admin" && (groups.length > 0 || vehicles.length > 0) && <ScopePicker groups={groups} vehicles={vehicles} value={scope} onChange={setScope} name="scope-invitation" />}
      {invite.isError && <Notice tone="error">{errorText(invite.error)}</Notice>}
      {sentTo && <Notice tone="success">{t("admin.users.invite.sent", { email: sentTo })}</Notice>}
    </form>
  );
}

function CustomRoles({ roles, onChanged }: { roles: RoleInfo[]; onChanged: () => unknown }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<Permission[]>([]);
  /** The custom role being changed; null while the form creates a new one. */
  const [editing, setEditing] = useState<RoleInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = async () => {
    setError(null);
    await onChanged();
  };
  const clear = () => {
    setEditing(null);
    setName("");
    setPermissions([]);
  };
  const edit = (role: RoleInfo) => {
    setEditing(role);
    setName(role.name);
    setPermissions(role.permissions);
    setError(null);
  };
  const add = useMutation({
    mutationFn: () => (editing ? updateRole(editing.id, { name: name.trim(), permissions }) : createRole({ name: name.trim(), permissions })),
    onSuccess: async () => {
      clear();
      await done();
    },
    onError: (err) => setError(errorText(err)),
  });
  const remove = useMutation({ mutationFn: (id: string) => deleteRole(id), onSuccess: done, onError: (err) => setError(errorText(err)) });

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="space-y-3">
        <p className="text-sm text-muted">{t("admin.roles.note")}</p>
        <ul className="divide-y divide-line rounded-[12px] border border-line bg-surface">
          {roles.map((r) => (
            <li key={r.id} className="flex items-start gap-3 px-4 py-3.5">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-medium text-ink">{r.name}</span>
                  <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[12px] font-medium text-ink-3">{t(r.builtin ? "admin.roles.included" : "admin.roles.own")}</span>
                </span>
                <span className="mt-1 block text-[13.5px] leading-relaxed text-muted">
                  {r.builtin ? `${r.description}.` : r.permissions.length === 0 ? t("admin.roles.viewOnly") : r.permissions.map((p) => t(`shared.permission.${p}`)).join(" · ")}
                </span>
              </span>
              {!r.builtin && (
                <span className="flex shrink-0 items-center">
                  <IconButton label={t("admin.roles.edit", { name: r.name })} onClick={() => edit(r)}>
                    <Pencil size={16} />
                  </IconButton>
                  <IconButton
                    label={t("admin.roles.delete", { name: r.name })}
                    onClick={() => {
                      if (editing?.id === r.id) clear();
                      remove.mutate(r.id);
                    }}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </span>
              )}
            </li>
          ))}
        </ul>
        {error && <Notice tone="error">{error}</Notice>}
      </section>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) add.mutate();
        }}
        className={clsx("space-y-3 rounded-[14px] border bg-surface p-4", editing ? "border-ink" : "border-line")}
      >
        <h2 className="text-[15px] font-semibold text-ink">{editing ? t("admin.roles.editTitle", { name: editing.name }) : t("admin.roles.new")}</h2>
        <div>
          <label htmlFor="new-role" className="mb-1.5 block text-[13px] font-medium text-ink-3">
            {t("admin.roles.name")}
          </label>
          <input
            id="new-role"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder={t("admin.roles.namePlaceholder")}
            className="h-10 w-full rounded-[10px] border border-line bg-surface px-3 text-sm text-ink placeholder:text-faint focus:border-ink focus:outline-none focus:ring-3 focus:ring-ink/10"
          />
        </div>
        <fieldset className="space-y-2 text-sm">
          <legend className="mb-2 text-[13px] font-medium text-ink-3">{t("admin.roles.allows")}</legend>
          {ALL_PERMISSIONS.map((p) => (
            <label key={p} className="flex items-start gap-2 text-ink">
              <input
                type="checkbox"
                className="mt-1"
                checked={permissions.includes(p)}
                onChange={(e) => setPermissions(e.target.checked ? [...permissions, p] : permissions.filter((x) => x !== p))}
              />
              {t(`shared.permission.${p}`)}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" loading={add.isPending} disabled={!name.trim()}>
            <Check size={15} /> {t(editing ? "admin.roles.save" : "admin.roles.create")}
          </Button>
          {editing && (
            <Button type="button" variant="ghost" size="sm" onClick={clear}>
              {t("admin.roles.cancel")}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

function IconButton({ label, children, onClick }: { label: string; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="shrink-0 rounded-lg p-2 text-muted hover:bg-canvas hover:text-ink">
      {children}
    </button>
  );
}

// Administration panel: one for everybody. Each person sees the sections of
// their profile: whoever administers the platform, all of them; an account
// administrator, their account's; any member, the overview and their profile.
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useParams } from "react-router";
import { AccountsSection, Stats } from "../app/admin/AccountsSection";
import { ActivitySection } from "../app/admin/ActivitySection";
import { AdminShell } from "../app/admin/AdminShell";
import { BackupsTab } from "../app/admin/BackupsTab";
import { ChannelsSection } from "../app/admin/ChannelsSection";
import { SignInSection } from "../app/admin/SignInSection";
import { GroupsSection } from "../app/admin/GroupsSection";
import { NotificationsSection } from "../app/admin/NotificationsSection";
import { OverviewSection } from "../app/admin/OverviewSection";
import { ProfileSection } from "../app/admin/ProfileSection";
import { GeneralTab, StorageTab } from "../app/admin/SettingsTabs";
import { SystemNotificationsSection } from "../app/admin/SystemNotificationsSection";
import { UsersSection } from "../app/admin/UsersSection";
import { DeliveryLog } from "../app/admin/notify";
import { SECTIONS, viewerOf } from "../app/admin/sections";
import { Card } from "../app/reports/kit";
import { SimulatorSection } from "../app/simulator/SimulatorSection";
import { Spinner } from "../components/ui";
import { getAdminStats, getGroups, getVehicles } from "../lib/api";
import { getSystemNotifications } from "../lib/notifications";
import { useMe } from "../lib/session";

/** What the platform itself sent: its own notifications and the channel tests. */
function PlatformDeliveries() {
  const { t } = useTranslation();
  const log = useQuery({ queryKey: ["admin", "notifications"], queryFn: getSystemNotifications, refetchInterval: 30_000 });
  return (
    <Card title={t("admin.notify.log.title")} note={t("admin.system.logLead")}>
      {log.data ? <DeliveryLog deliveries={log.data.deliveries} empty={t("admin.notify.log.empty")} /> : <Spinner />}
    </Card>
  );
}

export function AdminPanel() {
  const me = useMe();
  const navigate = useNavigate();
  const rest = (useParams()["*"] ?? "").replace(/\/+$/, "");
  const signedIn = Boolean(me.data);
  const viewer = me.data ? viewerOf(me.data) : null;
  const sections = viewer ? SECTIONS.filter((s) => s.show(viewer)) : [];
  const current = sections.find((s) => s.path === rest);
  const needsGroups = current?.id === "users" || current?.id === "vehicleGroups";
  const groups = useQuery({ queryKey: ["groups"], queryFn: getGroups, enabled: signedIn && needsGroups });
  // To let a person see vehicles chosen one by one.
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: getVehicles, enabled: signedIn && current?.id === "users" });
  const stats = useQuery({ queryKey: ["admin", "stats"], queryFn: getAdminStats, enabled: current?.id === "logs", refetchInterval: 30_000 });

  if (me.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Spinner size={24} />
      </div>
    );
  }
  if (!me.data) return <Navigate to={`/login?next=${encodeURIComponent(`/admin${rest ? `/${rest}` : ""}`)}`} replace />;
  // A suspended account is told so on the main screen.
  if (me.data.account.suspended && !me.data.user.platformAdmin) return <Navigate to="/" replace />;

  // A section this person does not have, or that does not exist.
  if (!current) return <Navigate to="/admin" replace />;

  return (
    <AdminShell me={me.data} sections={sections} current={current}>
      {current.id === "overview" && <OverviewSection me={me.data} sections={sections} />}
      {current.id === "users" && <UsersSection groups={groups.data ?? []} vehicles={vehicles.data ?? []} part="people" />}
      {current.id === "roles" && <UsersSection groups={[]} vehicles={[]} part="roles" />}
      {current.id === "vehicleGroups" && <GroupsSection groups={groups.data ?? []} />}
      {current.id === "notifications" && <NotificationsSection />}
      {current.id === "activity" && (
        <div className="rounded-[14px] border border-line bg-surface p-5">
          <ActivitySection />
        </div>
      )}
      {current.id === "profile" && <ProfileSection me={me.data} />}
      {current.id === "accounts" && <AccountsSection meId={me.data.user.id} />}
      {current.id === "signIn" && <SignInSection />}
      {current.id === "channels" && <ChannelsSection meEmail={me.data.user.email} />}
      {current.id === "systemNotifications" && <SystemNotificationsSection me={me.data} />}
      <div>
        {current.id === "settings" && <GeneralTab />}
        {current.id === "storage" && <StorageTab />}
        {current.id === "backups" && <BackupsTab onStorage={() => void navigate("/admin/system/storage")} />}
      </div>
      {current.id === "simulator" && <SimulatorSection />}
      {current.id === "logs" && (
        <div className="space-y-6">
          <Stats stats={stats.data} />
          <div className="rounded-[14px] border border-line bg-surface p-5">
            <ActivitySection platform />
          </div>
          <PlatformDeliveries />
        </div>
      )}
    </AdminShell>
  );
}

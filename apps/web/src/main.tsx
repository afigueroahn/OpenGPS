import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import "./lib/i18n";
import { APP_OAUTH_PAGE, APP_PASSKEY_PAGE } from "@opengps/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AppPasskey } from "./routes/app-passkey";
import { AppSignIn } from "./routes/app-sign-in";
import { CheckEmail, ForgotPassword, Login, Register, ResetPassword } from "./routes/auth";
import { Invitation } from "./routes/invitation";
import { LegalPage } from "./routes/legal";

// The map is heavy: it is downloaded only on entering, not on the session screens.
const AppShell = lazy(() => import("./app/AppShell").then((m) => ({ default: m.AppShell })));
const AdminPanel = lazy(() => import("./routes/admin").then((m) => ({ default: m.AdminPanel })));
const ReportsPage = lazy(() => import("./routes/reports").then((m) => ({ default: m.ReportsPage })));
const FleetPage = lazy(() => import("./routes/fleet").then((m) => ({ default: m.FleetPage })));
const MaintenancePage = lazy(() => import("./routes/maintenance").then((m) => ({ default: m.MaintenancePage })));
const RoutesPage = lazy(() => import("./routes/logistics").then((m) => ({ default: m.RoutesPage })));
const IntegrationsPage = lazy(() => import("./routes/integrations").then((m) => ({ default: m.IntegrationsPage })));
// They are opened by people without an account, via a link: the driver of a route and whoever is waiting for a delivery.
const DriverPage = lazy(() => import("./routes/driver").then((m) => ({ default: m.DriverPage })));
const DeliveryPage = lazy(() => import("./routes/delivery").then((m) => ({ default: m.DeliveryPage })));
// The page of a shared link is opened by people without an account: it carries only its own map.
const SharedPage = lazy(() => import("./routes/shared").then((m) => ({ default: m.SharedPage })));

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 2 } },
});

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route
            path="/"
            element={
              <Suspense fallback={<div className="h-full bg-panel" />}>
                <AppShell />
              </Suspense>
            }
          />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Register />} />
          <Route path="/check-email" element={<CheckEmail />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/invitation" element={<Invitation />} />
          <Route path={APP_OAUTH_PAGE} element={<AppSignIn />} />
          <Route path={APP_PASSKEY_PAGE} element={<AppPasskey />} />
          <Route path="/terms" element={<LegalPage doc="terms" />} />
          <Route path="/privacy" element={<LegalPage doc="privacy" />} />
          <Route
            path="/admin/*"
            element={
              <Suspense fallback={<div className="h-full bg-canvas" />}>
                <AdminPanel />
              </Suspense>
            }
          />
          <Route
            path="/reports"
            element={
              <Suspense fallback={<div className="h-full bg-canvas" />}>
                <ReportsPage />
              </Suspense>
            }
          />
          <Route
            path="/fleet"
            element={
              <Suspense fallback={<div className="h-full bg-canvas" />}>
                <FleetPage />
              </Suspense>
            }
          />
          <Route
            path="/maintenance"
            element={
              <Suspense fallback={<div className="h-full bg-canvas" />}>
                <MaintenancePage />
              </Suspense>
            }
          />
          <Route
            path="/routes"
            element={
              <Suspense fallback={<div className="h-full bg-canvas" />}>
                <RoutesPage />
              </Suspense>
            }
          />
          <Route
            path="/integrations"
            element={
              <Suspense fallback={<div className="h-full bg-canvas" />}>
                <IntegrationsPage />
              </Suspense>
            }
          />
          <Route
            path="/driver"
            element={
              <Suspense fallback={<div className="h-full bg-canvas" />}>
                <DriverPage />
              </Suspense>
            }
          />
          <Route
            path="/delivery"
            element={
              <Suspense fallback={<div className="h-full bg-canvas" />}>
                <DeliveryPage />
              </Suspense>
            }
          />
          <Route
            path="/shared"
            element={
              <Suspense fallback={<div className="h-full bg-canvas" />}>
                <SharedPage />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

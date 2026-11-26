// Data cache. Coming back to the app counts as coming back to the page: what
// is stale is requested again.
import { focusManager, QueryClient } from "@tanstack/react-query";
import { AppState, type AppStateStatus } from "react-native";

focusManager.setEventListener((setFocused) => {
  const subscription = AppState.addEventListener("change", (status: AppStateStatus) => setFocused(status === "active"));
  return () => subscription.remove();
});

export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 2 } } });

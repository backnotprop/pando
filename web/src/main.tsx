import "./theme.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isMissing, isSignedOut } from "./api/client";
import { routeTree } from "./routeTree.gen";
import { Failed, NotFoundPage } from "./ui/pages";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, error) => !isSignedOut(error) && !isMissing(error) && count < 2,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  defaultNotFoundComponent: NotFoundPage,
  defaultErrorComponent: Failed,
  // Plain URLSearchParams, not JSON: `?v=431` and `?in=ramos/pando` stay as written.
  parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
  stringifySearch: (values) => {
    const params = new URLSearchParams();

    for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    const text = params.toString().replaceAll("%2F", "/");

    return text ? `?${text}` : "";
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const app = document.getElementById("app");

if (app) {
  createRoot(app).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

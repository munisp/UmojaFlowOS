import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { lazy, Suspense } from "react";
import { Redirect, Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import PublicLanding from "./pages/PublicLanding";

// Route-level code splitting (perf/slo.yaml mobile budget): the console and
// enrollment flows are heavy and must not block first paint of the landing
// page on 3G/4G. PublicLanding stays eager — it IS the first paint.
const Home = lazy(() => import("./pages/Home"));
const StakeholderOnboarding = lazy(() => import("./pages/StakeholderOnboarding"));

function Router() {
  // make sure to consider if you need authentication for certain routes
  return (
    <Switch>
      <Route path={"/"} component={PublicLanding} />
      <Route path={"/enroll"}>
        <Suspense fallback={null}>
          <StakeholderOnboarding />
        </Suspense>
      </Route>
      <Route path={"/console"}>
        <Suspense fallback={null}>
          <Home />
        </Suspense>
      </Route>
      <Route path={"/console/:module"}>
        <Suspense fallback={null}>
          <Home />
        </Suspense>
      </Route>
      {/* Bare module paths (e.g. bookmarked or shared links) redirect into the console shell */}
      {(["overview", "registry", "integrations", "governance", "treasury", "markets", "payments", "compliance", "reports", "alerts"] as const).map((module) => (
        <Route key={module} path={`/${module}`}>
          <Redirect to={module === "overview" ? "/console" : `/console/${module}`} />
        </Route>
      ))}
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="light"
        // switchable
      >
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;

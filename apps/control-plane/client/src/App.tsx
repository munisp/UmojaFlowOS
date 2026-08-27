import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import PublicLanding from "./pages/PublicLanding";
import StakeholderOnboarding from "./pages/StakeholderOnboarding";

function Router() {
  // make sure to consider if you need authentication for certain routes
  return (
    <Switch>
      <Route path={"/"} component={PublicLanding} />
      <Route path={"/enroll"} component={StakeholderOnboarding} />
      <Route path={"/console"} component={Home} />
      <Route path={"/console/:module"} component={Home} />
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

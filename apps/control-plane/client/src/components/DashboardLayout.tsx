import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { startLogin } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import {
  Activity,
  BellRing,
  Building2,
  ClipboardCheck,
  Landmark,
  LayoutDashboard,
  LineChart,
  LogOut,
  PanelLeft,
  ReceiptText,
  Scale,
  ShieldCheck,
  UserCog,
  Waypoints,
} from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from './DashboardLayoutSkeleton';
import { Button } from "./ui/button";
import type { OperatorRole } from "@/lib/roleCapabilities";

const menuItems = [
  { icon: LayoutDashboard, label: "Overview", path: "/console" },
  { icon: Waypoints, label: "Payments", path: "/console/payments" },
  { icon: Landmark, label: "Treasury", path: "/console/treasury" },
  { icon: LineChart, label: "FX & Stablecoins", path: "/console/markets" },
  { icon: ShieldCheck, label: "Compliance", path: "/console/compliance" },
  { icon: ReceiptText, label: "CBN · CBK · SARB", path: "/console/reports" },
  { icon: ClipboardCheck, label: "CBN Sandbox", path: "/console/sandbox" },
  { icon: Building2, label: "Counterparties", path: "/console/registry" },
  { icon: Activity, label: "Integrations", path: "/console/integrations" },
  { icon: Scale, label: "Governance", path: "/console/governance" },
  { icon: BellRing, label: "Alerts", path: "/console/alerts" },
  { icon: UserCog, label: "Admins", path: "/console/admins" },
];

const auditableModulePaths = menuItems.filter(item => item.path !== "/console/admins").map(item => item.path);

/**
 * Which modules a role sees in the sidebar, based on where that role can
 * actually act (roleCapabilities.ts / consoleActionVisibility.ts) rather than
 * an arbitrary cut. Auditor sees every operational module for the same
 * reason it always has here — oversight requires full visibility ("withholding
 * it from the roles who respond to incidents would be counterproductive") —
 * but not Admins: that page lists every account's name, email, and enabled
 * state, which is account-directory data, not business/compliance evidence.
 * Only admin (which can also act on it) sees it.
 */
const modulesByRole: Record<OperatorRole, string[] | null> = {
  admin: null,
  auditor: auditableModulePaths,
  compliance_officer: ["/console", "/console/compliance", "/console/reports", "/console/sandbox", "/console/registry", "/console/governance", "/console/alerts"],
  treasury_operator: ["/console", "/console/payments", "/console/treasury", "/console/markets", "/console/compliance", "/console/registry", "/console/integrations", "/console/alerts"],
  provider_contact: ["/console"],
  cbn_liaison: ["/console"],
};

const roleLabels: Record<OperatorRole, string> = {
  admin: "Admin",
  compliance_officer: "Compliance officer",
  treasury_operator: "Treasury operator",
  auditor: "Auditor",
  provider_contact: "Provider contact",
  cbn_liaison: "CBN liaison",
};

function visibleMenuItems(role: OperatorRole | undefined) {
  if (!role) return menuItems;
  const allowed = modulesByRole[role];
  if (!allowed) return menuItems;
  return menuItems.filter(item => allowed.includes(item.path));
}

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user, pendingIdentity } = useAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (loading) {
    return <DashboardLayoutSkeleton />
  }

  if (!user && pendingIdentity) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-8 p-8 max-w-md w-full">
          <div className="flex flex-col items-center gap-6">
            <h1 className="text-2xl font-semibold tracking-tight text-center">
              Waiting on access
            </h1>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              {pendingIdentity.name || pendingIdentity.email || "Your account"} is verified but has no operating role yet. An administrator can grant one from Governance &rsaquo; Operator access.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-8 p-8 max-w-md w-full">
          <div className="flex flex-col items-center gap-6">
            <h1 className="text-2xl font-semibold tracking-tight text-center">
              Sign in to continue
            </h1>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              Access to this dashboard requires authentication. Continue to launch the login flow.
            </p>
          </div>
          <Button
            onClick={() => startLogin()}
            size="lg"
            className="w-full shadow-lg hover:shadow-xl transition-all"
          >
            Sign in
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

type DashboardLayoutContentProps = {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
};

function DashboardLayoutContent({
  children,
  setSidebarWidth,
}: DashboardLayoutContentProps) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const items = visibleMenuItems(user?.role as OperatorRole | undefined);
  const activeMenuItem = items.find(item => item.path === location);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (isCollapsed) {
      setIsResizing(false);
    }
  }, [isCollapsed]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = e.clientX - sidebarLeft;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar
          collapsible="icon"
          className="border-r border-black/15 bg-white"
          disableTransition={isResizing}
        >
          <SidebarHeader className="h-20 justify-center border-b border-black/15">
            <div className="flex items-center gap-3 px-2 transition-all w-full">
              <button
                onClick={toggleSidebar}
                className="h-8 w-8 flex items-center justify-center hover:bg-accent rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                aria-label="Toggle navigation"
              >
                <PanelLeft className="h-4 w-4 text-muted-foreground" />
              </button>
              {!isCollapsed ? (
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-black tracking-[-0.07em] uppercase truncate">UmojaFlow</span>
                </div>
              ) : null}
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-0">
            <div className="px-4 pt-5 pb-2 text-[10px] font-bold tracking-[0.18em] text-black/40 uppercase group-data-[collapsible=icon]:hidden">Operations OS</div>
            <SidebarMenu className="px-2 py-1">
              {items.map(item => {
                const isActive = location === item.path;
                return (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => setLocation(item.path)}
                      tooltip={item.label}
                      className="h-10 rounded-none transition-all font-medium text-[13px] data-[active=true]:bg-[#e11919] data-[active=true]:text-white data-[active=true]:font-bold"
                    >
                      <item.icon
                          className={`h-4 w-4 ${isActive ? "text-white" : "text-black/60"}`}
                      />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarContent>

          <SidebarFooter className="border-t border-black/15 p-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-3 rounded-lg px-1 py-1 hover:bg-accent/50 transition-colors w-full text-left group-data-[collapsible=icon]:justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Avatar className="h-9 w-9 border border-black/20 shrink-0">
                    <AvatarFallback className="text-xs font-medium">
                      {user?.name?.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                    <p className="text-sm font-medium truncate leading-none">
                      {user?.name || "-"}
                    </p>
                    <p className="text-xs text-muted-foreground truncate mt-1.5">
                      {user?.email || "-"}
                    </p>
                    {user?.role ? (
                      <span className="mt-1.5 inline-block rounded-none bg-[#e11919] px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-white">
                        {roleLabels[user.role as OperatorRole] ?? user.role}
                      </span>
                    ) : null}
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>
        <div
          className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/20 transition-colors ${isCollapsed ? "hidden" : ""}`}
          onMouseDown={() => {
            if (isCollapsed) return;
            setIsResizing(true);
          }}
          style={{ zIndex: 50 }}
        />
      </div>

      <SidebarInset className="bg-[#f5f5f2]">
        {isMobile && (
          <div className="flex border-b h-14 items-center justify-between bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:backdrop-blur sticky top-0 z-40">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="h-9 w-9 rounded-lg bg-background" />
              <div className="flex items-center gap-3">
                <div className="flex flex-col gap-1">
                  <span className="tracking-tight text-foreground">
                    {activeMenuItem?.label ?? "Menu"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
        <main className="flex-1 p-0">{children}</main>
      </SidebarInset>
    </>
  );
}

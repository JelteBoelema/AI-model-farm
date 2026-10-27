import {
  Activity,
  BarChart3,
  CalendarDays,
  Coins,
  Cpu,
  Factory,
  Images,
  LayoutDashboard,
  Megaphone,
  ScrollText,
  Settings,
  Share2,
  Sparkles,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
  /** Implementation phase delivering the module's full functionality. */
  phase: number;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAVIGATION: NavGroup[] = [
  {
    label: "Operate",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard, description: "Farm-wide status, spend and activity", phase: 1 },
      { href: "/workflows", label: "Workflow Monitor", icon: Activity, description: "Queues, workers, jobs and failures", phase: 1 },
    ],
  },
  {
    label: "Create",
    items: [
      { href: "/creators", label: "Creators", icon: Users, description: "Virtual creators and their identity", phase: 2 },
      { href: "/characters", label: "Character Studio", icon: UserRound, description: "Visual identity and reference library", phase: 2 },
      { href: "/prompts", label: "Prompt Studio", icon: Sparkles, description: "Versioned templates and prompt tests", phase: 3 },
      { href: "/content", label: "Content Factory", icon: Factory, description: "Idea-to-publication pipeline", phase: 5 },
      { href: "/media", label: "Media Library", icon: Images, description: "Generated and uploaded assets", phase: 5 },
    ],
  },
  {
    label: "Distribute",
    items: [
      { href: "/calendar", label: "Content Calendar", icon: CalendarDays, description: "Scheduled publications", phase: 7 },
      { href: "/campaigns", label: "Campaigns", icon: Megaphone, description: "Campaign planning and budgets", phase: 7 },
      { href: "/social", label: "Social Accounts", icon: Share2, description: "Connected platform accounts", phase: 7 },
      { href: "/analytics", label: "Analytics", icon: BarChart3, description: "Measured platform results", phase: 9 },
    ],
  },
  {
    label: "Control",
    items: [
      { href: "/costs", label: "Costs & Budgets", icon: Coins, description: "Ledger, reservations and hard limits", phase: 5 },
      { href: "/providers", label: "AI Providers", icon: Cpu, description: "Provider registry and status", phase: 4 },
      { href: "/settings", label: "Settings & Audit", icon: Settings, description: "Users, kill switches and audit log", phase: 1 },
    ],
  },
];

export const NAV_ITEMS = NAVIGATION.flatMap((g) => g.items);
export const AUDIT_ICON = ScrollText;

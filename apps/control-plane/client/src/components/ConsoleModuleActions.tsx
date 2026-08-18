import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canOpenConsoleComposer, consoleModuleActions, type ComposerAction, type ConsoleModule } from "@/lib/consoleActionVisibility";
import type { OperatorRole } from "@/lib/roleCapabilities";

/**
 * Single rendering surface for module-level privileged actions. Home.tsx and the
 * role-visibility regressions both consume this component so what a role can see
 * is proven against the same rendered output rather than a parallel policy copy.
 */
export function ConsoleModuleActions({ role, module, disabledActions = [], onOpen }: { role: OperatorRole | undefined; module: ConsoleModule; disabledActions?: ComposerAction[]; onOpen: (action: ComposerAction) => void }) {
  const actions = consoleModuleActions[module].filter(({ action }) => canOpenConsoleComposer(role, action));
  if (!actions.length) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {actions.map(({ label, action }) => (
        <Button
          key={action}
          type="button"
          disabled={disabledActions.includes(action)}
          onClick={() => onOpen(action)}
          className="rounded-none bg-[#e11919] px-3 text-xs font-black uppercase tracking-wide text-white hover:bg-black"
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {label}
        </Button>
      ))}
    </div>
  );
}

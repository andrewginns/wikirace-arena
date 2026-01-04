import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";

type RaceSetupStickyBarProps = {
  startPage: string;
  targetPage: string;
  participantsCount: number;
  errorMessages: string[];
  hasDuplicateParticipants: boolean;
  isServerConnected: boolean;
  canStart: boolean;
  onStartRace: () => void;
};

export function RaceSetupStickyBar({
  startPage,
  targetPage,
  participantsCount,
  errorMessages,
  hasDuplicateParticipants,
  isServerConnected,
  canStart,
  onStartRace,
}: RaceSetupStickyBarProps) {
  const errorCount =
    errorMessages.length + (hasDuplicateParticipants ? 1 : 0);

  const helperText =
    errorMessages[0] ?? (hasDuplicateParticipants ? "Remove duplicate participants." : null);

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 md:hidden">
      <div className="border-t bg-background/80 shadow-[var(--shadow-floating)] backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto max-w-7xl px-3 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">
                {startPage} → {targetPage}
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="text-[11px]">
                  {participantsCount} participant{participantsCount === 1 ? "" : "s"}
                </Badge>

                {!isServerConnected && (
                  <StatusChip status="active">Server offline</StatusChip>
                )}

                {errorCount > 0 ? (
                  <StatusChip status="error">Errors: {errorCount}</StatusChip>
                ) : (
                  <StatusChip status="finished">Ready</StatusChip>
                )}
              </div>

              {helperText && (
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {helperText}
                </div>
              )}
            </div>

            <Button
              className="shrink-0"
              size="default"
              onClick={onStartRace}
              disabled={!canStart}
            >
              Start race
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}


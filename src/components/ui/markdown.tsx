import ReactMarkdown from "react-markdown";
import { cn } from "@/lib/utils";

export default function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div
      className={cn(
        "text-xs leading-relaxed text-foreground",
        "[&_p]:mb-2 [&_p:last-child]:mb-0",
        "[&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:space-y-1",
        "[&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:space-y-1",
        "[&_a]:underline [&_a]:underline-offset-2 [&_a]:text-primary",
        "[&_pre]:mt-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted/40 [&_pre]:p-2",
        "[&_code]:rounded [&_code]:bg-muted/40 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px]",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
        className
      )}
    >
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}


import { cn } from "@/lib/utils";
import type { ComponentProps, HTMLAttributes } from "react";
import { memo, useMemo } from "react";
import type { Streamdown } from "streamdown";
import { useMarkdown } from "@/lib/markdown";
import { MarkdownTable } from "@/components/portal/table-menu";
import { MarkdownCode } from "@/components/portal/code-fullscreen";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: "system" | "user" | "assistant";
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit max-w-full min-w-0 flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

// Portal: Streamdown loads as its own chunk (lib/markdown); until it's in, the text shows as is.
export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => {
    const markdown = useMarkdown();
    const components = useMemo(() => ({ table: MarkdownTable, code: MarkdownCode, ...props.components }), [props.components]);
    const classes = cn(
      "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
      className
    );
    if (!markdown) {
      return <div className={cn(classes, "whitespace-pre-wrap")}>{props.children}</div>;
    }
    return (
      <markdown.Streamdown className={classes} plugins={markdown.plugins} {...props} components={components} />
    );
  }
);

MessageResponse.displayName = "MessageResponse";
